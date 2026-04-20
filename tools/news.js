// News Aggregator Tool — Dynamisch konfigurierbare APIs + RSS Feeds
// Quellen werden über DB (news_sources) verwaltet, UI unter /news im Monitor

const db = require('../lib/db');

const HN_API = 'https://hacker-news.firebaseio.com/v0';

// ============================================================
// Helper
// ============================================================

async function fetchJSON(url, options = {}) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), ...options });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

async function fetchText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { text: await res.text() };
  } catch (e) {
    return { error: e.message };
  }
}

// ============================================================
// RSS Parser (minimalistisch, kein Extra-Package)
// ============================================================

function parseRSS(xml) {
  const items = [];
  // Beide Formate: RSS 2.0 (<item>) und Atom (<entry>)
  const itemRegex = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const get = (tag) => {
      // Versuche verschiedene Tag-Formate
      const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'))
        || block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return m ? m[1].trim() : '';
    };
    // Atom: <link href="..."/> vs RSS: <link>...</link>
    let link = get('link');
    if (!link) {
      const linkMatch = block.match(/<link[^>]+href=["']([^"']+)["']/i);
      if (linkMatch) link = linkMatch[1];
    }
    items.push({
      title: get('title').replace(/<[^>]+>/g, ''),
      description: get('description').replace(/<[^>]+>/g, '').substring(0, 300),
      url: link,
      publishedAt: get('pubDate') || get('published') || get('updated') || '',
      source: get('source') || get('dc:creator') || '',
    });
  }
  return items;
}

// ============================================================
// API Fetcher — Kennt verschiedene API-Formate
// ============================================================

// Bekannte API-Adapter
const API_ADAPTERS = {
  newsapi: {
    // NewsAPI.org
    async fetch(source, { limit = 10, category, query, language = 'de' } = {}) {
      const baseUrl = source.url.replace(/\/+$/, '');
      let url;
      if (query) {
        url = `${baseUrl}/everything?q=${encodeURIComponent(query)}&language=${language}&sortBy=publishedAt&pageSize=${limit}&apiKey=${source.api_key}`;
      } else {
        url = `${baseUrl}/top-headlines?country=de&category=${category || source.category || 'general'}&pageSize=${limit}&apiKey=${source.api_key}`;
      }
      const data = await fetchJSON(url);
      if (data.error) return { error: data.error };
      return (data.articles || []).filter(a => a.title && a.url).map(a => ({
        source: a.source?.name || source.name,
        title: a.title,
        description: a.description || '',
        url: a.url,
        publishedAt: a.publishedAt || '',
      }));
    }
  },

  newsdata: {
    // NewsData.io
    async fetch(source, { limit = 10, query, language = 'de' } = {}) {
      const baseUrl = source.url.replace(/\/+$/, '');
      let url = `${baseUrl}/news?apikey=${source.api_key}&language=${language}`;
      if (query) url += `&q=${encodeURIComponent(query)}`;
      else if (source.category && source.category !== 'general') url += `&category=${source.category}`;
      const data = await fetchJSON(url);
      if (data.error) return { error: data.error };
      return (data.results || []).filter(a => a.title).slice(0, limit).map(a => ({
        source: a.source_id || source.name,
        title: a.title,
        description: a.description || '',
        url: a.link || '',
        publishedAt: a.pubDate || '',
      }));
    }
  },

  hackernews: {
    // Hacker News (kein Key nötig)
    async fetch(source, { limit = 10 } = {}) {
      const top = await fetchJSON(`${HN_API}/topstories.json`);
      if (top.error) return { error: top.error };
      const stories = await Promise.all(
        top.slice(0, limit).map(id => fetchJSON(`${HN_API}/item/${id}.json`))
      );
      return stories.filter(s => s && s.title).map(s => ({
        source: 'Hacker News',
        title: s.title,
        description: `${s.score} Punkte • ${s.by} • ${s.descendants || 0} Kommentare`,
        url: s.url || `https://news.ycombinator.com/item?id=${s.id}`,
        publishedAt: new Date(s.time * 1000).toISOString(),
        comments: `https://news.ycombinator.com/item?id=${s.id}`,
      }));
    }
  },

  generic: {
    // Generische JSON API — Config bestimmt Pfade
    // config: { headers: {}, resultPath: "articles", titleField: "title", urlField: "url", descField: "description", dateField: "publishedAt" }
    async fetch(source, { limit = 10, query } = {}) {
      const cfg = source.config || {};
      let url = source.url;
      if (query) url += (url.includes('?') ? '&' : '?') + `q=${encodeURIComponent(query)}`;

      const headers = { ...(cfg.headers || {}) };
      if (source.api_key) headers['Authorization'] = `Bearer ${source.api_key}`;

      const data = await fetchJSON(url, { headers });
      if (data.error) return { error: data.error };

      // Ergebnis-Array finden
      const path = cfg.resultPath || '';
      let results = data;
      if (path) {
        for (const key of path.split('.')) {
          results = results?.[key];
        }
      }
      if (!Array.isArray(results)) return { error: 'Kein Array in API-Antwort gefunden' };

      return results.slice(0, limit).map(item => ({
        source: source.name,
        title: item[cfg.titleField || 'title'] || '',
        description: (item[cfg.descField || 'description'] || '').substring(0, 300),
        url: item[cfg.urlField || 'url'] || item[cfg.urlField || 'link'] || '',
        publishedAt: item[cfg.dateField || 'publishedAt'] || '',
      }));
    }
  },
};

