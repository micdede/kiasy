// Standard Kalender Tool (CalDAV) — funktioniert mit Google, iCloud, Nextcloud, etc.
// Berechtigungen über .env: CALDAV_MODE (read oder readwrite)
const { DAVClient } = require("tsdav");

// --- Konfiguration ---

function getConfig() {
  const url = process.env.CALDAV_URL;
  const user = process.env.CALDAV_USER;
  const pass = process.env.CALDAV_PASSWORD;
  if (!url || !user || !pass) throw new Error("Kalender nicht konfiguriert. Setze CALDAV_URL, CALDAV_USER und CALDAV_PASSWORD in .env");
  return { url, user, pass, mode: (process.env.CALDAV_MODE || "read").toLowerCase() };
}

function canWrite() {
  return getConfig().mode === "readwrite";
}

// --- CalDAV Client ---

async function getDAVClient() {
  const cfg = getConfig();
  const client = new DAVClient({
    serverUrl: cfg.url,
    credentials: { username: cfg.user, password: cfg.pass },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
  await client.login();
  return client;
}

// --- ICS Parser ---

function parseICS(icsData) {
  const TZ = process.env.TZ || "Europe/Berlin";

  const getLine = (key) => {
    const match = icsData.match(new RegExp(`(${key}[^:]*):(.+?)(?:\\r\\n|\\r|\\n)`, "i"));
    return match ? { params: match[1], value: match[2].trim() } : null;
  };

  const get = (key) => {
    const line = getLine(key);
    return line ? line.value : null;
  };

  const parseDate = (lineInfo) => {
    if (!lineInfo || !lineInfo.value) return null;
    const val = lineInfo.value;

    // YYYYMMDDTHHMMSS(Z)
    const m = val.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
    if (m) {
      if (val.endsWith("Z")) {
        return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
      }
      // Floating time — interpretieren als TZ
      return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
    }

    // Ganztägig: YYYYMMDD
    const d = val.match(/(\d{4})(\d{2})(\d{2})/);
    if (d) return new Date(+d[1], +d[2] - 1, +d[3]);
    return null;
  };

  return {
    uid: get("UID"),
    summary: get("SUMMARY"),
    dtstart: parseDate(getLine("DTSTART")),
    dtend: parseDate(getLine("DTEND")),
    description: get("DESCRIPTION"),
  };
}

function toICSDate(isoStr) {
  const d = new Date(isoStr);
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function generateUID() {
  return `kiasy-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

// --- Tool-Definitionen ---

const definitions = [
  {
    name: "cal_list",
    description: "Listet Termine aus dem Kalender für die nächsten X Tage auf.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Anzahl Tage in die Zukunft (Standard: 7)" },
      },
    },
  },
  {
    name: "cal_add",
    description: "Erstellt einen neuen Kalendertermin. Braucht CALDAV_MODE=readwrite in .env.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Titel des Termins" },
        start: { type: "string", description: "Startzeit als ISO-8601 (z.B. 2026-03-28T10:00:00)" },
        end: { type: "string", description: "Endzeit als ISO-8601 (z.B. 2026-03-28T11:00:00)" },
        description: { type: "string", description: "Optionale Beschreibung" },
      },
      required: ["title", "start", "end"],
    },
  },
  {
    name: "cal_delete",
    description: "Löscht einen Kalendertermin anhand seiner UID. Braucht CALDAV_MODE=readwrite in .env.",
    input_schema: {
      type: "object",
      properties: {
        eventUid: { type: "string", description: "Die UID des zu löschenden Termins" },
      },
      required: ["eventUid"],
    },
  },
];

// --- Ausführung ---

async function execute(name, input) {
  try {
    const TZ = process.env.TZ || "Europe/Berlin";

    switch (name) {
      case "cal_list": {
        const days = input.days || 7;
        const client = await getDAVClient();
        const calendars = await client.fetchCalendars();
        if (calendars.length === 0) return "Kein Kalender gefunden.";

        const now = new Date();
        const future = new Date();
        future.setDate(future.getDate() + days);

        const allEvents = [];
        for (const cal of calendars) {
          try {
            const objects = await client.fetchCalendarObjects({
              calendar: cal,
              timeRange: { start: now.toISOString(), end: future.toISOString() },
            });
            for (const obj of objects) {
              if (!obj.data) continue;
              const parsed = parseICS(obj.data);
              if (parsed.summary && parsed.dtstart) {
                if (parsed.dtstart >= now && parsed.dtstart <= future) {
                  allEvents.push(parsed);
                }
              }
            }
          } catch {} // Manche Kalender unterstützen timeRange nicht
        }

        if (allEvents.length === 0) return `Keine Termine in den nächsten ${days} Tagen.`;

        allEvents.sort((a, b) => a.dtstart - b.dtstart);
        const lines = allEvents.map((e) => {
          const dt = e.dtstart.toLocaleString("de-DE", {
            weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
            timeZone: TZ,
          });
          return `• ${dt} – ${e.summary} [UID: ${e.uid}]`;
        });
        return `📅 ${allEvents.length} Termine (nächste ${days} Tage):\n${lines.join("\n")}`;
      }

      case "cal_add": {
        if (!canWrite()) return "❌ Nicht erlaubt. Setze CALDAV_MODE=readwrite in .env";

        const client = await getDAVClient();
        const calendars = await client.fetchCalendars();
        if (calendars.length === 0) return "❌ Kein Kalender gefunden.";

        const uid = generateUID();
        const dtstart = toICSDate(input.start);
        const dtend = toICSDate(input.end);
        const dtstamp = toICSDate(new Date().toISOString());

        let ics = [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "PRODID:-//KIASY//CalDAV//DE",
          "BEGIN:VEVENT",
          `UID:${uid}`,
          `DTSTAMP:${dtstamp}`,
          `DTSTART:${dtstart}`,
          `DTEND:${dtend}`,
          `SUMMARY:${input.title}`,
        ];
        if (input.description) ics.push(`DESCRIPTION:${input.description}`);
        ics.push("END:VEVENT", "END:VCALENDAR");

        await client.createCalendarObject({
          calendar: calendars[0],
          filename: `${uid}.ics`,
          iCalString: ics.join("\r\n"),
        });

        const startStr = new Date(input.start).toLocaleString("de-DE", { timeZone: TZ });
        return `✅ Termin erstellt: "${input.title}" am ${startStr} [UID: ${uid}]`;
      }

      case "cal_delete": {
        if (!canWrite()) return "❌ Nicht erlaubt. Setze CALDAV_MODE=readwrite in .env";

        const client = await getDAVClient();
        const calendars = await client.fetchCalendars();

        for (const cal of calendars) {
          const objects = await client.fetchCalendarObjects({ calendar: cal });
          for (const obj of objects) {
            if (!obj.data) continue;
            const parsed = parseICS(obj.data);
            if (parsed.uid === input.eventUid) {
              await client.deleteCalendarObject({ calendarObject: obj });
              return `✅ Termin gelöscht (UID: ${input.eventUid})`;
            }
          }
        }
        return `❌ Termin mit UID "${input.eventUid}" nicht gefunden.`;
      }

      default:
        return "Unbekannte Kalender-Operation.";
    }
  } catch (error) {
    return `❌ Kalender-Fehler: ${error.message}`;
  }
}

module.exports = { definitions, execute };
