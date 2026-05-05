// calendar.js — CalDAV (Kerio Connect, Nextcloud, iCloud, Google etc.)
// Auto-Discovery via tsdav. iCal-Parsing via ical.js.

import { createDAVClient } from "tsdav";
import ICAL from "ical.js";

const URL_RAW = process.env.CALDAV_URL || "";
const USER    = process.env.CALDAV_USER || "";
const PASS    = process.env.CALDAV_PASS || "";
const MODE    = (process.env.CALDAV_MODE || "read").toLowerCase();  // read | write | off
// Spezifische Kalender für Reminders/Tasks (Substring-Match auf displayName).
// Default: erster gefundener Calendar bzw. erster mit "task" im Namen.
const CAL_EVENTS = process.env.CALDAV_CALENDAR || "";
const CAL_TASKS  = process.env.CALDAV_TASKS    || "";
const CAL_NOTES  = process.env.CALDAV_NOTES    || "";  // Default: gleicher Kalender wie Events (Kerio-Konvention)

let _client = null;
let _calendars = null;

function serverUrl() {
  if (!URL_RAW) throw new Error("CALDAV_URL nicht gesetzt");
  let u = URL_RAW.trim();
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return u.replace(/\/+$/, "");
}

async function client() {
  if (MODE === "off") throw new Error("CALDAV_MODE=off — Kalender deaktiviert");
  if (!USER || !PASS) throw new Error("CALDAV_USER/CALDAV_PASS nicht gesetzt");
  if (_client) return _client;
  _client = await createDAVClient({
    serverUrl: serverUrl(),
    credentials: { username: USER, password: PASS },
    authMethod: "Basic",
    defaultAccountType: "caldav"
  });
  return _client;
}

async function calendars() {
  if (_calendars) return _calendars;
  const c = await client();
  _calendars = await c.fetchCalendars();
  console.log(`[calendar] discovered ${_calendars.length} calendar(s):`,
    _calendars.map(x => x.displayName || x.url).join(", "));
  return _calendars;
}

function pickCalendar(cals, hint) {
  if (!cals.length) throw new Error("Keine Kalender gefunden");
  const h = (hint || CAL_EVENTS || "").trim();
  if (!h) {
    return cals.find(c => /calendar|standard|default|kalender/i.test(c.displayName || "")) || cals[0];
  }
  return cals.find(c => (c.displayName || "").toLowerCase().includes(h.toLowerCase())) || cals[0];
}

function pickTaskCalendar(cals, hint) {
  if (!cals.length) throw new Error("Keine Kalender gefunden");
  const h = (hint || CAL_TASKS || "").trim();
  if (h) return cals.find(c => (c.displayName || "").toLowerCase().includes(h.toLowerCase())) || cals[0];
  return cals.find(c => /task|aufgabe|todo|to-do/i.test(c.displayName || "")) || cals[0];
}

function pickNoteCalendar(cals, hint) {
  if (!cals.length) throw new Error("Keine Kalender gefunden");
  const h = (hint || CAL_NOTES || "").trim();
  if (h) return cals.find(c => (c.displayName || "").toLowerCase().includes(h.toLowerCase())) || cals[0];
  // Default: Notes-spezifisch wenn vorhanden, sonst Events-Kalender (Kerio-Konvention)
  return cals.find(c => /note|notiz|journal/i.test(c.displayName || "")) || pickCalendar(cals, null);
}

// Public: für caldav-watcher.js
export async function getEventsCalendar(hint = null) {
  const cals = await calendars();
  return pickCalendar(cals, hint);
}
export async function getTasksCalendar(hint = null) {
  const cals = await calendars();
  return pickTaskCalendar(cals, hint);
}
export async function getClient() { return client(); }

