const axios = require('axios');

const definitions = [
  {
    name: "feiertage_abfragen",
    description: "Fragt deutsche Feiertage von der API ab. Gibt Feiertage für ein bestimmtes Jahr zurück, optional gefiltert nach Bundesländern.",
    input_schema: {
      type: "object",
      properties: {
        jahr: { type: "integer", description: "Das Jahr für die Feiertage (z.B. 2025)" },
        bundeslaender: { type: "array", items: { type: "string" }, description: "Array von Bundesländern (z.B. ['NW', 'BY']) oder 'alle' für alle Bundesländer. Mögliche Werte: BW, BY, BE, BB, HB, HH, HE, MV, NI, NW, RP, SL, SN, ST, SH, TH" },
      },
      required: ["jahr"],
    },
  },
];

async function execute(name, input) {
  switch (name) {
    case "feiertage_abfragen": {
      try {
        const { jahr, bundeslaender } = input;
        
        if (!jahr) {
          return "❌ Fehler: Das Jahr ist erforderlich.";
        }
        
        const params = { year: jahr };
        
        if (bundeslaender && bundeslaender !== 'alle') {
          if (Array.isArray(bundeslaender)) {
            params.states = bundeslaender.join(',');
          }
        }
        
        const response = await axios.get('https://get.api-feiertage.de/', {
          params,
          timeout: 10000,
        });
        
        const daten = response.data;
        
        if (!daten || Object.keys(daten).length === 0) {
          return "Keine Feiertagsdaten für das angegebene Jahr gefunden.";
        }
        
        let ergebnis = `📅 Feiertage für ${jahr}:\n`;
        ergebnis += "═══════════════════════════════\n\n";
        
        for (const [name, datenFeiertag] of Object.entries(daten)) {
          if (typeof datenFeiertag === 'object' && datenFeiertag.date) {
            ergebnis += `• ${name}: ${datenFeiertag.date}\n`;
            if (datenFeiertag.comment) {
              ergebnis += `  └─ ${datenFeiertag.comment}\n`;
            }
          }
        }
        
        return ergebnis.trim();
        
      } catch (fehler) {
        if (fehler.response) {
          return `❌ Fehler: API antwortete mit Status ${fehler.response.status}`;
        } else if (fehler.request) {
          return "❌ Fehler: Keine Antwort von der API erhalten.";
        } else {
          return `❌ Fehler: ${fehler.message}`;
        }
      }
    }
    default:
      return "Unbekanntes Tool: " + name;
  }
}

module.exports = { definitions, execute };