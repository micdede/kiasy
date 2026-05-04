// time.js — aktuelles Datum/Uhrzeit (Europe/Berlin)

export const definitions = [{
  name: "current_time",
  description: "Liefert aktuelles Datum + Uhrzeit in Europe/Berlin (ISO + lesbar). Nutze das, wenn du wissen musst wann 'jetzt' ist.",
  input_schema: {
    type: "object",
    properties: {
      format: {
        type: "string",
        enum: ["iso", "human", "both"],
        description: "Ausgabeformat. Default: both"
      }
    }
  }
}];

export async function execute(name, input) {
  const fmt = input?.format || "both";
  const now = new Date();
  const iso = now.toISOString();
  const human = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit"
  }).format(now);

  if (fmt === "iso")   return { iso };
  if (fmt === "human") return { human };
  return { iso, human };
}