// Direkter CalDAV-REPORT für eine bestimmte Komponente (VTODO, VJOURNAL).
// Workaround: tsdav.fetchCalendarObjects filtert per default nur VEVENT,
// VTODO/VJOURNAL liefert es leer. Wir machen den REPORT selbst und holen
// die ICS-Dateien über GET.
async function fetchByComponent(calendarUrl, component) {
  const auth = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
  const reportXml = `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:d="DAV:">
  <d:prop><d:getetag/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="${component}"/>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
  const r = await fetch(calendarUrl, {
    method: "REPORT",
    headers: { "Authorization": auth, "Depth": "1", "Content-Type": "application/xml" },
    body: reportXml
  });
  if (!r.ok) throw new Error(`REPORT ${component}: HTTP ${r.status}`);
  const xml = await r.text();
  // hrefs extrahieren (Namespace-agnostisch)
  const hrefs = [...new Set([...xml.matchAll(/<[^:>]*:?href[^>]*>([^<]+\.ics)<\/[^>]+>/gi)].map(m => m[1]))];
  // Pro href GET (parallel)
  const base = new URL(calendarUrl).origin;
  const objs = await Promise.all(hrefs.map(async h => {
    const url = h.startsWith("http") ? h : base + h;
    const gr = await fetch(url, { headers: { "Authorization": auth } });
    if (!gr.ok) return null;
    return { url, data: await gr.text() };
  }));
  return objs.filter(Boolean);
}

function fmtDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export function normalizeIcs(s) {
  // Manche Server (Kerio) liefern Bare-CR statt CRLF. Normalisiere beides → \r\n
  return String(s || "").replace(/\r\n|\r|\n/g, "\r\n");
}

// VJOURNAL-Parser für Notes (Kerio speichert Notizen als VJOURNAL im Calendar)
export function noteToJson(obj) {
  try {
    const jcal = ICAL.parse(normalizeIcs(obj.data));
    const comp = new ICAL.Component(jcal);
    const vj = comp.getFirstSubcomponent("vjournal");
    if (!vj) return null;
    const get = (n) => vj.getFirstPropertyValue(n);
    const dtstart = get("dtstart");
    const catProp = vj.getFirstProperty("categories");
    const cats = catProp ? catProp.getValues().flatMap(v => String(v).split(",").map(s => s.trim()).filter(Boolean)) : [];
    return {
      uid:         get("uid"),
      summary:     get("summary") || "",
      description: get("description") || "",
      categories:  cats,
      created:     dtstart ? dtstart.toJSDate().toISOString() : null,
      url:         obj.url
    };
  } catch (err) {
    return { uid: null, error: err.message };
  }
}

function buildVJOURNAL({ summary, description = "", categories = [] }) {
  const fmt = (d) => d.toISOString().replace(/[-:]/g,"").split(".")[0] + "Z";
  const uid = `kiasy-note-${Date.now()}-${Math.random().toString(36).slice(2,10)}@kiasy`;
  const stamp = fmt(new Date());
  const esc = s => String(s||"").replace(/\\/g,"\\\\").replace(/\n/g,"\\n").replace(/,/g,"\\,").replace(/;/g,"\\;");
  const cats = categories.length ? `CATEGORIES:${categories.map(esc).join(",")}` : null;
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//kiasy//calendar//DE", "CALSCALE:GREGORIAN",
    "BEGIN:VJOURNAL",
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${stamp}`,
    `SUMMARY:${esc(summary)}`,
    description ? `DESCRIPTION:${esc(description)}` : null,
    cats,
    "END:VJOURNAL",
    "END:VCALENDAR"
  ].filter(Boolean).join("\r\n") + "\r\n";
}

// VTODO-Parser für Tasks
export function todoToJson(obj) {
  try {
    const jcal = ICAL.parse(normalizeIcs(obj.data));
    const comp = new ICAL.Component(jcal);
    const vtodo = comp.getFirstSubcomponent("vtodo");
    if (!vtodo) return null;
    const get = (n) => vtodo.getFirstPropertyValue(n);
    const due = get("due");
    const completed = get("completed");
    return {
      uid:         get("uid"),
      summary:     get("summary") || "",
      description: get("description") || "",
      status:      get("status") || "NEEDS-ACTION",
      due:         due ? due.toJSDate().toISOString() : null,
      completed:   completed ? completed.toJSDate().toISOString() : null,
      priority:    get("priority"),
      url:         obj.url
    };
  } catch (err) {
    return { uid: null, error: err.message };
  }
}

function buildVTODO({ summary, description = "", due = null }) {
  const fmt = (d) => d.toISOString().replace(/[-:]/g,"").split(".")[0] + "Z";
  const uid = `kiasy-task-${Date.now()}-${Math.random().toString(36).slice(2,10)}@kiasy`;
  const stamp = fmt(new Date());
  const esc = s => String(s||"").replace(/\\/g,"\\\\").replace(/\n/g,"\\n").replace(/,/g,"\\,").replace(/;/g,"\\;");
  const dueLine = due ? `DUE:${fmt(new Date(due))}` : null;
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//kiasy//calendar//DE", "CALSCALE:GREGORIAN",
    "BEGIN:VTODO",
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `SUMMARY:${esc(summary)}`,
    description ? `DESCRIPTION:${esc(description)}` : null,
    dueLine,
    "STATUS:NEEDS-ACTION",
    "END:VTODO",
    "END:VCALENDAR"
  ].filter(Boolean).join("\r\n") + "\r\n";
}

