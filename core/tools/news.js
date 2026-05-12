// news.js — News-Aggregation aus DB-konfigurierten Quellen (RSS + APIs)

import * as db from "../lib/db.js";

export const definitions = [{
  name: "news_fetch",
  description: "Holt aktuelle News aus den konfigurierten Quellen (DB news_sources). Optional Kategorie/Quelle filtern.",
  input_schema: {
    type: "object",
    properties: {
      category: { type: "string", description: "z.B. 'tech', 'world', 'germany'" },
      source:   { type: "string", description: "Name einer spezifischen Quelle" },
      limit:    { type: "integer", default: 10 }
    }
  }
}];

export async function execute(name, input) {
  if (name !== "news_fetch") throw new Error(`unknown: ${name}`);
  const limit = input?.limit || 10;

  let sql = "SELECT * FROM news_sources WHERE enabled = 1";
  const params = [];
  if (input?.category) { sql += " AND category = ?"; params.push(input.category); }
  if (input?.source)   { sql += " AND name = ?";     params.push(input.source); }

  const sources = db.get().prepare(sql).all(...params);
  if (!sources.length) return { count: 0, items: [], note: "Keine passende Quelle in news_sources" };

  const all = [];
  for (const src of sources) {
    try {
      const items = await fetchSource(src);
      for (const it of items) all.push({ source: src.name, ...it });
    } catch (err) {
      console.error(`[news] ${src.name} failed:`, err.message);
    }
  }

  // Sortieren nach Datum, dann limit
  all.sort((a, b) => (b.published || "").localeCompare(a.published || ""));
  return { count: all.length, items: all.slice(0, limit) };
}

async function fetchSource(src) {
  if (src.type === "rss") return fetchRss(src.url);
  if (src.type === "api") {
    if (src.url.includes("hacker-news.firebaseio.com")) return fetchHN();
    if (src.url.includes("newsapi.org"))    return fetchNewsApi(src);
    if (src.url.includes("newsdata.io"))    return fetchNewsdata(src);
  }
  return [];
}

async function fetchRss(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const xml = await r.text();
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRegex.exec(xml)) && items.length < 20) {
    const block = m[1];
    items.push({
      title:     pick(block, /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/),
      url:       pick(block, /<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/),
      published: pick(block, /<pubDate>(.*?)<\/pubDate>/),
      summary:   pick(block, /<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.replace(/<[^>]+>/g, "").substring(0, 300)
    });
  }
  return items;
}

async function fetchHN() {
  const idsR = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json");
  const ids = (await idsR.json()).slice(0, 15);
  const items = await Promise.all(ids.map(id =>
    fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then(r => r.json())
  ));
  return items.filter(Boolean).map(i => ({
    title: i.title, url: i.url || `https://news.ycombinator.com/item?id=${i.id}`,
    published: new Date(i.time * 1000).toISOString(), summary: `${i.score} pts, ${i.descendants||0} Kommentare`
  }));
}

async function fetchNewsApi(src) {
  const key = src.api_key || process.env.NEWS_API_KEY;
  if (!key) return [];
  // top-headlines?country=de liefert 0 Ergebnisse → /everything mit Deutsch-Query
  const base = "https://newsapi.org/v2/everything";
  const r = await fetch(`${base}?apiKey=${key}&pageSize=10&language=de&sortBy=publishedAt&q=Deutschland OR Nachrichten`, { signal: AbortSignal.timeout(10_000) });
  const data = await r.json();
  return (data.articles || []).map(a => ({
    title: a.title, url: a.url, published: a.publishedAt, summary: a.description
  }));
}

async function fetchNewsdata(src) {
  const key = src.api_key || process.env.NEWSDATA_API_KEY;
  if (!key) return [];
  const r = await fetch(`${src.url}?apikey=${key}&country=de&size=10`);
  const data = await r.json();
  return (data.results || []).map(a => ({
    title: a.title, url: a.link, published: a.pubDate, summary: a.description
  }));
}

function pick(text, re) {
  const m = text.match(re);
  return m ? m[1].trim() : null;
}
