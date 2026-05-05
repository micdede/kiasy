// mail.js — Kerio Mail (IMAP read + SMTP send)
// Konsolidiert kerio-mail + email aus V1.

import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import fs from "node:fs";

const HOST = process.env.KERIO_HOST || "wrsk-mail.de";
const SIG_FILE = "/data/mail-signature.txt";

function loadSignature() {
  // Priorität: Datei /data/mail-signature.txt → ENV MAIL_SIGNATURE (mit \n als literal)
  try {
    if (fs.existsSync(SIG_FILE)) {
      const s = fs.readFileSync(SIG_FILE, "utf8").trim();
      if (s) return s;
    }
  } catch {}
  const envSig = process.env.MAIL_SIGNATURE || "";
  return envSig.replace(/\\n/g, "\n").trim();
}
const USER = process.env.KERIO_USER;
const PASS = process.env.KERIO_PASSWORD || process.env.KERIO_PASS;
const FROM = process.env.KERIO_FROM || `${USER}@${HOST}`;
const ALLOWED_DOMAINS = (process.env.MAIL_ALLOWED_DOMAINS || "").split(",").map(d => d.trim()).filter(Boolean);
const WHITELIST       = (process.env.MAIL_WHITELIST       || "").split(",").map(d => d.trim()).filter(Boolean);

function imap() {
  if (!USER || !PASS) throw new Error("KERIO_USER/KERIO_PASSWORD nicht gesetzt");
  return new ImapFlow({
    host: HOST, port: 993, secure: true,
    auth: { user: USER, pass: PASS },
    logger: false, tls: { rejectUnauthorized: false }
  });
}

export const definitions = [
  {
    name: "mail_list",
    description: "Listet die letzten E-Mails (default 10, max 30). Optional folder + nur ungelesene.",
    input_schema: {
      type: "object",
      properties: {
        count:    { type: "integer", default: 10 },
        folder:   { type: "string", default: "INBOX" },
        unread:   { type: "boolean", default: false }
      }
    }
  },
  {
    name: "mail_read",
    description: "Liest eine E-Mail anhand UID + folder.",
    input_schema: {
      type: "object",
      properties: {
        uid:    { type: "integer" },
        folder: { type: "string", default: "INBOX" }
      },
      required: ["uid"]
    }
  },
  {
    name: "mail_send",
    description: `Schickt eine E-Mail. Empfänger müssen in MAIL_WHITELIST sein${ALLOWED_DOMAINS.length ? ` oder in einer der erlaubten Domains: ${ALLOWED_DOMAINS.join(", ")}` : ""}.`,
    input_schema: {
      type: "object",
      properties: {
        to:      { type: "string", description: "E-Mail-Adresse" },
        subject: { type: "string" },
        body:    { type: "string", description: "Plain Text" }
      },
      required: ["to", "subject", "body"]
    }
  }
];

function checkRecipient(to) {
  if (WHITELIST.length === 0 && ALLOWED_DOMAINS.length === 0) return; // keine Restriktion
  if (WHITELIST.includes(to)) return;
  const dom = to.split("@")[1];
  if (dom && ALLOWED_DOMAINS.includes(dom)) return;
  throw new Error(`Empfänger ${to} nicht erlaubt (weder in WHITELIST noch in ALLOWED_DOMAINS)`);
}

export async function execute(name, input) {
  if (name === "mail_list") {
    const c = imap();
    await c.connect();
    try {
      const folder = input?.folder || "INBOX";
      const lock = await c.getMailboxLock(folder);
      try {
        const mailbox = c.mailbox;
        const count = Math.min(input?.count || 10, 30);
        const seq = `${Math.max(1, mailbox.exists - count + 1)}:*`;
        const items = [];
        for await (const msg of c.fetch(seq, { envelope: true, uid: true, flags: true })) {
          if (input?.unread && !msg.flags?.has("\\Seen") === false) continue;
          if (input?.unread && msg.flags?.has("\\Seen")) continue;
          items.push({
            uid: msg.uid,
            from: msg.envelope.from?.[0]?.address,
            subject: msg.envelope.subject,
            date: msg.envelope.date,
            unread: !msg.flags?.has("\\Seen")
          });
        }
        return { folder, count: items.length, items: items.reverse() };
      } finally { lock.release(); }
    } finally { await c.logout(); }
  }

  if (name === "mail_read") {
    const c = imap();
    await c.connect();
    try {
      const folder = input?.folder || "INBOX";
      const lock = await c.getMailboxLock(folder);
      try {
        const msg = await c.fetchOne(input.uid, { source: true, envelope: true }, { uid: true });
        if (!msg) throw new Error(`UID ${input.uid} nicht gefunden`);
        const text = msg.source?.toString("utf8") || "";
        // Body extrahieren — sehr simple Variante
        const bodyStart = text.indexOf("\r\n\r\n");
        const body = bodyStart > -1 ? text.substring(bodyStart + 4, bodyStart + 5000) : text.substring(0, 5000);
        return {
          uid: input.uid,
          from: msg.envelope.from?.[0]?.address,
          to:   msg.envelope.to?.[0]?.address,
          subject: msg.envelope.subject,
          date: msg.envelope.date,
          body
        };
      } finally { lock.release(); }
    } finally { await c.logout(); }
  }

  if (name === "mail_send") {
    checkRecipient(input.to);
    const transport = nodemailer.createTransport({
      host: HOST, port: 465, secure: true,
      auth: { user: USER, pass: PASS },
      tls: { rejectUnauthorized: false }
    });
    const sig = loadSignature();
    const bodyWithSig = sig ? `${input.body.trimEnd()}\n\n-- \n${sig}\n` : input.body;
    const info = await transport.sendMail({
      from: FROM, to: input.to, subject: input.subject, text: bodyWithSig
    });
    return { sent: true, messageId: info.messageId, accepted: info.accepted, signature_used: !!sig };
  }

  throw new Error(`unknown: ${name}`);
}