function eventToJson(event) {
  try {
    const jcal = ICAL.parse(normalizeIcs(event.data));
    const comp = new ICAL.Component(jcal);
    const vevent = comp.getFirstSubcomponent("vevent");
    if (!vevent) return null;
    const e = new ICAL.Event(vevent);
    const atts = vevent.getAllProperties("attendee").map(p => {
      const v = String(p.getFirstValue() || "");
      return v.replace(/^mailto:/i, "");
    });
    const orgRaw = vevent.getFirstPropertyValue("organizer");
    return {
      uid:        e.uid,
      summary:    e.summary || "",
      description: e.description || "",
      location:   e.location || "",
      start:      e.startDate?.toJSDate()?.toISOString() || null,
      end:        e.endDate?.toJSDate()?.toISOString() || null,
      allDay:     e.startDate?.isDate || false,
      attendees:  atts,
      organizer:  orgRaw ? String(orgRaw).replace(/^mailto:/i, "") : null,
      url:        event.url
    };
  } catch (err) {
    return { uid: null, error: err.message, raw: event.data?.substring(0, 200) };
  }
}

// Extrahiert reine E-Mail aus "Name <mail@x>" oder "mail@x"
function extractEmail(s) {
  if (!s) return null;
  const m = String(s).match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

function buildICS({ summary, description = "", location = "", start, end, allDay = false, attendees = [], organizer = null, uid = null }) {
  const dtstart = new Date(start);
  const dtend   = new Date(end || (dtstart.getTime() + 60*60*1000));
  if (isNaN(dtstart.getTime())) throw new Error("start ungültig");
  if (isNaN(dtend.getTime())) throw new Error("end ungültig");
  const fmt = (d) => allDay
    ? d.toISOString().substring(0,10).replace(/-/g,"")
    : d.toISOString().replace(/[-:]/g,"").split(".")[0] + "Z";
  uid = uid || `kiasy-${Date.now()}-${Math.random().toString(36).slice(2,10)}@kiasy`;
  const stamp = fmt(new Date());
  const dt = allDay
    ? `DTSTART;VALUE=DATE:${fmt(dtstart)}\r\nDTEND;VALUE=DATE:${fmt(dtend)}`
    : `DTSTART:${fmt(dtstart)}\r\nDTEND:${fmt(dtend)}`;
  const esc = s => String(s||"").replace(/\\/g,"\\\\").replace(/\n/g,"\\n").replace(/,/g,"\\,").replace(/;/g,"\\;");
  // Organizer: nötig damit Kerio Einladungen verschickt
  const orgEmail = extractEmail(organizer || process.env.KERIO_FROM);
  const orgLine = orgEmail ? `ORGANIZER;CN=${esc(USER || orgEmail)}:mailto:${orgEmail}` : null;
  // Attendees: jede Adresse als ATTENDEE-Zeile
  const atLines = (attendees || []).map(a => {
    const email = extractEmail(a);
    if (!email) return null;
    return `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${email}`;
  }).filter(Boolean);
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//kiasy//calendar//DE", "CALSCALE:GREGORIAN",
    atLines.length ? "METHOD:REQUEST" : null,  // Kerio triggert Invitation-Mails bei METHOD:REQUEST
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    dt,
    `SUMMARY:${esc(summary)}`,
    description ? `DESCRIPTION:${esc(description)}` : null,
    location    ? `LOCATION:${esc(location)}`       : null,
    orgLine,
    ...atLines,
    "END:VEVENT", "END:VCALENDAR"
  ].filter(Boolean);
  return lines.join("\r\n") + "\r\n";
}

