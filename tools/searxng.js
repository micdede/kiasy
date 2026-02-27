const axios = require('axios');

const definitions = [
    {
        name: "searxng_search",
        description: "Durchsucht das Web via SearXNG (selbstgehostete Meta-Suchmaschine)",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "Suchanfrage" },
                engines: { type: "string", description: "Optional: Bestimmte Suchmaschinen (kommasepariert)" },
                language: { type: "string", description: "Sprache (z.B. de, en)" },
                safe_search: { type: "number", description: "0=Aus, 1=Moderat, 2=Streng" }
            },
            required: ["query"]
        }
    }
];

async function execute(name, input) {
    if (name !== "searxng_search") return null;

    const { query, engines, language = "de", safe_search = 0 } = input;
    const url = "http://myhass.de:9090/search";

    try {
        const response = await axios.get(url, {
            params: {
                q: query,
                format: "json",
                engines: engines || undefined,
                language,
                safe_search
            },
            timeout: 10000
        });

        const results = response.data.results || [];
        const total = response.data.number_of_results || 0;
        
        if (results.length === 0) {
            return "Keine Ergebnisse gefunden.";
        }

        let output = `${total} Ergebnisse für "${query}":\n\n`;
        
        results.slice(0, 8).forEach((r, i) => {
            const snippet = r.content 
                ? r.content.substring(0, 150) + (r.content.length > 150 ? "..." : "")
                : "Keine Vorschau verfügbar";
            output += `${i + 1}. *${r.title}*\n${snippet}\n🔗 ${r.url}\n\n`;
        });

        return output.trim();
    } catch (error) {
        return `Suchfehler: ${error.message}`;
    }
}

module.exports = { definitions, execute };
