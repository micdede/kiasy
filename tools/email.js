// Standard E-Mail Tool (IMAP/SMTP) — funktioniert mit Gmail, Outlook, Yahoo, etc.
// Berechtigungen über .env: EMAIL_MODE, EMAIL_MARK_READ, EMAIL_ALLOWED_DOMAINS, EMAIL_WHITELIST
const { ImapFlow } = require("imapflow");
const nodemailer = require("nodemailer");

// --- Konfiguration ---

function getConfig() {
  const host = process.env.EMAIL_HOST;
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASSWORD;
  if (!host || !user || !pass) throw new Error("E-Mail nicht konfiguriert. Setze EMAIL_HOST, EMAIL_USER und EMAIL_PASSWORD in .env");
  return {
    imap: {
      host: process.env.EMAIL_IMAP_HOST || host,
      port: parseInt(process.env.EMAIL_IMAP_PORT) || 993,
    },
    smtp: {
      host: process.env.EMAIL_SMTP_HOST || (host.replace(/^imap\./, "smtp.")),
      port: parseInt(process.env.EMAIL_SMTP_PORT) || 587,
      secure: (process.env.EMAIL_SMTP_PORT || "587") === "465",
    },
    user,
    pass,
    from: process.env.EMAIL_FROM || user,
    mode: (process.env.EMAIL_MODE || "read").toLowerCase(),
    markRead: (process.env.EMAIL_MARK_READ || "false").toLowerCase() === "true",
  };
}

// --- Berechtigungsprüfungen ---

function canSend() {
  return getConfig().mode === "readwrite";
}

function canMarkRead() {
  return getConfig().markRead === true;
}

function checkRecipient(to) {
  const allowedDomains = (process.env.EMAIL_ALLOWED_DOMAINS || "")
    .split(",").map(d => d.trim().toLowerCase()).filter(Boolean);
  const whitelist = (process.env.EMAIL_WHITELIST || "")
    .split(",").map(e => e.trim().toLowerCase()).filter(Boolean);

  const recipient = to.trim().toLowerCase();
  const domain = recipient.split("@")[1] || "";

  if (allowedDomains.length === 0 && whitelist.length === 0) {
    return "Senden blockiert: EMAIL_ALLOWED_DOMAINS oder EMAIL_WHITELIST muss in .env gesetzt sein.";
  }
  if (!allowedDomains.includes(domain) && !whitelist.includes(recipient)) {
    return `Senden an ${to} nicht erlaubt. Erlaubte Domains: [${allowedDomains.join(", ") || "keine"}], Whitelist: [${whitelist.join(", ") || "keine"}]`;
  }
  return null; // OK
}

// --- IMAP Client ---

async function getImapClient() {
  const cfg = getConfig();
  const client = new ImapFlow({
    host: cfg.imap.host,
    port: cfg.imap.port,
    secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    tls: { rejectUnauthorized: false },
    logger: false,
  });
  await client.connect();
  return client;
}

// --- Text-Extraktor (aus MIME-Source) ---

function extractText(source) {
  const text = source.toString("utf-8");

  const plainMatch = text.match(
    /Content-Type:\s*text\/plain[^\r\n]*\r?\n(?:Content-Transfer-Encoding:\s*([^\r\n]*)\r?\n)?(?:[^\r\n]+\r?\n)*\r?\n([\s\S]*?)(?:\r?\n--|\r?\n\.\r?\n|$)/i
  );

  if (plainMatch) {
    let body = plainMatch[2];
    const encoding = (plainMatch[1] || "").trim().toLowerCase();
    if (encoding === "base64") {
      try { body = Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf-8"); } catch {}
    } else if (encoding === "quoted-printable") {
      body = body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    }
    return body.trim();
  }

  const htmlMatch = text.match(
    /Content-Type:\s*text\/html[^\r\n]*\r?\n(?:Content-Transfer-Encoding:\s*([^\r\n]*)\r?\n)?(?:[^\r\n]+\r?\n)*\r?\n([\s\S]*?)(?:\r?\n--|\r?\n\.\r?\n|$)/i
  );

  if (htmlMatch) {
    let body = htmlMatch[2];
    const encoding = (htmlMatch[1] || "").trim().toLowerCase();
    if (encoding === "base64") {
      try { body = Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf-8"); } catch {}
    } else if (encoding === "quoted-printable") {
      body = body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    }
    return body.replace(/<[^>]+>/g, "").trim();
  }

  const headerEnd = text.indexOf("\r\n\r\n");
  if (headerEnd > -1) {
    return text.substring(headerEnd + 4).replace(/<[^>]+>/g, "").substring(0, 3000).trim();
  }
  return "(Kein lesbarer Text-Inhalt)";
}

// --- Tool-Definitionen ---

const modeInfo = () => {
  const mode = (process.env.EMAIL_MODE || "read").toLowerCase();
  const markRead = (process.env.EMAIL_MARK_READ || "false").toLowerCase() === "true";
  const parts = ["Lesen"];
  if (markRead) parts.push("als gelesen markieren");
  if (mode === "readwrite") parts.push("senden (nur an Whitelist)");
  return parts.join(", ");
};

const definitions = [
  {
    name: "email_list",
    description: "Listet die letzten E-Mails aus dem Posteingang auf. Zeigt Betreff, Absender, Datum und UID.",
    input_schema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Anzahl der Mails (Standard: 10, max 20)" },
        unread_only: { type: "boolean", description: "Nur ungelesene Mails (Standard: false)" },
        folder: { type: "string", description: 'IMAP-Ordner (Standard: "INBOX")' },
      },
    },
  },
  {
    name: "email_read",
    description: "Liest den Inhalt einer E-Mail anhand ihrer UID.",
    input_schema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "Die UID der zu lesenden Mail" },
        folder: { type: "string", description: 'IMAP-Ordner (Standard: "INBOX")' },
      },
      required: ["uid"],
    },
  },
  {
    name: "email_mark_read",
    description: "Markiert eine E-Mail als gelesen. Braucht EMAIL_MARK_READ=true in .env.",
    input_schema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "Die UID der Mail" },
        folder: { type: "string", description: 'IMAP-Ordner (Standard: "INBOX")' },
      },
      required: ["uid"],
    },
  },
  {
    name: "email_send",
    description: "Sendet eine E-Mail. Braucht EMAIL_MODE=readwrite + EMAIL_ALLOWED_DOMAINS in .env.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Empfänger E-Mail-Adresse" },
        subject: { type: "string", description: "Betreff" },
        body: { type: "string", description: "Text-Inhalt" },
      },
      required: ["to", "subject", "body"],
    },
  },
];

