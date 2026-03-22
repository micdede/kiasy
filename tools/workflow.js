const db = require("../lib/db");

// Flag für Auto-Continue (wird von agent.js nach MAX_TURNS geprüft)
let continueRequest = null;

const definitions = [
  {
    name: "workflow_create",
    description:
      "Erstellt einen mehrstufigen Workflow. Schritte werden nacheinander ausgeführt, " +
      "mit optionalen Bedingungen und Verzögerungen. Kontext fließt durch alle Schritte.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name des Workflows" },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { type: "string", description: "Prompt/Anweisung für diesen Schritt" },
              delay_minutes: { type: "number", description: "Wartezeit in Minuten nach dem vorherigen Schritt" },
              scheduled: { type: "string", description: "Absoluter Zeitpunkt (ISO 8601)" },
              condition: {
                type: "object",
                description: 'Bedingung auf Context: {"field":"x","equals":"y"} oder {"field":"x","not_equals":"y"}',
              },
            },
            required: ["action"],
          },
          description: "Liste der Schritte (werden nacheinander ausgeführt)",
        },
        context: {
          type: "object",
          description: "Initialer Kontext (Key-Value), der durch alle Schritte fließt",
        },
      },
      required: ["name", "steps"],
    },
  },
  {
    name: "workflow_status",
    description: "Zeigt Status eines Workflows (per ID) oder aller aktiven Workflows.",
    input_schema: {
      type: "object",
      properties: {
        workflow_id: { type: "string", description: "Workflow-ID (optional — ohne ID werden alle aktiven angezeigt)" },
      },
    },
  },
  {
    name: "workflow_update_context",
    description:
      "Aktualisiert den Workflow-Kontext. Nutze dies in Workflow-Schritten, " +
      "um Ergebnisse an den nächsten Schritt weiterzugeben.",
    input_schema: {
      type: "object",
      properties: {
        workflow_id: { type: "string", description: "Workflow-ID" },
        updates: { type: "object", description: "Key-Value-Paare die in den Kontext gemergt werden" },
      },
      required: ["workflow_id", "updates"],
    },
  },
  {
    name: "workflow_cancel",
    description: "Bricht einen laufenden Workflow ab.",
    input_schema: {
      type: "object",
      properties: {
        workflow_id: { type: "string", description: "Workflow-ID" },
      },
      required: ["workflow_id"],
    },
  },
  {
    name: "workflow_continue",
    description:
      "Signalisiert, dass die aktuelle Aufgabe noch nicht fertig ist und mehr Schritte braucht. " +
      "Das System setzt automatisch fort (max 3 Fortsetzungen = 60 Tool-Turns).",
    input_schema: {
      type: "object",
      properties: {
        status_message: { type: "string", description: "Kurzer Zwischenbericht, was bisher erledigt wurde" },
        remaining_work: { type: "string", description: "Was noch zu tun ist" },
      },
      required: ["status_message", "remaining_work"],
    },
  },
];

async function execute(name, input) {
  switch (name) {
    case "workflow_create": {
      if (!input.name || !input.steps || input.steps.length === 0) {
        return "Name und mindestens ein Schritt erforderlich.";
      }

      const result = db.workflows.create({
        name: input.name,
        steps: input.steps,
        context: input.context || {},
        chatId: input.chatId || null,
      });

      const stepsDesc = input.steps
        .map((s, i) => {
          let desc = `  ${i + 1}. ${s.action.substring(0, 80)}`;
          if (s.delay_minutes) desc += ` (nach ${s.delay_minutes} Min)`;
          if (s.scheduled) desc += ` (geplant: ${s.scheduled})`;
          if (s.condition) desc += ` (bedingt)`;
          return desc;
        })
        .join("\n");

      return `Workflow "${input.name}" erstellt (${result.id}):\n${stepsDesc}\n\nErster Schritt wird beim nächsten Scheduler-Zyklus ausgeführt.`;
    }

    case "workflow_status": {
      if (input.workflow_id) {
        const w = db.workflows.getById(input.workflow_id);
        if (!w) return `Workflow ${input.workflow_id} nicht gefunden.`;

        const steps = w.steps || [];
        const stepsInfo = steps
          .map((s) => {
            const icon = { pending: "⏳", running: "🔄", completed: "✅", failed: "❌", skipped: "⏭️" }[s.status] || "?";
            return `  ${icon} Schritt ${s.step_num}: ${s.action.substring(0, 60)} [${s.status}]`;
          })
          .join("\n");

        const ctx = w.context ? JSON.parse(w.context) : {};
        const ctxInfo = Object.keys(ctx).length > 0 ? `\nKontext: ${JSON.stringify(ctx)}` : "";

        return `Workflow: ${w.name} (${w.id})\nStatus: ${w.status} | Schritt ${w.current_step}/${steps.length}\n${stepsInfo}${ctxInfo}`;
      }

      const active = db.workflows.getAll("running");
      if (active.length === 0) return "Keine aktiven Workflows.";

      return active
        .map((w) => {
          const steps = db.workflows.getSteps(w.id);
          const done = steps.filter((s) => s.status === "completed" || s.status === "skipped").length;
          return `${w.name} (${w.id}) — ${w.status} | ${done}/${steps.length} Schritte`;
        })
        .join("\n");
    }

    case "workflow_update_context": {
      const ctx = db.workflows.updateContext(input.workflow_id, input.updates);
      if (!ctx) return `Workflow ${input.workflow_id} nicht gefunden.`;
      return `Kontext aktualisiert: ${JSON.stringify(ctx)}`;
    }

    case "workflow_cancel": {
      const w = db.workflows.getById(input.workflow_id);
      if (!w) return `Workflow ${input.workflow_id} nicht gefunden.`;
      db.workflows.update(input.workflow_id, { status: "cancelled" });
      return `Workflow "${w.name}" abgebrochen.`;
    }

    case "workflow_continue": {
      continueRequest = {
        status_message: input.status_message,
        remaining_work: input.remaining_work,
      };
      return `Fortsetzung geplant. Zwischenbericht: ${input.status_message}`;
    }

    default:
      return "Unbekanntes Workflow-Tool.";
  }
}

// Von agent.js aufgerufen nach MAX_TURNS
function getContinueRequest() {
  const req = continueRequest;
  continueRequest = null;
  return req;
}

module.exports = { definitions, execute, getContinueRequest };
