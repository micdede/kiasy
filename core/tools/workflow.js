// workflow.js — Mehrstufige Workflows (DB-persistiert)
// Phase 1 minimal: erstellen, status checken, cancel.
// Step-Execution macht der Scheduler in einem späteren Sprint.

import * as db from "../lib/db.js";

export const definitions = [
  {
    name: "workflow_create",
    description: "Legt einen mehrstufigen Workflow an. Steps werden später vom Scheduler abgearbeitet.",
    input_schema: {
      type: "object",
      properties: {
        name:   { type: "string" },
        chatId: { type: "string", description: "optional: Telegram-Chat für Notifications" },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action:        { type: "string", description: "Was zu tun ist (Anweisung)" },
              delay_minutes: { type: "number", description: "Wartezeit nach vorigem Step" },
              scheduled:     { type: "string", description: "Absoluter Zeitpunkt ISO" }
            },
            required: ["action"]
          }
        }
      },
      required: ["name", "steps"]
    }
  },
  {
    name: "workflow_status",
    description: "Status aller oder eines Workflows.",
    input_schema: {
      type: "object",
      properties: { id: { type: "integer" } }
    }
  },
  {
    name: "workflow_cancel",
    description: "Bricht einen Workflow ab.",
    input_schema: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"]
    }
  }
];

export async function execute(name, input) {
  const conn = db.get();

  if (name === "workflow_create") {
    if (!input?.name || !input?.steps?.length) throw new Error("name + steps erforderlich");
    const tx = conn.transaction(() => {
      const wf = conn.prepare(`
        INSERT INTO workflows(name, status, chat_id, context)
        VALUES (?, 'running', ?, ?)
      `).run(input.name, input.chatId || null, JSON.stringify({}));
      const wfId = Number(wf.lastInsertRowid);

      let scheduledAt = null;
      input.steps.forEach((step, i) => {
        if (step.scheduled) {
          scheduledAt = step.scheduled;
        } else if (step.delay_minutes) {
          const base = scheduledAt ? new Date(scheduledAt) : new Date();
          scheduledAt = new Date(base.getTime() + step.delay_minutes * 60_000).toISOString();
        }
        conn.prepare(`
          INSERT INTO workflow_steps(workflow_id, step_num, action, status, scheduled)
          VALUES (?, ?, ?, 'pending', ?)
        `).run(wfId, i + 1, step.action, scheduledAt);
      });
      return wfId;
    });
    const id = tx();
    return { id, name: input.name, steps: input.steps.length, status: "running" };
  }

  if (name === "workflow_status") {
    if (input?.id) {
      const wf = conn.prepare("SELECT * FROM workflows WHERE id = ?").get(input.id);
      if (!wf) return { error: "Workflow nicht gefunden" };
      const steps = conn.prepare("SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_num").all(input.id);
      return { ...wf, steps };
    }
    return { workflows: conn.prepare("SELECT id, name, status, current_step, created_at FROM workflows ORDER BY id DESC LIMIT 20").all() };
  }

  if (name === "workflow_cancel") {
    const info = conn.prepare("UPDATE workflows SET status = 'cancelled' WHERE id = ?").run(input.id);
    return { cancelled: info.changes > 0, id: input.id };
  }

  throw new Error(`unknown: ${name}`);
}