export const definitions = [
  {
    name: "calendar_list",
    description: "Listet Termine im Zeitraum (default: heute + nächste 7 Tage). Nutze dieses Tool wenn der User nach Terminen, Kalender, freien Slots, etc. fragt.",
    input_schema: {
      type: "object",
      properties: {
        from:     { type: "string", description: "ISO-Date Start (default: heute 00:00). z.B. 2026-05-05" },
        to:       { type: "string", description: "ISO-Date Ende  (default: heute + 7 Tage)" },
        calendar: { type: "string", description: "Optional: Kalender-Name (substring match), Default: erster gefundener" }
      }
    }
  },
  {
    name: "calendar_create",
    description: "Erstellt einen neuen Kalender-Eintrag. Default-Dauer 1h wenn end fehlt. Mit attendees werden Einladungsmails verschickt (Kerio).",
    input_schema: {
      type: "object",
      properties: {
        summary:     { type: "string", description: "Titel des Termins" },
        start:       { type: "string", description: "ISO-DateTime, z.B. 2026-05-06T14:00:00" },
        end:         { type: "string", description: "ISO-DateTime (optional, sonst start+1h)" },
        location:    { type: "string", description: "Ort (optional)" },
        description: { type: "string", description: "Beschreibung (optional)" },
        allDay:      { type: "boolean", description: "Ganztägig (default false)" },
        attendees:   { type: "array", items: { type: "string" }, description: "E-Mail-Adressen der Teilnehmer (löst Einladungsmails aus)" },
        calendar:    { type: "string", description: "Kalender-Name (substring match, optional)" }
      },
      required: ["summary", "start"]
    }
  },
  {
    name: "calendar_update",
    description: "Bearbeitet einen bestehenden Termin per UID. Nur übergebene Felder werden geändert. Mit attendees werden Einladungsmails verschickt.",
    input_schema: {
      type: "object",
      properties: {
        uid:         { type: "string" },
        summary:     { type: "string" },
        start:       { type: "string" },
        end:         { type: "string" },
        location:    { type: "string" },
        description: { type: "string" },
        allDay:      { type: "boolean" },
        attendees:   { type: "array", items: { type: "string" }, description: "E-Mails — überschreibt bisherige Liste komplett" },
        add_attendees:    { type: "array", items: { type: "string" }, description: "Diese E-Mails zur bestehenden Liste hinzufügen" },
        remove_attendees: { type: "array", items: { type: "string" }, description: "Diese E-Mails aus der Liste entfernen" }
      },
      required: ["uid"]
    }
  },
  {
    name: "calendar_delete",
    description: "Löscht einen Termin per UID (UID aus calendar_list).",
    input_schema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "UID des Events" }
      },
      required: ["uid"]
    }
  },
  {
    name: "calendar_calendars",
    description: "Listet alle verfügbaren Kalender (Name, URL, Read/Write).",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "task_list",
    description: "Listet Tasks (VTODO) aus dem Tasks-Kalender. Default: nur offene (NEEDS-ACTION/IN-PROCESS).",
    input_schema: {
      type: "object",
      properties: {
        include_completed: { type: "boolean", description: "Auch erledigte Tasks (default false)" },
        calendar:          { type: "string",  description: "Kalender-Name (substring), default: CALDAV_TASKS oder erster mit 'task' im Namen" }
      }
    }
  },
  {
    name: "task_create",
    description: "Erstellt eine neue Aufgabe (VTODO). Optional mit Fälligkeitsdatum.",
    input_schema: {
      type: "object",
      properties: {
        summary:     { type: "string", description: "Titel" },
        description: { type: "string" },
        due:         { type: "string", description: "ISO-DateTime, optional" },
        calendar:    { type: "string", description: "Kalender-Name (substring), optional" }
      },
      required: ["summary"]
    }
  },
  {
    name: "task_complete",
    description: "Markiert eine Task als erledigt (status COMPLETED). Behält die Task in der Liste.",
    input_schema: {
      type: "object",
      properties: { uid: { type: "string" } },
      required: ["uid"]
    }
  },
  {
    name: "task_delete",
    description: "Löscht eine Task endgültig (entfernt sie komplett, nicht nur als erledigt markieren).",
    input_schema: {
      type: "object",
      properties: { uid: { type: "string" } },
      required: ["uid"]
    }
  },
  {
    name: "note_list",
    description: "Listet Notizen vom Mailserver (Kerio: VJOURNAL im Calendar). Nicht zu verwechseln mit der lokalen Markdown-Wissensbasis.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Optional: nur Notizen mit dieser Kategorie" },
        calendar: { type: "string", description: "Kalender-Name (substring), default: Notes-Kalender oder erster mit 'note' im Namen, sonst Events-Kalender" }
      }
    }
  },
  {
    name: "note_create",
    description: "Erstellt eine neue Server-Notiz (VJOURNAL).",
    input_schema: {
      type: "object",
      properties: {
        summary:     { type: "string", description: "Titel" },
        description: { type: "string", description: "Inhalt (mehrzeilig erlaubt)" },
        categories:  { type: "array", items: { type: "string" }, description: "Tags (optional)" },
        calendar:    { type: "string" }
      },
      required: ["summary"]
    }
  },
  {
    name: "note_update",
    description: "Aktualisiert summary/description/categories einer Notiz per UID.",
    input_schema: {
      type: "object",
      properties: {
        uid:         { type: "string" },
        summary:     { type: "string" },
        description: { type: "string" },
        categories:  { type: "array", items: { type: "string" } }
      },
      required: ["uid"]
    }
  },
  {
    name: "note_delete",
    description: "Löscht eine Notiz per UID.",
    input_schema: {
      type: "object",
      properties: { uid: { type: "string" } },
      required: ["uid"]
    }
  }
];

