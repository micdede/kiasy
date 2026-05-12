// contacts.js — Kontaktverwaltung (lookup + list)

import * as db from "../lib/db.js";

export const definitions = [
  {
    name: "contact_lookup",
    description: "Sucht einen Kontakt anhand des Namens. Gibt E-Mail-Adressen, Telegram-ID und weitere Infos zurück. Nutze dies bevor du eine Mail sendest oder eine Nachricht schickst, um die richtige Adresse zu finden.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name oder Teil des Namens" },
        email_type: { type: "string", enum: ["work", "private", "any"], description: "Welche E-Mail-Adresse bevorzugt (default: any)" }
      },
      required: ["name"]
    }
  },
  {
    name: "contact_list",
    description: "Listet alle Kontakte (optional gefiltert nach Tag).",
    input_schema: {
      type: "object",
      properties: {
        tag: { type: "string", description: "Filter nach Tag (optional)" }
      }
    }
  }
];

export async function execute(name, input) {
  if (name === "contact_lookup") {
    const rows = db.get().prepare(
      "SELECT * FROM contacts WHERE name LIKE ? ORDER BY name COLLATE NOCASE LIMIT 10"
    ).all(`%${input.name}%`);

    if (!rows.length) return { found: false, message: `Kein Kontakt mit "${input.name}" gefunden.` };

    const emailType = input.email_type || "any";
    const results = rows.map(c => {
      let preferred_email = null;
      if (emailType === "work")    preferred_email = c.email_work || c.email_private;
      else if (emailType === "private") preferred_email = c.email_private || c.email_work;
      else preferred_email = c.email_work || c.email_private;

      return {
        id: c.id, name: c.name,
        email_work: c.email_work, email_private: c.email_private,
        preferred_email,
        telegram_id: c.telegram_id, phone: c.phone,
        notes: c.notes, tags: c.tags
      };
    });

    return { found: true, count: results.length, contacts: results };
  }

  if (name === "contact_list") {
    let sql = "SELECT * FROM contacts";
    const params = [];
    if (input?.tag) { sql += " WHERE tags LIKE ?"; params.push(`%${input.tag}%`); }
    sql += " ORDER BY name COLLATE NOCASE";
    const rows = db.get().prepare(sql).all(...params);
    return { count: rows.length, contacts: rows };
  }

  throw new Error(`unknown: ${name}`);
}

// Für mail.js: alle E-Mail-Adressen aus Kontakten als Whitelist
export function getAllEmails() {
  try {
    const rows = db.get().prepare("SELECT email_work, email_private FROM contacts").all();
    const emails = [];
    for (const r of rows) {
      if (r.email_work)    emails.push(r.email_work.trim().toLowerCase());
      if (r.email_private) emails.push(r.email_private.trim().toLowerCase());
    }
    return emails;
  } catch { return []; }
}
