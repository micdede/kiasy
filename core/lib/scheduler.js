// scheduler.js — Reminder + Workflow-Step Ticker (alle 60s)

import * as db       from "./db.js";
import * as telegram from "./telegram.js";
import * as apns     from "./apns.js";
import * as agent    from "./agent.js";

const ENABLED   = process.env.SCHEDULER_ENABLED === "true";
const TICK_MS   = Number(process.env.SCHEDULER_TICK_MS) || 60_000;
const MAX_FAILS = Number(process.env.SCHEDULER_MAX_FAILS) || 5;

let timer = null;

export function start() {
  if (!ENABLED) {
    console.log("[scheduler] disabled (SCHEDULER_ENABLED != true)");
    return;
  }
  console.log(`[scheduler] tick every ${TICK_MS / 1000}s`);
  timer = setInterval(tick, TICK_MS);
  setTimeout(tick, 2000);
}

export function stop() {
  if (timer) { clearInterval(timer); timer = null; console.log("[scheduler] stopped"); }
}

async function tick() {
  try { await tickReminders(); }  catch (e) { console.error("[scheduler] reminder tick error:", e); }
  try { await tickWorkflows(); }  catch (e) { console.error("[scheduler] workflow tick error:", e); }
}

// ─── Reminders ───────────────────────────────────────────────

async function tickReminders() {
  const due = db.get().prepare(`
    SELECT id, text, due, chat_id, type, interval_hours, fail_count
    FROM reminders
    WHERE done = 0 AND fail_count < ? AND datetime(due) <= datetime('now')
    ORDER BY due ASC LIMIT 10
  `).all(MAX_FAILS);

  for (const r of due) await fireReminder(r);
}

async function fireReminder(r) {
  console.log(`[scheduler] fire #${r.id} (${r.type || "oneshot"}): ${r.text.substring(0, 60)}`);
  try {
    if (r.chat_id) {
      await telegram.send(r.chat_id, `⏰ ${r.text}`);
    } else {
      console.warn(`[scheduler] reminder #${r.id} hat kein chat_id — nur als done markiert`);
    }

    if (apns.isConfigured()) {
      const tokens = db.get().prepare("SELECT token FROM apns_tokens").all();
      for (const { token } of tokens) {
        apns.send(token, "JARVIS Erinnerung", r.text)
          .catch(err => console.warn(`[apns] push failed (${token.substring(0, 8)}…):`, err.message));
      }
    }

    if (r.type === "recurring" && r.interval_hours > 0) {
      const next = new Date(Date.now() + r.interval_hours * 3_600_000)
        .toISOString().replace("T", " ").substring(0, 19);
      db.get().prepare("UPDATE reminders SET due = ?, fail_count = 0 WHERE id = ?").run(next, r.id);
      console.log(`[scheduler] #${r.id} rescheduled → ${next}`);
    } else {
      db.get().prepare("UPDATE reminders SET done = 1 WHERE id = ?").run(r.id);
    }
    db.logEvent({ type: "reminder", message: `fired #${r.id}: ${r.text.substring(0, 100)}`, meta: { type: r.type, chat_id: r.chat_id } });
  } catch (err) {
    console.error(`[scheduler] reminder #${r.id} failed:`, err.message || err);
    db.get().prepare("UPDATE reminders SET fail_count = fail_count + 1 WHERE id = ?").run(r.id);
    db.logEvent({ type: "reminder-error", message: `failed #${r.id}: ${err.message || err}`, meta: { reminder_id: r.id } });
  }
}

// ─── Workflows ───────────────────────────────────────────────

