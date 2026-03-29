// Mail-Watcher: JARVIS überwacht sein Postfach und verarbeitet eingehende Mails
const { ImapFlow } = require("imapflow");
const nodemailer = require("nodemailer");
const { getKerioConfig } = require("./tools/kerio-config");
const { extractText } = require("./tools/kerio-mail");

const POLL_INTERVAL = 60000; // 60 Sekunden
let isProcessing = false;

function getWatchFolders() {
  const env = process.env.MAIL_WATCH_FOLDERS;
  if (!env || !env.trim()) return ["INBOX"];
  return env.split(",").map((f) => f.trim()).filter(Boolean);
}

function startMailWatcher(agent) {
  const folders = getWatchFolders();
  console.log(`Mail-Watcher gestartet (60s Intervall, Ordner: ${folders.join(", ")})`);
  checkNewMails(agent);
  setInterval(() => checkNewMails(agent), POLL_INTERVAL);
}

async function checkNewMails(agent) {
  if (isProcessing) return;
  isProcessing = true;
  let client;
  try {
    const cfg = getKerioConfig();
    client = new ImapFlow({
      host: cfg.host,
      port: cfg.imapPort,
      secure: true,
      auth: { user: cfg.user, pass: cfg.password },
      tls: { rejectUnauthorized: false },
      logger: false,
    });
    await client.connect();

    const mailsToProcess = [];
    const folders = getWatchFolders();

    for (const folder of folders) {
      try {
        const lock = await client.getMailboxLock(folder);
        try {
          const uids = await client.search({ seen: false }, { uid: true });
          if (!uids || uids.length === 0) continue;

          console.log(`  Mail-Watcher [${folder}]: ${uids.length} ungelesene Mail(s)`);

          for (const uid of uids) {
            try {
              const msg = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
              if (!msg || !msg.envelope) {
                console.log(`  Mail-Watcher [${folder}]: UID ${uid} nicht lesbar, übersprungen`);
                continue;
              }
              await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
              mailsToProcess.push({ envelope: msg.envelope, source: msg.source, folder });
            } catch (err) {
              console.error(`  Mail-Watcher [${folder}]: Fehler bei UID ${uid}:`, err.message);
            }
          }
        } finally {
          lock.release();
        }
      } catch (err) {
        console.error(`  Mail-Watcher: Ordner "${folder}" nicht zugreifbar:`, err.message);
      }
    }

    // IMAP-Verbindung schließen bevor Agent aufgerufen wird (dauert lange)
    try { await client.logout(); } catch {}
    client = null;

    // Jetzt Mails verarbeiten (ohne offene IMAP-Verbindung)
    for (const mail of mailsToProcess) {
      await processEmail(agent, mail.envelope, mail.source, mail.folder);
    }
  } catch (err) {
    console.error("Mail-Watcher Fehler:", err.message);
  } finally {
    if (client) {
      try { await client.logout(); } catch {}
    }
    isProcessing = false;
  }
}

async function processEmail(agent, envelope, source, folder = "INBOX") {
  const cfg = getKerioConfig();

  // Absender ermitteln
  const fromAddr = envelope.from && envelope.from[0]
    ? envelope.from[0].address
    : null;

  if (!fromAddr) {
    console.log("  Mail-Watcher: Mail ohne Absender übersprungen");
    return;
  }

  // Eigene Mails ignorieren
  if (fromAddr.toLowerCase().includes(cfg.user.toLowerCase())) {
    return;
  }

  const subject = envelope.subject || "(kein Betreff)";
  const messageId = envelope.messageId || null;
  const body = extractText(source);

  const folderInfo = folder !== "INBOX" ? ` [${folder}]` : "";

  // Support-Mails: Absender = SUPPORT_EMAIL → als Admin-Befehl verarbeiten
  const supportEmail = (process.env.SUPPORT_EMAIL || "").trim().toLowerCase();
  const isSupportMail = supportEmail && fromAddr.toLowerCase() === supportEmail;

  if (isSupportMail) {
    console.log(`  Mail-Watcher: Support-Mail von ${fromAddr}: "${subject}"`);
  } else {
    console.log(`  Mail-Watcher${folderInfo}: Verarbeite Mail von ${fromAddr}: "${subject}"`);
  }

  // Agent aufrufen mit eigenem Konversationskontext pro Absender
  const chatId = isSupportMail ? "support-remote" : `mail-${fromAddr}`;
  const prompt = isSupportMail
    ? `[SUPPORT-REMOTE] Der Support-Admin sendet folgenden Befehl per Mail. Führe ihn aus und antworte mit dem Ergebnis.\n\nBetreff: ${subject}\n\n${body}`
    : `Betreff: ${subject}\n\n${body}`;

  try {
    const { text } = await agent.handleMessage(chatId, prompt);

    // Reply senden
    const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
    await sendReply(fromAddr, replySubject, messageId, text || "(keine Antwort)");

    console.log(`  Mail-Watcher: Reply gesendet an ${fromAddr}`);
  } catch (err) {
    console.error(`  Mail-Watcher: Agent-Fehler für ${fromAddr}:`, err.message);
  }
}

function isRecipientAllowed(email) {
  const allowedDomains = (process.env.MAIL_ALLOWED_DOMAINS || "")
    .split(",").map(d => d.trim().toLowerCase()).filter(Boolean);
  const whitelist = (process.env.MAIL_WHITELIST || "")
    .split(",").map(e => e.trim().toLowerCase()).filter(Boolean);

  const addr = email.trim().toLowerCase();
  const domain = addr.split("@")[1] || "";

  return allowedDomains.includes(domain) || whitelist.includes(addr);
}

async function sendReply(to, subject, messageId, body) {
  if (!isRecipientAllowed(to)) {
    console.log(`  Mail-Watcher: Reply an ${to} blockiert (nicht in erlaubten Domains/Whitelist)`);
    return;
  }

  const cfg = getKerioConfig();
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.smtpPort,
    secure: false,
    auth: { user: cfg.user, pass: cfg.password },
    tls: { rejectUnauthorized: false },
  });

  const mailOptions = {
    from: cfg.from,
    to,
    subject,
    text: body,
  };

  if (messageId) {
    mailOptions.inReplyTo = messageId;
    mailOptions.references = messageId;
  }

  await transporter.sendMail(mailOptions);
}

module.exports = { startMailWatcher };
