// web-browse.js — Webseiten lesen, Text + Links extrahieren

import { load as loadHtml } from "cheerio";

const MAX_CONTENT = 10_000;
const UA = "Mozilla/5.0 (kiasy v2)";

export const definitions = [
  {
    name: "web_read",
    description: "Liest eine Webseite und gibt den Textinhalt zurück. Entfernt HTML/Scripts/Styles. Optional CSS-Selector für Teil-Extraktion.",
    input_schema: {
      type: "object",
      properties: {
        url:      { type: "string" },
        selector: { type: "string", description: "CSS-Selector, z.B. 'article'" }
      },
      required: ["url"]
    }
  },
  {
    name: "web_links",
    description: "Extrahiert alle Links einer Webseite (href + sichtbarer Text).",
    input_schema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"]
    }
  }
];

async function fetchHtml(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(15_000)
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} für ${url}`);
  return await r.text();
}

export async function execute(name, input) {
  if (!input?.url) throw new Error("url erforderlich");
  const html = await fetchHtml(input.url);
  const $ = loadHtml(html);

  if (name === "web_read") {
    $("script, style, noscript, iframe").remove();
    const target = input.selector ? $(input.selector) : $("body");
    let text = target.text().replace(/\s+/g, " ").trim();
    if (text.length > MAX_CONTENT) text = text.substring(0, MAX_CONTENT) + "…";
    return { url: input.url, title: $("title").text().trim(), length: text.length, content: text };
  }

  if (name === "web_links") {
    const links = [];
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      const text = $(el).text().trim().replace(/\s+/g, " ");
      if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
        links.push({ href, text: text.substring(0, 100) });
      }
    });
    return { url: input.url, count: links.length, links: links.slice(0, 100) };
  }

  throw new Error(`unknown: ${name}`);
}
