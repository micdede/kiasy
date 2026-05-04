// search.js — Web-Suche via SearXNG (Container)

const URL = (process.env.SEARXNG_URL || "http://searxng:8080").replace(/\/$/, "");

export const definitions = [{
  name: "web_search",
  description: "Durchsucht das Web via SearXNG. Liefert Titel, URL, Snippet der Top-Treffer.",
  input_schema: {
    type: "object",
    properties: {
      query:    { type: "string" },
      language: { type: "string", default: "de" },
      limit:    { type: "integer", default: 8 }
    },
    required: ["query"]
  }
}];

export async function execute(name, input) {
  if (name !== "web_search") throw new Error(`unknown: ${name}`);
  if (!input?.query) throw new Error("query erforderlich");

  const params = new URLSearchParams({
    q: input.query,
    format: "json",
    language: input.language || "de",
    safesearch: "0"
  });

  const r = await fetch(`${URL}/search?${params}`, {
    signal: AbortSignal.timeout(15_000)
  });
  if (!r.ok) throw new Error(`SearXNG HTTP ${r.status}`);
  const data = await r.json();

  const limit = input.limit || 8;
  const results = (data.results || []).slice(0, limit).map(r => ({
    title:   r.title,
    url:     r.url,
    snippet: (r.content || "").substring(0, 300),
    engine:  r.engine
  }));

  return { query: input.query, count: results.length, results };
}
