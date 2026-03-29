// Aufgaben-Delegation: Aufgaben an Personen delegieren, per Mail senden, automatisch nachfassen
const db = require("../lib/db");

const definitions = [
  {
    name: "delegate_tasks",
    description:
      "Delegiert Aufgaben an eine Person und sendet sie per E-Mail. " +
      "Erstellt automatische Follow-up-Erinnerungen. " +
      "Nutze dies wenn der Nutzer Aufgaben an jemanden vergeben oder senden will.",
    input_schema: {
      type: "object",
      properties: {
        assignee: { type: "string", description: "Name der Person (z.B. Oliver)" },
        email: { type: "string", description: "E-Mail-Adresse der Person" },
        context: { type: "string", enum: ["work", "private"], description: "Kontext: work oder private (bestimmt Absender-Mail)" },
        subject: { type: "string", description: "Betreff / Thema der Aufgaben" },
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "Liste der einzelnen Aufgaben",
        },
        deadline: { type: "string", description: "Deadline als ISO-Datum (z.B. 2026-04-04). Optional." },
        followup_days: { type: "number", description: "Nachfass-Intervall in Tagen (Standard: 3)" },
        send_email: { type: "boolean", description: "E-Mail sofort senden? (Standard: true)" },
      },
      required: ["assignee", "email", "tasks"],
    },
  },
  {
    name: "delegate_status",
    description:
      "Zeigt den Status aller delegierten Aufgaben. " +
      "Filtere optional nach Person. " +
      "Nutze dies wenn der Nutzer fragt: 'Was schuldet mir X noch?' oder 'Welche Aufgaben sind offen?'",
    input_schema: {
      type: "object",
      properties: {
        assignee: { type: "string", description: "Optional: Nur Aufgaben dieser Person zeigen" },
        show_done: { type: "boolean", description: "Auch erledigte anzeigen? (Standard: false)" },
      },
    },
  },
  {
    name: "delegate_update",
    description:
      "Aktualisiert den Status einer delegierten Aufgabe. " +
      "Nutze dies wenn der Nutzer sagt: 'Oliver hat X erledigt' oder 'Aufgabe Y ist in Arbeit'.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "number", description: "ID der einzelnen Aufgabe (aus delegate_status)" },
        status: { type: "string", enum: ["open", "in_progress", "done"], description: "Neuer Status" },
      },
      required: ["task_id", "status"],
    },
  },
  {
    name: "delegate_followup",
    description:
      "Sendet eine Nachfass-Mail für eine Delegation. " +
      "Wird normalerweise automatisch ausgelöst, kann aber auch manuell genutzt werden.",
    input_schema: {
      type: "object",
      properties: {
        delegation_id: { type: "number", description: "ID der Delegation" },
      },
      required: ["delegation_id"],
    },
  },
  {
    name: "delegate_cancel",
    description: "Storniert eine Delegation (setzt Status auf cancelled).",
    input_schema: {
      type: "object",
      properties: {
        delegation_id: { type: "number", description: "ID der Delegation" },
      },
      required: ["delegation_id"],
    },
  },
];

// --- E-Mail senden (nutzt vorhandene E-Mail-Tools) ---

async function sendDelegationMail(to, subject, body) {
  // Versuche Standard-E-Mail, dann Kerio
  const emailHost = process.env.EMAIL_HOST;
  const kerioHost = process.env.KERIO_HOST;

  if (emailHost && process.env.EMAIL_USER && process.env.EMAIL_PASSWORD) {
    const nodemailer = require("nodemailer");
    const smtpHost = process.env.EMAIL_SMTP_HOST || emailHost.replace(/^imap\./, "smtp.");
    const smtpPort = parseInt(process.env.EMAIL_SMTP_PORT) || 587;
    const transporter = nodemailer.createTransport({
      host: smtpHost, port: smtpPort, secure: smtpPort === 465,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD },
      tls: { rejectUnauthorized: false },
    });
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to, subject, text: body,
    });
    return true;
  }

  if (kerioHost && process.env.KERIO_USER && process.env.KERIO_PASSWORD) {
    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport({
      host: kerioHost, port: 587, secure: false,
      auth: { user: process.env.KERIO_USER, pass: process.env.KERIO_PASSWORD },
      tls: { rejectUnauthorized: false },
    });
    await transporter.sendMail({
      from: process.env.KERIO_FROM || process.env.KERIO_USER,
      to, subject, text: body,
    });
    return true;
  }

  return false;
}