// --- Ausführung ---

async function execute(name, input) {
  try {
    switch (name) {
      case "email_list": {
        const count = Math.min(input.count || 10, 20);
        const folder = input.folder || "INBOX";
        const client = await getImapClient();

        try {
          const lock = await client.getMailboxLock(folder);
          try {
            let recentUids;
            if (input.unread_only) {
              const uids = await client.search({ seen: false }, { uid: true });
              const arr = uids === false ? [] : (Array.isArray(uids) ? uids : []);
              if (arr.length === 0) return "Keine ungelesenen E-Mails.";
              recentUids = arr.slice(-count).reverse();
            } else {
              const uids = await client.search("all", { uid: true });
              const arr = uids === false ? [] : (Array.isArray(uids) ? uids : []);
              if (arr.length > 0) {
                recentUids = arr.slice(-count).reverse();
              } else {
                const total = client.mailbox.exists;
                if (!total || total === 0) return "Keine E-Mails gefunden.";
                const from = Math.max(1, total - count + 1);
                recentUids = `${from}:*`;
              }
            }

            const messages = [];
            const isUidRange = Array.isArray(recentUids);
            for await (const msg of client.fetch(
              recentUids,
              { envelope: true, uid: true, flags: true },
              isUidRange ? { uid: true } : {}
            )) {
              const env = msg.envelope;
              const from = env.from?.[0]?.name || env.from?.[0]?.address || "(unbekannt)";
              const subject = env.subject || "(kein Betreff)";
              const date = env.date ? new Date(env.date).toLocaleString("de-DE", {
                day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
                timeZone: process.env.TZ || "Europe/Berlin",
              }) : "";
              const unread = !msg.flags.has("\\Seen") ? "🔵 " : "";
              messages.push(`${unread}${date} | ${from}\n  📧 ${subject} [UID: ${msg.uid}]`);
            }

            return `📬 ${messages.length} E-Mails${folder !== "INBOX" ? ` (${folder})` : ""}:\n${messages.join("\n\n")}`;
          } finally { lock.release(); }
        } finally { await client.logout(); }
      }

      case "email_read": {
        const uid = parseInt(input.uid, 10);
        if (isNaN(uid)) return "❌ Ungültige UID.";
        const folder = input.folder || "INBOX";
        const client = await getImapClient();

        try {
          const lock = await client.getMailboxLock(folder);
          try {
            const msg = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
            const env = msg.envelope;
            const from = env.from?.[0] ? `${env.from[0].name || ""} <${env.from[0].address}>`.trim() : "(unbekannt)";
            const to = env.to?.[0] ? `${env.to[0].name || ""} <${env.to[0].address}>`.trim() : "(unbekannt)";
            const subject = env.subject || "(kein Betreff)";
            const date = env.date ? new Date(env.date).toLocaleString("de-DE", {
              timeZone: process.env.TZ || "Europe/Berlin",
            }) : "";
            const body = extractText(msg.source);
            const truncated = body.length > 3000 ? body.substring(0, 3000) + "\n...(gekürzt)" : body;
            return `📧 ${subject}\nVon: ${from}\nAn: ${to}\nDatum: ${date}\n\n${truncated}`;
          } finally { lock.release(); }
        } finally { await client.logout(); }
      }

      case "email_mark_read": {
        if (!canMarkRead()) {
          return "❌ Nicht erlaubt. Setze EMAIL_MARK_READ=true in .env um Mails als gelesen zu markieren.";
        }
        const uid = parseInt(input.uid, 10);
        if (isNaN(uid)) return "❌ Ungültige UID.";
        const folder = input.folder || "INBOX";
        const client = await getImapClient();

        try {
          const lock = await client.getMailboxLock(folder);
          try {
            await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
            return `✅ Mail UID ${uid} als gelesen markiert.`;
          } finally { lock.release(); }
        } finally { await client.logout(); }
      }

      case "email_send": {
        if (!canSend()) {
          return "❌ Senden nicht erlaubt. Setze EMAIL_MODE=readwrite in .env";
        }
        const recipientCheck = checkRecipient(input.to);
        if (recipientCheck) return `❌ ${recipientCheck}`;

        const cfg = getConfig();
        const transporter = nodemailer.createTransport({
          host: cfg.smtp.host,
          port: cfg.smtp.port,
          secure: cfg.smtp.secure,
          auth: { user: cfg.user, pass: cfg.pass },
          tls: { rejectUnauthorized: false },
        });

        await transporter.sendMail({
          from: cfg.from,
          to: input.to,
          subject: input.subject,
          text: input.body,
        });

        return `✅ Mail gesendet an ${input.to}: "${input.subject}"`;
      }

      default:
        return "Unbekannte E-Mail-Operation.";
    }
  } catch (error) {
    return `❌ E-Mail-Fehler: ${error.message}`;
  }
}

module.exports = { definitions, execute };
