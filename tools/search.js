const definitions = [
  {
    name: "web_search",
    description:
      "Sucht im Web via DuckDuckGo. Gibt Top-Ergebnisse mit Titel, URL und Snippet zurück. " +
      "Nutze dies für aktuelle Informationen, Recherche, Faktenprüfung.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Suchanfrage",
        },
      },
      required: ["query"],
    },
  },
];

async function execute(name, input) {
  const { query } = input;

  try {
    const resp = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        },
      }
    );
    const html = await resp.text();

    const results = [];
    const regex =
      /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRegex =
      /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    let match;
    while ((match = regex.exec(html)) && results.length < 5) {
      const snippetMatch = snippetRegex.exec(html);
      const rawUrl = match[1];
      // DuckDuckGo wraps URLs in redirect – extract actual URL
      const urlMatch = rawUrl.match(/uddg=([^&]+)/);
      const url = urlMatch
        ? decodeURIComponent(urlMatch[1])
        : rawUrl;

      results.push({
        title: match[2].replace(/<[^>]*>/g, "").trim(),
        url,
        snippet: snippetMatch
          ? snippetMatch[1].replace(/<[^>]*>/g, "").trim()
          : "",
      });
    }

    if (results.length === 0) {
      return `Keine Ergebnisse für "${query}".`;
    }

    return results
      .map(
        (r, i) =>
          `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
      )
      .join("\n\n");
  } catch (error) {
    return `Suchfehler: ${error.message}`;
  }
}

module.exports = { definitions, execute };