function formatTaskList(tasks) {
  return tasks.map((t, i) => {
    const status = t.status === "done" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]";
    return `${status} ${i + 1}. ${t.task}${t.completed_at ? " (erledigt: " + t.completed_at.substring(0, 10) + ")" : ""}`;
  }).join("\n");
}

function formatDeadline(deadline) {
  if (!deadline) return "";
  try {
    return new Date(deadline).toLocaleDateString("de-DE", {
      weekday: "short", day: "2-digit", month: "2-digit", year: "numeric",
      timeZone: process.env.TZ || "Europe/Berlin",
    });
  } catch { return deadline; }
}

// --- Ausführung ---

async function execute(name, input) {
  const BOT = process.env.BOT_NAME || "KIASY";
  const OWNER = process.env.OWNER_NAME || "Nutzer";
  const TZ = process.env.TZ || "Europe/Berlin";

  try {
    switch (name) {
      case "delegate_tasks": {
        const delegation = db.delegations.create({
          assignee: input.assignee,
          assignee_email: input.email,
          context: input.context || "work",
          subject: input.subject || `Aufgaben von ${OWNER}`,
          deadline: input.deadline || null,
          followup_days: input.followup_days || 3,
          tasks: input.tasks,
          chat_id: null,
        });

        let emailSent = false;
        if (input.send_email !== false) {
          const deadlineStr = input.deadline ? `\nDeadline: ${formatDeadline(input.deadline)}` : "";
          const mailBody = `Hallo ${input.assignee},\n\n` +
            `${OWNER} hat dir folgende Aufgaben zugewiesen:\n\n` +
            input.tasks.map((t, i) => `${i + 1}. ${t}`).join("\n") +
            deadlineStr +
            `\n\nBitte gib Rückmeldung wenn du Aufgaben erledigt hast.\n\n` +
            `Viele Grüße\n${BOT}`;

          const mailSubject = delegation.subject + (input.deadline ? ` (bis ${formatDeadline(input.deadline)})` : "");

          try {
            emailSent = await sendDelegationMail(input.email, mailSubject, mailBody);
          } catch (e) {
            // Mail-Fehler loggen aber Delegation trotzdem erstellen
          }
        }

        const nextFollowup = delegation.next_followup
          ? new Date(delegation.next_followup).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: TZ })
          : "kein Follow-up";

        let result = `✅ Delegation #${delegation.id} erstellt:\n`;
        result += `An: ${input.assignee} (${input.email})\n`;
        result += `Aufgaben:\n${delegation.tasks.map((t, i) => `  ${i + 1}. ${t.task}`).join("\n")}\n`;
        if (input.deadline) result += `Deadline: ${formatDeadline(input.deadline)}\n`;
        result += `Follow-up: alle ${input.followup_days || 3} Tage (nächstes: ${nextFollowup})\n`;
        result += emailSent ? `📧 E-Mail gesendet` : `⚠️ E-Mail konnte nicht gesendet werden (kein Mail-Provider konfiguriert)`;

        return result;
      }

      case "delegate_status": {
        let delegations;
        if (input.assignee) {
          delegations = db.delegations.getByAssignee(input.assignee);
          if (delegations.length === 0) return `Keine offenen Aufgaben für ${input.assignee}.`;
        } else {
          delegations = input.show_done ? db.delegations.getAll() : db.delegations.getOpen();
          if (delegations.length === 0) return "Keine delegierten Aufgaben vorhanden.";
        }

        const lines = delegations.map(d => {
          const openCount = d.tasks.filter(t => t.status !== "done").length;
          const doneCount = d.tasks.filter(t => t.status === "done").length;
          const deadlineStr = d.deadline ? ` | Deadline: ${formatDeadline(d.deadline)}` : "";
          const statusIcon = d.status === "done" ? "✅" : d.status === "cancelled" ? "❌" : openCount === 0 ? "✅" : "📋";

          let line = `${statusIcon} #${d.id} ${d.assignee}: ${d.subject}${deadlineStr}\n`;
          line += `   ${doneCount}/${d.tasks.length} erledigt`;
          if (d.status !== "done" && d.status !== "cancelled") {
            line += ` | Follow-up: alle ${d.followup_days}d`;
          }
          line += "\n" + d.tasks.map((t, i) => {
            const icon = t.status === "done" ? "  ✅" : t.status === "in_progress" ? "  🔄" : "  ⬜";
            return `${icon} [${t.id}] ${t.task}${t.completed_at ? " (" + t.completed_at.substring(0, 10) + ")" : ""}`;
          }).join("\n");
          return line;
        });

        return `📋 Delegierte Aufgaben:\n\n${lines.join("\n\n")}`;
      }

      case "delegate_update": {
        db.delegations.updateTaskStatus(input.task_id, input.status);

        // Finde die zugehörige Delegation für Auto-Complete-Check
        const allOpen = db.delegations.getOpen();
        for (const d of allOpen) {
          const task = d.tasks.find(t => t.id === input.task_id);
          if (task) {
            const autoCompleted = db.delegations.checkAutoComplete(d.id);
            const statusText = input.status === "done" ? "erledigt" : input.status === "in_progress" ? "in Arbeit" : "offen";
            let result = `✅ Aufgabe [${input.task_id}] "${task.task}" → ${statusText}`;
            if (autoCompleted) {
              result += `\n\n🎉 Alle Aufgaben von ${d.assignee} (#${d.id}: ${d.subject}) sind erledigt!`;
            } else {
              const remaining = d.tasks.filter(t => t.id !== input.task_id && t.status !== "done");
              if (remaining.length > 0) {
                result += `\n\nOffen bei ${d.assignee}:\n${remaining.map(t => `  ⬜ ${t.task}`).join("\n")}`;
              }
            }
            return result;
          }
        }

        return `✅ Aufgabe [${input.task_id}] Status aktualisiert: ${input.status}`;
      }

      case "delegate_followup": {
        const d = db.delegations.getById(input.delegation_id);
        if (!d) return `❌ Delegation #${input.delegation_id} nicht gefunden.`;
        if (d.status === "done" || d.status === "cancelled") return `Delegation #${d.id} ist bereits ${d.status}.`;

        const openTasks = d.tasks.filter(t => t.status !== "done");
        if (openTasks.length === 0) {
          db.delegations.updateStatus(d.id, "done");
          return `✅ Alle Aufgaben von ${d.assignee} sind erledigt — Delegation abgeschlossen.`;
        }

        const deadlineStr = d.deadline ? `\nDeadline: ${formatDeadline(d.deadline)}` : "";
        const mailBody = `Hallo ${d.assignee},\n\n` +
          `Kurze Nachfrage zum Stand deiner Aufgaben:\n\n` +
          `${d.subject}:\n` +
          d.tasks.map((t, i) => {
            const status = t.status === "done" ? "✓ erledigt" : "○ offen";
            return `  ${status} — ${t.task}`;
          }).join("\n") +
          deadlineStr +
          `\n\n${openTasks.length} von ${d.tasks.length} Aufgaben sind noch offen.\n` +
          `Bitte gib kurz Rückmeldung.\n\n` +
          `Viele Grüße\n${BOT}`;

        let emailSent = false;
        try {
          emailSent = await sendDelegationMail(d.assignee_email, `Nachfrage: ${d.subject}`, mailBody);
        } catch {}

        db.delegations.updateFollowup(d.id);

        let result = `📧 Follow-up für Delegation #${d.id} (${d.assignee}):\n`;
        result += `${openTasks.length}/${d.tasks.length} offen\n`;
        result += emailSent ? "E-Mail gesendet" : "⚠️ E-Mail konnte nicht gesendet werden";
        return result;
      }

      case "delegate_cancel": {
        const d = db.delegations.getById(input.delegation_id);
        if (!d) return `❌ Delegation #${input.delegation_id} nicht gefunden.`;
        db.delegations.updateStatus(d.id, "cancelled");
        return `❌ Delegation #${d.id} (${d.assignee}: ${d.subject}) storniert.`;
      }

      default:
        return "Unbekannte Delegations-Operation.";
    }
  } catch (error) {
    return `❌ Delegations-Fehler: ${error.message}`;
  }
}

module.exports = { definitions, execute };
