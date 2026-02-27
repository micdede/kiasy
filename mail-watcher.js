// Mail-Watcher: JARVIS überwacht sein Postfach und verarbeitet eingehende Mails
const { ImapFlow } = require("imapflow");
const nodemailer = require("nodemailer");
const { getKerioConfig } = require("./tools/kerio-config");
const { extractText } = require("./tools/kerio-mail");

const POLL_INTERVAL = 60000; // 60 Sekunden
let isProcessing = false;

function startMailWatcher(agent) {
  console.log("Mail-Watcher gestartet (60s Intervall)");
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
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      if (uids.length === 0) return;

      console.log(`  Mail-Watcher: ${uids.length} ungelesene Mail(s)`);

      // Mails lesen und SOFORT als gelesen markieren (verhindert Doppelverarbeitung)
      for (const uid of uids) {
        try {
          const msg = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
          if (!msg || !msg.envelope) {
            console.log(`  Mail-Watcher: UID ${uid} nicht lesbar, übersprungen`);
            continue;
          }
          // Sofort als gelesen markieren
          await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
          mailsToProcess.push({ envelope: msg.envelope, source: msg.source });
        } catch (err) {
          console.error(`  Mail-Watcher: Fehler bei UID ${uid}:`, err.message);
        }
      }
    } finally {
      lock.release();
    }

    // IMAP-Verbindung schließen bevor Agent aufgerufen wird (dauert lange)
    try { await client.logout(); } catch {}
    client = null;

    // Jetzt Mails verarbeiten (ohne offene IMAP-Verbindung)
    for (const mail of mailsToProcess) {
      await processEmail(agent, mail.envelope, mail.source);
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

async function processEmail(agent, envelope, source) {
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

  console.log(`  Mail-Watcher: Verarbeite Mail von ${fromAddr}: "${subject}"`);

  // Agent aufrufen mit eigenem Konversationskontext pro Absender
  const chatId = `mail-${fromAddr}`;
  const prompt = `Betreff: ${subject}\n\n${body}`;

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

async function sendReply(to, subject, messageId, body) {
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
