const { ImapFlow } = require("imapflow");
const nodemailer = require("nodemailer");
const { getKerioConfig } = require("./kerio-config");

const definitions = [
  {
    name: "mail_folders",
    description:
      "Listet alle verfügbaren IMAP-Ordner auf, inkl. freigegebener Postfächer. Zeigt Name, Pfad, Anzahl Nachrichten und ungelesene.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "mail_list",
    description:
      "Listet die letzten E-Mails via IMAP auf. Optional nur ungelesene. Zeigt Betreff, Absender, Datum und UID. Mit folder-Parameter auch freigegebene Postfächer lesbar.",
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
        folder: {
          type: "string",
          description:
            'IMAP-Ordner (Standard: "INBOX"). Für freigegebene Postfächer z.B. "~user@domain/INBOX". Ordner mit mail_folders auflisten.',
        },
      },
      required: [],
    },
  },
  {
    name: "mail_read",
    description:
      "Liest den Inhalt einer einzelnen E-Mail anhand ihrer UID. Mit folder-Parameter auch aus freigegebenen Postfächern.",
    input_schema: {
      type: "object",
      properties: {
        uid: {
          type: "string",
          description: "Die UID der zu lesenden Mail",
        },
        folder: {
          type: "string",
          description:
            'IMAP-Ordner (Standard: "INBOX"). Für freigegebene Postfächer z.B. "~user@domain/INBOX".',
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
      case "mail_folders": {
        const client = await getImapClient();
        try {
          const folders = await client.list();
          const lines = [];
          for (const folder of folders) {
            // Ordner-Status abrufen für Nachrichten-Anzahl
            try {
              const status = await client.status(folder.path, {
                messages: true,
                unseen: true,
              });
              const unread = status.unseen > 0 ? ` (${status.unseen} ungelesen)` : "";
              lines.push(`📁 ${folder.path} — ${status.messages} Nachrichten${unread}`);
            } catch {
              // Manche Ordner sind nicht selektierbar (z.B. \Noselect)
              lines.push(`📁 ${folder.path} (nicht lesbar)`);
            }
          }
          return `📂 ${lines.length} Ordner gefunden:\n\n${lines.join("\n")}`;
        } finally {
          await client.logout();
        }
      }

      case "mail_list": {
        const count = Math.min(input.count || 10, 20);
        const folder = input.folder || "INBOX";
        const client = await getImapClient();

        try {
          const lock = await client.getMailboxLock(folder);
          try {
            const messages = [];

            let recentUids;
            if (input.unread_only) {
              const uids = await client.search({ seen: false }, { uid: true });
              const uidsArray = uids === false ? [] : (Array.isArray(uids) ? uids : []);
              if (uidsArray.length === 0) return "Keine ungelesenen E-Mails.";
              recentUids = uidsArray.slice(-count).reverse();
            } else {
              // search('all') kann bei großen/shared Mailboxen false zurückgeben
              // Fallback: Sequence-basierter Fetch der letzten N Mails
              const uids = await client.search("all", { uid: true });
              const uidsArray = uids === false ? [] : (Array.isArray(uids) ? uids : []);
              if (uidsArray.length > 0) {
                recentUids = uidsArray.slice(-count).reverse();
              } else {
                // Fallback: letzte N per Sequence-Nummer
                const total = client.mailbox.exists;
                if (!total || total === 0) return "Keine E-Mails gefunden.";
                const from = Math.max(1, total - count + 1);
                recentUids = `${from}:*`;
              }
            }

            const isUidRange = Array.isArray(recentUids);
            for await (const msg of client.fetch(
              recentUids,
              { envelope: true, uid: true, flags: true },
              isUidRange ? { uid: true } : {}
            )) {
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
                    timeZone: process.env.TZ || "Europe/Berlin",
                  })
                : "";
              const isUnread = !msg.flags.has("\\Seen") ? "🔵 " : "";

              messages.push(
                `${isUnread}${date} | ${from}\n  📧 ${subject} [UID: ${msg.uid}]`
              );
            }

            const folderInfo = folder !== "INBOX" ? ` (${folder})` : "";
            return `📬 ${messages.length} E-Mails${folderInfo}:\n${messages.join("\n\n")}`;
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
        const folder = input.folder || "INBOX";

        const client = await getImapClient();

        try {
          const lock = await client.getMailboxLock(folder);
          try {
            const msg = await client.fetchOne(uid, {
              envelope: true,
              source: true,
            }, { uid: true });

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
                  timeZone: process.env.TZ || "Europe/Berlin",
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
        // Empfänger-Validierung: nur erlaubte Domains und Whitelist-Adressen
        const allowedDomains = (process.env.MAIL_ALLOWED_DOMAINS || "")
          .split(",").map(d => d.trim().toLowerCase()).filter(Boolean);
        const whitelist = (process.env.MAIL_WHITELIST || "")
          .split(",").map(e => e.trim().toLowerCase()).filter(Boolean);

        const recipient = input.to.trim().toLowerCase();
        const recipientDomain = recipient.split("@")[1] || "";

        const domainAllowed = allowedDomains.includes(recipientDomain);
        const whitelistAllowed = whitelist.includes(recipient);

        if (!domainAllowed && !whitelistAllowed) {
          return `❌ Senden an ${input.to} nicht erlaubt. Nur Adressen der Domains [${allowedDomains.join(", ") || "keine"}] oder Whitelist-Adressen sind freigegeben.`;
        }

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