async function tickWorkflows() {
  // Nächsten fälligen Step pro Workflow — nur wenn ALLE vorherigen Steps 'done' sind.
  const dueSteps = db.get().prepare(`
    SELECT ws.id AS step_id, ws.workflow_id, ws.step_num, ws.action,
           w.chat_id, w.name AS wf_name
    FROM workflow_steps ws
    JOIN workflows w ON w.id = ws.workflow_id
    WHERE ws.status = 'pending'
      AND w.status = 'running'
      AND (ws.scheduled IS NULL OR datetime(ws.scheduled) <= datetime('now'))
      AND NOT EXISTS (
        SELECT 1 FROM workflow_steps prev
        WHERE prev.workflow_id = ws.workflow_id
          AND prev.step_num < ws.step_num
          AND prev.status != 'completed'
      )
    ORDER BY ws.scheduled ASC NULLS FIRST
    LIMIT 5
  `).all();

  for (const step of dueSteps) await executeWorkflowStep(step);
}

async function executeWorkflowStep(step) {
  const conn = db.get();
  console.log(`[workflow] wf#${step.workflow_id} step#${step.step_num}: ${step.action.substring(0, 70)}`);

  conn.prepare("UPDATE workflow_steps SET status = 'running' WHERE id = ?").run(step.step_id);
  conn.prepare("UPDATE workflows SET status = 'running', current_step = ?, updated_at = datetime('now') WHERE id = ?")
    .run(step.step_num, step.workflow_id);

  try {
    const result = await agent.handle({ chatId: step.chat_id || "workflow", message: step.action });
    const resultText = (result.text || "").substring(0, 2000);

    conn.prepare("UPDATE workflow_steps SET status = 'completed', result = ? WHERE id = ?")
      .run(resultText, step.step_id);

    // Noch offene Steps?
    const remaining = conn.prepare(
      "SELECT COUNT(*) AS c FROM workflow_steps WHERE workflow_id = ? AND status NOT IN ('completed','skipped')"
    ).get(step.workflow_id).c;

    if (remaining === 0) {
      conn.prepare("UPDATE workflows SET status = 'completed', updated_at = datetime('now') WHERE id = ?")
        .run(step.workflow_id);
      console.log(`[workflow] wf#${step.workflow_id} "${step.wf_name}" completed`);
      if (step.chat_id) {
        await telegram.send(step.chat_id, `✅ Workflow „${step.wf_name}" abgeschlossen.`);
      }
    } else {
      conn.prepare("UPDATE workflows SET updated_at = datetime('now') WHERE id = ?").run(step.workflow_id);
    }

    db.logEvent({ type: "workflow-step", message: `wf#${step.workflow_id} step#${step.step_num} done`, meta: { workflow_id: step.workflow_id } });
  } catch (err) {
    console.error(`[workflow] wf#${step.workflow_id} step#${step.step_num} error:`, err.message || err);
    conn.prepare("UPDATE workflow_steps SET status = 'failed', result = ? WHERE id = ?")
      .run(String(err.message || err), step.step_id);
    conn.prepare("UPDATE workflows SET status = 'failed', updated_at = datetime('now') WHERE id = ?")
      .run(step.workflow_id);
    if (step.chat_id) {
      await telegram.send(step.chat_id, `❌ Workflow „${step.wf_name}" Schritt ${step.step_num} fehlgeschlagen: ${err.message || err}`);
    }
    db.logEvent({ type: "workflow-error", message: `wf#${step.workflow_id} step#${step.step_num}: ${err.message || err}`, meta: { workflow_id: step.workflow_id } });
  }
}

// ─── Info ────────────────────────────────────────────────────

export function getInfo() {
  if (!ENABLED) return { enabled: false };
  try {
    const upcoming = db.get().prepare(`
      SELECT id, text, due, chat_id, type FROM reminders WHERE done = 0 ORDER BY due ASC LIMIT 5
    `).all();
    const overdue = db.get().prepare(
      "SELECT COUNT(*) c FROM reminders WHERE done = 0 AND datetime(due) <= datetime('now')"
    ).get().c;
    const pendingWorkflows = db.get().prepare(
      "SELECT COUNT(*) c FROM workflows WHERE status = 'running'"
    ).get().c;
    return { enabled: true, started: !!timer, tick_ms: TICK_MS, upcoming, overdue, pending_workflows: pendingWorkflows };
  } catch (e) {
    return { enabled: true, started: !!timer, error: e.message };
  }
}
