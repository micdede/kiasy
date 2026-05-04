// mail-watcher.js — IMAP-Poller, schickt neue Mails als Telegram-Notification
// Default DEAKTIVIERT (MAIL_WATCHER_ENABLED!=true)

import { ImapFlow } from "imapflow";
import * as db from "./db.js";

const ENABLED  = process.env.MAIL_WATCHER_ENABLED === "true";
const INTERVAL = Number(process.env.MAIL_WATCHER_INTERVAL_MS) || 60_000;
const HOST = process.env.KERIO_HOST || "wrsk-mail.de";
const USER = process.env.KERIO_USER;
const PASS = process.env.KERIO_PASSWORD || process.env.KERIO_PASS;
const TG_TOKEN  = process.env.TELEGRAM_TOKEN;
const TG_CHATID = process.env.TELEGRAM_OWNER_CHAT_ID;
const STATE_KEY = "mail_watcher_last_uid";

let timer = null;

export function start() {
  if (!ENABLED) {
    console.log("[mail-watcher] disabled (MAIL_WATCHER_ENABLED != true)");
    return;
  }
  if (!USER || !PASS) {
    console.warn("[mail-watcher] KERIO_USER/PASSWORD fehlt — disabled");
    return;
  }
  console.log(`[mail-watcher] poll every ${INTERVAL/1000}s`);
  timer = setInterval(tick, INTERVAL);
  setTimeout(tick, 5000);
}

export function stop() {
  if (timer) { clearInterval(timer); timer = null; console.log("[mail-watcher] stopped"); }
}

async function tick() {
  let lastUid = getLastUid();

  const c = new ImapFlow({
    host: HOST, port: 993, secure: true,
    auth: { user: USER, pass: PASS },
    logger: false, tls: { rejectUnauthorized: false }
  });

  try {
    await c.connect();
    const lock = await c.getMailboxLock("INBOX");
    try {
      // Wenn noch keine baseline: nur den höchsten UID merken, nicht notifizieren
      if (!lastUid) {
        const highest = c.mailbox.uidNext - 1;
        setLastUid(highest);
        console.log(`[mail-watcher] baseline: UID=${highest}`);
        return;
      }

      const newSince = `${lastUid + 1}:*`;
      let highest = lastUid;
      for await (const msg of c.fetch(newSince, { envelope: true, uid: true, flags: true }, { uid: true })) {
        if (msg.uid <= lastUid) continue;
        highest = Math.max(highest, msg.uid);
        await notify(msg);
      }
      if (highest > lastUid) {
        setLastUid(highest);
        console.log(`[mail-watcher] processed up to UID=${highest}`);
      }
    } finally { lock.release(); }
  } catch (err) {
    console.error("[mail-watcher] error:", err.message);
  } finally {
    try { await c.logout(); } catch {}
  }
}

async function notify(msg) {
  if (!TG_TOKEN || !TG_CHATID) {
    console.log("[mail-watcher] new mail (no Telegram-config to notify):", msg.envelope.subject);
    return;
  }
  const text = `📧 Neue Mail\nVon: ${msg.envelope.from?.[0]?.address}\nBetreff: ${msg.envelope.subject}\nUID: ${msg.uid}`;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHATID, text })
    });
    db.logEvent({
      type: "mail-new",
      message: msg.envelope.subject || "(kein Betreff)",
      meta: { from: msg.envelope.from?.[0]?.address, uid: msg.uid }
    });
  } catch (err) {
    console.error("[mail-watcher] telegram notify failed:", err.message);
  }
}

function getLastUid() {
  try {
    const row = db.get().prepare("SELECT value FROM memory WHERE key = ? AND category='facts'").get(STATE_KEY);
    return row ? Number(row.value) : 0;
  } catch { return 0; }
}

function setLastUid(uid) {
  try {
    const conn = db.get();
    const exists = conn.prepare("SELECT id FROM memory WHERE key = ? AND category='facts'").get(STATE_KEY);
    if (exists) {
      conn.prepare("UPDATE memory SET value = ? WHERE id = ?").run(String(uid), exists.id);
    } else {
      conn.prepare("INSERT INTO memory(category, key, value, added) VALUES ('facts', ?, ?, date('now','localtime'))")
          .run(STATE_KEY, String(uid));
    }
  } catch (err) {
    console.error("[mail-watcher] state save failed:", err.message);
  }
}

export function getInfo() {
  return { enabled: ENABLED, started: !!timer, interval_ms: INTERVAL, last_uid: getLastUid() };
}