// ============================================================
// Fetch von einer Quelle (API oder RSS)
// ============================================================

async function fetchSource(source, options = {}) {
  try {
    if (source.type === 'rss') {
      const result = await fetchText(source.url);
      if (result.error) return { source: source.name, error: result.error, articles: [] };
      const articles = parseRSS(result.text).slice(0, options.limit || 10);
      // Source-Name setzen wenn leer
      articles.forEach(a => { if (!a.source) a.source = source.name; });
      return { source: source.name, articles };
    }

    // API — Adapter bestimmen
    const adapterName = source.config?.adapter || 'generic';
    const adapter = API_ADAPTERS[adapterName];
    if (!adapter) return { source: source.name, error: `Unbekannter Adapter: ${adapterName}`, articles: [] };

    const articles = await adapter.fetch(source, options);
    if (articles.error) return { source: source.name, error: articles.error, articles: [] };
    return { source: source.name, articles };
  } catch (e) {
    return { source: source.name, error: e.message, articles: [] };
  }
}

// ============================================================
// Tool Definitions
// ============================================================

const definitions = [
  {
    name: 'news_fetch',
    description: 'Holt aktuelle Nachrichten. Ohne Parameter: alle aktivierten Quellen. Mit source_id: nur eine bestimmte Quelle. Mit category: nur Quellen dieser Kategorie.',
    input_schema: {
      type: 'object',
      properties: {
        source_id: { type: 'number', description: 'ID einer bestimmten Quelle (optional)' },
        category: { type: 'string', description: 'Nur Quellen dieser Kategorie (optional)' },
        limit: { type: 'number', description: 'Artikel pro Quelle (Standard: 5)' },
        query: { type: 'string', description: 'Suchbegriff (nur bei APIs die Suche unterstützen)' },
      }
    }
  },
  {
    name: 'news_search',
    description: 'Sucht nach Nachrichten zu einem Thema über alle konfigurierten API-Quellen.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Suchbegriff' },
        language: { type: 'string', description: 'Sprache: de, en (Standard: de)' },
        limit: { type: 'number', description: 'Ergebnisse pro Quelle (Standard: 5)' },
      },
      required: ['query']
    }
  },
  {
    name: 'news_sources',
    description: 'Listet alle konfigurierten News-Quellen (APIs und RSS Feeds).',
    input_schema: {
      type: 'object',
      properties: {}
    }
  },
];

// ============================================================
// Execute
// ============================================================

async function execute(name, input) {
  switch (name) {
    case 'news_fetch': {
      const { source_id, category, limit = 5, query } = input;
      let sources;

      if (source_id) {
        const src = db.newsSources.getById(source_id);
        if (!src) return { error: `Quelle #${source_id} nicht gefunden` };
        sources = [src];
      } else if (category) {
        sources = db.newsSources.getEnabled().filter(s => s.category === category);
      } else {
        sources = db.newsSources.getEnabled();
      }

      if (sources.length === 0) {
        return { error: 'Keine News-Quellen konfiguriert. Quellen können unter /news im Monitor angelegt werden.' };
      }

      const results = await Promise.all(
        sources.map(src => fetchSource(src, { limit, query }))
      );

      return {
        status: query ? `News-Suche: "${query}"` : 'Aktuelle Nachrichten',
        sources_queried: results.length,
        results,
      };
    }

    case 'news_search': {
      const { query, language = 'de', limit = 5 } = input;
      // Nur API-Quellen (RSS unterstützt keine Suche)
      const sources = db.newsSources.getByType('api');

      if (sources.length === 0) {
        return { error: 'Keine API-Quellen konfiguriert. Quellen können unter /news im Monitor angelegt werden.' };
      }

      const results = await Promise.all(
        sources.map(src => fetchSource(src, { limit, query, language }))
      );

      return {
        status: `Suche: "${query}"`,
        results: results.filter(r => r.articles.length > 0 || r.error),
      };
    }

    case 'news_sources': {
      const all = db.newsSources.getAll();
      return {
        total: all.length,
        enabled: all.filter(s => s.enabled).length,
        sources: all.map(s => ({
          id: s.id, type: s.type, name: s.name, category: s.category,
          enabled: s.enabled, url: s.url,
          adapter: s.config?.adapter || (s.type === 'rss' ? 'rss' : 'generic'),
        })),
      };
    }

    default:
      throw new Error(`Unknown function: ${name}`);
  }
}

module.exports = { definitions, execute };
