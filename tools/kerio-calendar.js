const { DAVClient } = require("tsdav");
const { getKerioConfig } = require("./kerio-config");

const definitions = [
  {
    name: "calendar_list",
    description:
      "Listet Termine aus dem Kerio-Kalender für die nächsten X Tage auf. Zeigt Titel, Datum/Uhrzeit und UID.",
    input_schema: {
      type: "object",
      properties: {
        days: {
          type: "number",
          description: "Anzahl Tage in die Zukunft (Standard: 7)",
        },
      },
      required: [],
    },
  },
  {
    name: "calendar_add",
    description:
      "Erstellt einen neuen Termin im Kerio-Kalender. Start und Ende als ISO-8601 String.",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Titel des Termins",
        },
        start: {
          type: "string",
          description:
            "Startzeit als ISO-8601 (z.B. 2026-02-23T10:00:00+01:00)",
        },
        end: {
          type: "string",
          description:
            "Endzeit als ISO-8601 (z.B. 2026-02-23T11:00:00+01:00)",
        },
        description: {
          type: "string",
          description: "Optionale Beschreibung des Termins",
        },
      },
      required: ["title", "start", "end"],
    },
  },
  {
    name: "calendar_delete",
    description:
      "Löscht einen Termin aus dem Kerio-Kalender anhand seiner UID.",
    input_schema: {
      type: "object",
      properties: {
        eventUid: {
          type: "string",
          description: "Die UID des zu löschenden Termins",
        },
      },
      required: ["eventUid"],
    },
  },
];

async function getDAVClient() {
  const cfg = getKerioConfig();
  const client = new DAVClient({
    serverUrl: `https://${cfg.host}/caldav/`,
    credentials: { username: cfg.user, password: cfg.password },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
  await client.login();
  return client;
}

// Berlin-Lokalzeit aus einem Date-Objekt als ICS-Datumsstring (ohne Z)
function toICSDateBerlin(isoStr) {
  const hasOffset = /[+-]\d{2}:\d{2}$/.test(isoStr) || isoStr.endsWith("Z");

  if (hasOffset) {
    // ISO mit Offset – korrekt parsen und nach Berlin konvertieren
    const d = new Date(isoStr);
    const parts = {};
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .formatToParts(d)
      .forEach((p) => (parts[p.type] = p.value));
    const h = parts.hour === "24" ? "00" : parts.hour;
    return `${parts.year}${parts.month}${parts.day}T${h}${parts.minute}${parts.second}`;
  }

  // Kein Offset – bereits Lokalzeit, nur umformatieren
  return isoStr.replace(/[-:]/g, "").replace(/\.\d+$/, "");
}

// Berlin-Lokalzeit (YYYYMMDDTHHMMSS) → UTC Date-Objekt
function berlinToUTC(year, month, day, hour, minute, second) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const parts = {};
  new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(new Date(guess))
    .forEach((p) => (parts[p.type] = parseInt(p.value)));

  const h = parts.hour === 24 ? 0 : parts.hour;
  const berlinAsUTC = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    h,
    parts.minute,
    parts.second
  );
  const offset = berlinAsUTC - guess;
  return new Date(guess - offset);
}

function parseICS(icsData) {
  const getLine = (key) => {
    const match = icsData.match(
      new RegExp(`(${key}[^:]*):(.+?)(?:\\r\\n|\\r|\\n)`, "i")
    );
    return match ? { params: match[1], value: match[2].trim() } : null;
  };

  const get = (key) => {
    const line = getLine(key);
    return line ? line.value : null;
  };

  const parseDate = (lineInfo) => {
    if (!lineInfo || !lineInfo.value) return null;
    const val = lineInfo.value;

    const m = val.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
    if (m) {
      // Kerio speichert alle Zeiten als Anzeigezeit (Berlin) – Z ignorieren
      return berlinToUTC(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
    }

    // Ganztägig: YYYYMMDD
    const d = val.match(/(\d{4})(\d{2})(\d{2})/);
    if (d) return new Date(Date.UTC(+d[1], +d[2] - 1, +d[3]));
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

function generateUID() {
  return `jarvis-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

// Kein VTIMEZONE – Kerio arbeitet mit Floating Time (= Serverzeit Berlin)

async function execute(name, input) {
  try {
    switch (name) {
      case "calendar_list": {
        const days = input.days || 7;
        const client = await getDAVClient();

        const calendars = await client.fetchCalendars();
        if (calendars.length === 0) {
          return "Kein Kalender gefunden.";
        }

        const now = new Date();
        const future = new Date();
        future.setDate(future.getDate() + days);

        const allEvents = [];

        for (const cal of calendars) {
          const objects = await client.fetchCalendarObjects({
            calendar: cal,
            timeRange: {
              start: now.toISOString(),
              end: future.toISOString(),
            },
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
        }

        if (allEvents.length === 0) {
          return `Keine Termine in den nächsten ${days} Tagen.`;
        }

        allEvents.sort((a, b) => a.dtstart - b.dtstart);

        const lines = allEvents.map((e) => {
          const dt = e.dtstart.toLocaleString("de-DE", {
            weekday: "short",
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "Europe/Berlin",
          });
          return `• ${dt} – ${e.summary} [UID: ${e.uid}]`;
        });

        return `📅 ${allEvents.length} Termine (nächste ${days} Tage):\n${lines.join("\n")}`;
      }

      case "calendar_add": {
        const client = await getDAVClient();
        const calendars = await client.fetchCalendars();

        if (calendars.length === 0) {
          return "❌ Kein Kalender gefunden.";
        }

        const uid = generateUID();
        const dtstart = toICSDateBerlin(input.start);
        const dtend = toICSDateBerlin(input.end);
        const now = new Date()
          .toISOString()
          .replace(/[-:]/g, "")
          .replace(/\.\d{3}/, "");

        let ics = [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "PRODID:-//JARVIS//Kerio//DE",
          "BEGIN:VEVENT",
          `UID:${uid}`,
          `DTSTAMP:${now}`,
          `DTSTART:${dtstart}Z`,
          `DTEND:${dtend}Z`,
          `SUMMARY:${input.title}`,
        ];

        if (input.description) {
          ics.push(`DESCRIPTION:${input.description}`);
        }

        ics.push("END:VEVENT", "END:VCALENDAR");

        await client.createCalendarObject({
          calendar: calendars[0],
          filename: `${uid}.ics`,
          iCalString: ics.join("\r\n"),
        });

        const startStr = new Date(input.start).toLocaleString("de-DE", {
          timeZone: "Europe/Berlin",
        });

        return `✅ Termin erstellt: "${input.title}" am ${startStr} [UID: ${uid}]`;
      }

      case "calendar_delete": {
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
