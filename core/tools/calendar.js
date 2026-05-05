// calendar.js — CalDAV (Kerio Connect, Nextcloud, iCloud, Google etc.)
// Auto-Discovery via tsdav. iCal-Parsing via ical.js.

import { createDAVClient } from "tsdav";
import ICAL from "ical.js";

const URL_RAW = process.env.CALDAV_URL || "";
const USER    = process.env.CALDAV_USER || "";
const PASS    = process.env.CALDAV_PASS || "";
const MODE    = (process.env.CALDAV_MODE || "read").toLowerCase();  // read | write | off

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
  if (!hint) {
    // Bevorzuge "Calendar"/"Standard"/erstes Schreib-Kalender
    return cals.find(c => /calendar|standard|default|kalender/i.test(c.displayName || "")) || cals[0];
  }
  return cals.find(c => (c.displayName || "").toLowerCase().includes(hint.toLowerCase())) || cals[0];
}

function fmtDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function normalizeIcs(s) {
  // Manche Server (Kerio) liefern Bare-CR statt CRLF. Normalisiere beides → \r\n
  return String(s || "").replace(/\r\n|\r|\n/g, "\r\n");
}

function eventToJson(event) {
  try {
    const jcal = ICAL.parse(normalizeIcs(event.data));
    const comp = new ICAL.Component(jcal);
    const vevent = comp.getFirstSubcomponent("vevent");
    if (!vevent) return null;
    const e = new ICAL.Event(vevent);
    return {
      uid:        e.uid,
      summary:    e.summary || "",
      description: e.description || "",
      location:   e.location || "",
      start:      e.startDate?.toJSDate()?.toISOString() || null,
      end:        e.endDate?.toJSDate()?.toISOString() || null,
      allDay:     e.startDate?.isDate || false,
      url:        event.url
    };
  } catch (err) {
    return { uid: null, error: err.message, raw: event.data?.substring(0, 200) };
  }
}

function buildICS({ summary, description = "", location = "", start, end, allDay = false }) {
  const dtstart = new Date(start);
  const dtend   = new Date(end || (dtstart.getTime() + 60*60*1000));
  if (isNaN(dtstart.getTime())) throw new Error("start ungültig");
  if (isNaN(dtend.getTime())) throw new Error("end ungültig");
  const fmt = (d) => allDay
    ? d.toISOString().substring(0,10).replace(/-/g,"")
    : d.toISOString().replace(/[-:]/g,"").split(".")[0] + "Z";
  const uid = `kiasy-${Date.now()}-${Math.random().toString(36).slice(2,10)}@kiasy`;
  const stamp = fmt(new Date());
  const dt = allDay
    ? `DTSTART;VALUE=DATE:${fmt(dtstart)}\r\nDTEND;VALUE=DATE:${fmt(dtend)}`
    : `DTSTART:${fmt(dtstart)}\r\nDTEND:${fmt(dtend)}`;
  const esc = s => String(s||"").replace(/\\/g,"\\\\").replace(/\n/g,"\\n").replace(/,/g,"\\,").replace(/;/g,"\\;");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//kiasy//calendar//DE",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    dt,
    `SUMMARY:${esc(summary)}`,
    description ? `DESCRIPTION:${esc(description)}` : null,
    location    ? `LOCATION:${esc(location)}`       : null,
    "END:VEVENT",
    "END:VCALENDAR"
  ].filter(Boolean).join("\r\n") + "\r\n";
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
    description: "Erstellt einen neuen Kalender-Eintrag. Default-Dauer 1h wenn end fehlt.",
    input_schema: {
      type: "object",
      properties: {
        summary:     { type: "string", description: "Titel des Termins" },
        start:       { type: "string", description: "ISO-DateTime, z.B. 2026-05-06T14:00:00" },
        end:         { type: "string", description: "ISO-DateTime (optional, sonst start+1h)" },
        location:    { type: "string", description: "Ort (optional)" },
        description: { type: "string", description: "Beschreibung (optional)" },
        allDay:      { type: "boolean", description: "Ganztägig (default false)" },
        calendar:    { type: "string", description: "Kalender-Name (substring match, optional)" }
      },
      required: ["summary", "start"]
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
    const result = await c.createCalendarObject({
      calendar: cal,
      filename,
      iCalString: ics
    });
    return { created: true, calendar: cal.displayName, filename, status: result.status, url: result.url };
  }

  if (name === "calendar_delete") {
    if (MODE !== "write") throw new Error(`CALDAV_MODE=${MODE} — Löschen nicht erlaubt`);
    if (!input?.uid) throw new Error("uid erforderlich");
    const cals = await calendars();
    const c = await client();
    // Such Event über alle Kalender
    for (const cal of cals) {
      const objects = await c.fetchCalendarObjects({ calendar: cal });
      for (const obj of objects) {
        const e = eventToJson(obj);
        if (e && e.uid === input.uid) {
          await c.deleteCalendarObject({ calendarObject: obj });
          return { deleted: true, calendar: cal.displayName, uid: input.uid };
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