export async function execute(name, input) {
  if (name === "calendar_calendars") {
    const cals = await calendars();
    return cals.map(c => ({
      displayName: c.displayName || "(no name)",
      url: c.url,
      ctag: c.ctag,
      timezone: c.timezone
    }));
  }

  if (name === "calendar_list") {
    const cals = await calendars();
    const cal = pickCalendar(cals, input?.calendar);
    const c = await client();
    const from = fmtDate(input?.from) || new Date(new Date().setHours(0,0,0,0));
    const to   = fmtDate(input?.to)   || new Date(from.getTime() + 7*24*60*60*1000);
    const objects = await c.fetchCalendarObjects({
      calendar: cal,
      timeRange: { start: from.toISOString(), end: to.toISOString() }
    });
    const events = objects.map(eventToJson).filter(Boolean);
    events.sort((a,b) => (a.start || "").localeCompare(b.start || ""));
    return {
      calendar: cal.displayName,
      from: from.toISOString(),
      to:   to.toISOString(),
      count: events.length,
      events
    };
  }

  if (name === "calendar_create") {
    if (MODE !== "write") throw new Error(`CALDAV_MODE=${MODE} — Schreiben nicht erlaubt (auf 'write' setzen)`);
    if (!input?.summary) throw new Error("summary erforderlich");
    if (!input?.start)   throw new Error("start erforderlich");
    const cals = await calendars();
    const cal  = pickCalendar(cals, input.calendar);
    const c    = await client();
    const ics  = buildICS(input);
    const filename = `kiasy-${Date.now()}.ics`;
    const result = await c.createCalendarObject({ calendar: cal, filename, iCalString: ics });
    return { created: true, calendar: cal.displayName, filename, status: result.status, url: result.url, attendees: input.attendees || [] };
  }

  if (name === "calendar_update") {
    if (MODE !== "write") throw new Error(`CALDAV_MODE=${MODE} — Schreiben nicht erlaubt`);
    if (!input?.uid) throw new Error("uid erforderlich");
    const cals = await calendars();
    // Such Event über alle Kalender per VEVENT-Filter
    for (const cal of cals) {
      let objects;
      try { objects = await fetchByComponent(cal.url, "VEVENT"); } catch { continue; }
      for (const obj of objects) {
        const ev = eventToJson(obj);
        if (!ev || ev.uid !== input.uid) continue;
        // Attendees mergen
        let attendees = ev.attendees || [];
        if (Array.isArray(input.attendees)) attendees = input.attendees;
        if (Array.isArray(input.add_attendees))    attendees = [...new Set([...attendees, ...input.add_attendees])];
        if (Array.isArray(input.remove_attendees)) {
          const rm = new Set(input.remove_attendees.map(s => extractEmail(s)));
          attendees = attendees.filter(a => !rm.has(extractEmail(a)));
        }
        const merged = {
          uid:         ev.uid,
          summary:     input.summary     ?? ev.summary,
          description: input.description ?? ev.description,
          location:    input.location    ?? ev.location,
          start:       input.start       ?? ev.start,
          end:         input.end         ?? ev.end,
          allDay:      input.allDay      ?? ev.allDay,
          attendees,
          organizer:   ev.organizer || process.env.KERIO_FROM
        };
        const ics = buildICS(merged);
        const auth = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
        const r = await fetch(obj.url, {
          method: "PUT",
          headers: { "Authorization": auth, "Content-Type": "text/calendar; charset=utf-8" },
          body: ics
        });
        if (!r.ok) throw new Error(`PUT failed: HTTP ${r.status} ${(await r.text()).substring(0,200)}`);
        return { updated: true, calendar: cal.displayName, uid: input.uid, attendees };
      }
    }
    throw new Error(`UID nicht gefunden: ${input.uid}`);
  }

  if (name === "task_list") {
    const cals = await calendars();
    const cal = pickTaskCalendar(cals, input?.calendar);
    const objects = await fetchByComponent(cal.url, "VTODO");
    const tasks = objects.map(todoToJson).filter(t => t && t.uid);
    const filtered = input?.include_completed
      ? tasks
      : tasks.filter(t => t.status !== "COMPLETED");
    filtered.sort((a,b) => {
      // Offene oben, sortiert nach due (null ans Ende)
      if (!a.due && !b.due) return 0;
      if (!a.due) return 1;
      if (!b.due) return -1;
      return a.due.localeCompare(b.due);
    });
    return { calendar: cal.displayName, count: filtered.length, total: tasks.length, tasks: filtered };
  }

  if (name === "task_create") {
    if (MODE !== "write") throw new Error(`CALDAV_MODE=${MODE} — Schreiben nicht erlaubt`);
    if (!input?.summary) throw new Error("summary erforderlich");
    const cals = await calendars();
    const cal  = pickTaskCalendar(cals, input.calendar);
    const c    = await client();
    const ics  = buildVTODO(input);
    const filename = `kiasy-task-${Date.now()}.ics`;
    const result = await c.createCalendarObject({ calendar: cal, filename, iCalString: ics });
    return { created: true, calendar: cal.displayName, filename, status: result.status, url: result.url };
  }

  if (name === "task_delete") {
    // Wir nutzen calendar_delete-Logik (sucht über alle Komponenten)
    return execute("calendar_delete", input);
  }

  if (name === "task_complete") {
    if (MODE !== "write") throw new Error(`CALDAV_MODE=${MODE} — Schreiben nicht erlaubt`);
    if (!input?.uid) throw new Error("uid erforderlich");
    const cals = await calendars();
    const c = await client();
    for (const cal of cals) {
      const objects = await fetchByComponent(cal.url, "VTODO");
      for (const obj of objects) {
        const t = todoToJson(obj);
        if (t && t.uid === input.uid) {
          // ICS rebauen mit STATUS:COMPLETED + COMPLETED:<now>
          const stamp = new Date().toISOString().replace(/[-:]/g,"").split(".")[0] + "Z";
          let updated = normalizeIcs(obj.data);
          if (/STATUS:/i.test(updated)) updated = updated.replace(/STATUS:[^\r\n]*/i, "STATUS:COMPLETED");
          else updated = updated.replace(/END:VTODO/i, `STATUS:COMPLETED\r\nEND:VTODO`);
          if (!/COMPLETED:/i.test(updated)) updated = updated.replace(/END:VTODO/i, `COMPLETED:${stamp}\r\nEND:VTODO`);
          await c.updateCalendarObject({ calendarObject: { ...obj, data: updated } });
          return { completed: true, calendar: cal.displayName, uid: t.uid };
        }
      }
    }
    throw new Error(`Task-UID nicht gefunden: ${input.uid}`);
  }

  if (name === "note_list") {
    const cals = await calendars();
    const cal = pickNoteCalendar(cals, input?.calendar);
    const objects = await fetchByComponent(cal.url, "VJOURNAL");
    let notes = objects.map(noteToJson).filter(n => n && n.uid);
    if (input?.category) {
      const cat = input.category.toLowerCase();
      notes = notes.filter(n => n.categories.some(c => c.toLowerCase().includes(cat)));
    }
    notes.sort((a,b) => (b.created || "").localeCompare(a.created || ""));
    return { calendar: cal.displayName, count: notes.length, notes };
  }

  if (name === "note_create") {
    if (MODE !== "write") throw new Error(`CALDAV_MODE=${MODE} — Schreiben nicht erlaubt`);
    if (!input?.summary) throw new Error("summary erforderlich");
    const cals = await calendars();
    const cal  = pickNoteCalendar(cals, input.calendar);
    const c    = await client();
    const ics  = buildVJOURNAL(input);
    const filename = `kiasy-note-${Date.now()}.ics`;
    const result = await c.createCalendarObject({ calendar: cal, filename, iCalString: ics });
    return { created: true, calendar: cal.displayName, filename, status: result.status, url: result.url };
  }

  if (name === "note_update") {
    if (MODE !== "write") throw new Error(`CALDAV_MODE=${MODE} — Schreiben nicht erlaubt`);
    if (!input?.uid) throw new Error("uid erforderlich");
    const cals = await calendars();
    const c = await client();
    for (const cal of cals) {
      const objects = await fetchByComponent(cal.url, "VJOURNAL");
      for (const obj of objects) {
        const n = noteToJson(obj);
        if (n && n.uid === input.uid) {
          // Rebuild VJOURNAL mit gleicher UID
          const merged = {
            summary:     input.summary     ?? n.summary,
            description: input.description ?? n.description,
            categories:  input.categories  ?? n.categories
          };
          const stamp = new Date().toISOString().replace(/[-:]/g,"").split(".")[0] + "Z";
          const esc = s => String(s||"").replace(/\\/g,"\\\\").replace(/\n/g,"\\n").replace(/,/g,"\\,").replace(/;/g,"\\;");
          const cats = merged.categories?.length ? `CATEGORIES:${merged.categories.map(esc).join(",")}` : null;
          const ics = [
            "BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//kiasy//calendar//DE","CALSCALE:GREGORIAN",
            "BEGIN:VJOURNAL",
            `UID:${input.uid}`,
            `DTSTAMP:${stamp}`,
            `DTSTART:${stamp}`,
            `SUMMARY:${esc(merged.summary)}`,
            merged.description ? `DESCRIPTION:${esc(merged.description)}` : null,
            cats,
            "END:VJOURNAL","END:VCALENDAR"
          ].filter(Boolean).join("\r\n") + "\r\n";
          await c.updateCalendarObject({ calendarObject: { ...obj, data: ics } });
          return { updated: true, calendar: cal.displayName, uid: input.uid };
        }
      }
    }
    throw new Error(`Note-UID nicht gefunden: ${input.uid}`);
  }

  if (name === "note_delete") {
    if (MODE !== "write") throw new Error(`CALDAV_MODE=${MODE} — Schreiben nicht erlaubt`);
    if (!input?.uid) throw new Error("uid erforderlich");
    const cals = await calendars();
    const c = await client();
    for (const cal of cals) {
      const objects = await fetchByComponent(cal.url, "VJOURNAL");
      for (const obj of objects) {
        const n = noteToJson(obj);
        if (n && n.uid === input.uid) {
          await c.deleteCalendarObject({ calendarObject: obj });
          return { deleted: true, calendar: cal.displayName, uid: input.uid };
        }
      }
    }
    throw new Error(`Note-UID nicht gefunden: ${input.uid}`);
  }

  if (name === "calendar_delete") {
    if (MODE !== "write") throw new Error(`CALDAV_MODE=${MODE} — Löschen nicht erlaubt`);
    if (!input?.uid) throw new Error("uid erforderlich");
    const cals = await calendars();
    const c = await client();
    // Such über alle Kalender und alle Komponenten (VEVENT + VTODO + VJOURNAL)
    const auth = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
    for (const cal of cals) {
      for (const comp of ["VEVENT", "VTODO", "VJOURNAL"]) {
        let objects;
        try { objects = await fetchByComponent(cal.url, comp); } catch { continue; }
        for (const obj of objects) {
          // UID aus dem Roh-ICS rauslesen
          const m = normalizeIcs(obj.data).match(/UID:([^\r\n]+)/i);
          if (m && m[1].trim() === input.uid) {
            // Direkt mit DELETE löschen (etag wäre nice, geht aber auch ohne)
            const r = await fetch(obj.url, { method: "DELETE", headers: { "Authorization": auth } });
            if (!r.ok) throw new Error(`DELETE failed: HTTP ${r.status}`);
            return { deleted: true, calendar: cal.displayName, component: comp, uid: input.uid };
          }
        }
      }
    }
    throw new Error(`UID nicht gefunden: ${input.uid}`);
  }

  throw new Error(`unknown: ${name}`);
}

// Probe-Funktion für Settings-Test-Button
export async function probe() {
  try {
    const cals = await calendars();
    return {
      ok: true,
      url: serverUrl(),
      mode: MODE,
      calendars: cals.map(c => ({ name: c.displayName, url: c.url }))
    };
  } catch (err) {
    return { ok: false, error: err.message, url: URL_RAW, user: USER };
  }
}
