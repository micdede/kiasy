const { ImapFlow } = require("imapflow");
const nodemailer = require("nodemailer");
const { getKerioConfig } = require("./kerio-config");

const definitions = [
  {
    name: "mail_list",
    description:
      "Listet die letzten E-Mails via IMAP auf. Optional nur ungelesene. Zeigt Betreff, Absender, Datum und UID.",
    input_schema: {
      type: "object",
      properties: {
        count: {
          type: "number",
          description: "Anzahl der Mails (Standard: 10, max 20)",
        },
        unread_only: {
          type: "boolean",
          description: "Nur ungelesene Mails anzeigen (Standard: false)",
        },
      },
      required: [],
    },
  },
  {
    name: "mail_read",
    description: "Liest den Inhalt einer einzelnen E-Mail anhand ihrer UID.",
    input_schema: {
      type: "object",
      properties: {
        uid: {
          type: "string",
          description: "Die UID der zu lesenden Mail",
        },
      },
      required: ["uid"],
    },
  },
  {
    name: "mail_send",
    description: "Sendet eine E-Mail über SMTP.",
    input_schema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Empfänger E-Mail-Adresse",
        },
        subject: {
          type: "string",
          description: "Betreff der Mail",
        },
        body: {
          type: "string",
          description: "Text-Inhalt der Mail",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
];

async function getImapClient() {
  const cfg = getKerioConfig();
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.imapPort,
    secure: true,
    auth: { user: cfg.user, pass: cfg.password },
    tls: { rejectUnauthorized: false },
    logger: false,
  });
  await client.connect();
  return client;
}

function extractText(source) {
  // Einfacher Text-Extraktor aus MIME-Source
  const text = source.toString("utf-8");

  // Versuche text/plain Abschnitt zu finden
  const plainMatch = text.match(
    /Content-Type:\s*text\/plain[^\r\n]*\r?\n(?:Content-Transfer-Encoding:\s*([^\r\n]*)\r?\n)?(?:[^\r\n]+\r?\n)*\r?\n([\s\S]*?)(?:\r?\n--|\r?\n\.\r?\n|$)/i
  );

  if (plainMatch) {
    let body = plainMatch[2];
    const encoding = (plainMatch[1] || "").trim().toLowerCase();

    if (encoding === "base64") {
      try {
        body = Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf-8");
      } catch {}
    } else if (encoding === "quoted-printable") {
      body = body
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9A-F]{2})/gi, (_, hex) =>
          String.fromCharCode(parseInt(hex, 16))
        );
    }
    return body.trim();
  }

  // Fallback: HTML-Part extrahieren und Tags strippen
  const htmlMatch = text.match(
    /Content-Type:\s*text\/html[^\r\n]*\r?\n(?:(?:Content-Transfer-Encoding:\s*([^\r\n]*)\r?\n)?)(?:[^\r\n]+\r?\n)*\r?\n([\s\S]*?)(?:\r?\n--|\r?\n\.\r?\n|$)/i
  );

  if (htmlMatch) {
    let body = htmlMatch[2];
    const encoding = (htmlMatch[1] || "").trim().toLowerCase();

    if (encoding === "base64") {
      try {
        body = Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf-8");
      } catch {}
    } else if (encoding === "quoted-printable") {
      body = body
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9A-F]{2})/gi, (_, hex) =>
          String.fromCharCode(parseInt(hex, 16))
        );
    }
    return body.replace(/<[^>]+>/g, "").trim();
  }

  // Letzter Fallback: Alles nach doppelter Leerzeile
  const headerEnd = text.indexOf("\r\n\r\n");
  if (headerEnd > -1) {
    return text
      .substring(headerEnd + 4)
      .replace(/<[^>]+>/g, "")
      .substring(0, 3000)
      .trim();
  }

  return "(Kein lesbarer Text-Inhalt)";
}

async function execute(name, input) {
  try {
    switch (name) {
      case "mail_list": {
        const count = Math.min(input.count || 10, 20);
        const client = await getImapClient();

        try {
          const lock = await client.getMailboxLock("INBOX");
          try {
            const messages = [];
            const searchCriteria = input.unread_only ? { seen: false } : "all";
            const uids = await client.search(searchCriteria, { uid: true });
            
            // Fix: client.search gibt manchmal false zurück statt Array
            const uidsArray = uids === false ? [] : (Array.isArray(uids) ? uids : []);

            if (uidsArray.length === 0) {
              return input.unread_only
                ? "Keine ungelesenen E-Mails."
                : "Keine E-Mails gefunden.";
            }

            // Letzte N UIDs nehmen
            const recentUids = uidsArray.slice(-count).reverse();

            for await (const msg of client.fetch(recentUids, {
              envelope: true,
              uid: true,
              flags: true,
            })) {
              const env = msg.envelope;
              const from = env.from && env.from[0]
                ? env.from[0].name || env.from[0].address
                : "(unbekannt)";
              const subject = env.subject || "(kein Betreff)";
              const date = env.date
                ? new Date(env.date).toLocaleString("de-DE", {
                    day: "2-digit",
                    month: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                    timeZone: "Europe/Berlin",
                  })
                : "";
              const isUnread = !msg.flags.has("\\Seen") ? "🔵 " : "";

              messages.push(
                `${isUnread}${date} | ${from}\n  📧 ${subject} [UID: ${msg.uid}]`
              );
            }

            return `📬 ${messages.length} E-Mails:\n${messages.join("\n\n")}`;
          } finally {
            lock.release();
          }
        } finally {
          await client.logout();
        }
      }

      case "mail_read": {
        const uid = parseInt(input.uid, 10);
        if (isNaN(uid)) return "❌ Ungültige UID.";

        const client = await getImapClient();

        try {
          const lock = await client.getMailboxLock("INBOX");
          try {
            const msg = await client.fetchOne(uid, {
              envelope: true,
              source: true,
            });

            const env = msg.envelope;
            const from = env.from && env.from[0]
              ? `${env.from[0].name || ""} <${env.from[0].address}>`.trim()
              : "(unbekannt)";
            const to = env.to && env.to[0]
              ? `${env.to[0].name || ""} <${env.to[0].address}>`.trim()
              : "(unbekannt)";
            const subject = env.subject || "(kein Betreff)";
            const date = env.date
              ? new Date(env.date).toLocaleString("de-DE", {
                  timeZone: "Europe/Berlin",
                })
              : "";

            const body = extractText(msg.source);
            const truncated =
              body.length > 3000
                ? body.substring(0, 3000) + "\n...(gekürzt)"
                : body;

            return `📧 ${subject}\nVon: ${from}\nAn: ${to}\nDatum: ${date}\n\n${truncated}`;
          } finally {
            lock.release();
          }
        } finally {
          await client.logout();
        }
      }

      case "mail_send": {
        const cfg = getKerioConfig();
        const transporter = nodemailer.createTransport({
          host: cfg.host,
          port: cfg.smtpPort,
          secure: false,
          auth: { user: cfg.user, pass: cfg.password },
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
        return "Unbekannte Mail-Operation.";
    }
  } catch (error) {
    return `❌ Mail-Fehler: ${error.message}`;
  }
}

module.exports = { definitions, execute, extractText };