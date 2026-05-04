// scheduler.js — Reminder-Ticker (alle 60s)
//
// Default DEAKTIVIERT (SCHEDULER_ENABLED!=true), damit V2 nicht
// gleiche Reminder doppelt feuert wie V1.
//
// Liest reminders WHERE done=0 AND due<=NOW, schickt via Telegram,
// markiert done (oneshot) oder reschedulet (recurring).

import * as db from "./db.js";
import * as telegram from "./telegram.js";

const ENABLED  = process.env.SCHEDULER_ENABLED === "true";
const TICK_MS  = Number(process.env.SCHEDULER_TICK_MS) || 60_000;
const MAX_FAILS = Number(process.env.SCHEDULER_MAX_FAILS) || 5;

let timer = null;

export function start() {
  if (!ENABLED) {
    console.log("[scheduler] disabled (SCHEDULER_ENABLED != true)");
    return;
  }
  console.log(`[scheduler] tick every ${TICK_MS / 1000}s`);
  timer = setInterval(tick, TICK_MS);
  // Erster Tick gleich (mit kleinem Delay damit DB sicher offen ist)
  setTimeout(tick, 2000);
}

export function stop() {
  if (timer) { clearInterval(timer); timer = null; console.log("[scheduler] stopped"); }
}

async function tick() {
  try {
    const due = db.get().prepare(`
      SELECT id, text, due, chat_id, type, interval_hours, fail_count
      FROM reminders
      WHERE done = 0 AND fail_count < ? AND datetime(due) <= datetime('now')
      ORDER BY due ASC
      LIMIT 10
    `).all(MAX_FAILS);

    if (!due.length) return;
    console.log(`[scheduler] ${due.length} due reminder(s)`);

    for (const r of due) {
      await fireReminder(r);
    }
  } catch (err) {
    console.error("[scheduler] tick error:", err);
  }
}

async function fireReminder(r) {
  console.log(`[scheduler] fire #${r.id} (${r.type || "oneshot"}): ${r.text.substring(0, 60)}`);

  try {
    if (r.chat_id) {
      await telegram.send(r.chat_id, `⏰ ${r.text}`);
    } else {
      console.warn(`[scheduler] reminder #${r.id} hat kein chat_id — nur als done markiert`);
    }

    if (r.type === "recurring" && r.interval_hours > 0) {
      const next = new Date(Date.now() + r.interval_hours * 3_600_000)
        .toISOString().replace("T", " ").substring(0, 19);
      db.get().prepare("UPDATE reminders SET due = ?, fail_count = 0 WHERE id = ?")
              .run(next, r.id);
      console.log(`[scheduler] #${r.id} rescheduled → ${next}`);
    } else {
      db.get().prepare("UPDATE reminders SET done = 1 WHERE id = ?").run(r.id);
    }

    db.logEvent({
      type: "reminder",
      message: `fired #${r.id}: ${r.text.substring(0, 100)}`,
      meta: { type: r.type, chat_id: r.chat_id }
    });
  } catch (err) {
    console.error(`[scheduler] reminder #${r.id} failed:`, err.message || err);
    db.get().prepare("UPDATE reminders SET fail_count = fail_count + 1 WHERE id = ?")
            .run(r.id);
    db.logEvent({
      type: "reminder-error",
      message: `failed #${r.id}: ${err.message || err}`,
      meta: { reminder_id: r.id }
    });
  }
}

export function getInfo() {
  if (!ENABLED) return { enabled: false };
  try {
    const upcoming = db.get().prepare(`
      SELECT id, text, due, chat_id, type
      FROM reminders WHERE done = 0
      ORDER BY due ASC LIMIT 5
    `).all();
    const overdue = db.get().prepare(`
      SELECT COUNT(*) c FROM reminders
      WHERE done = 0 AND datetime(due) <= datetime('now')
    `).get().c;
    return { enabled: true, started: !!timer, tick_ms: TICK_MS, upcoming, overdue };
  } catch (e) {
    return { enabled: true, started: !!timer, error: e.message };
  }
}
