// Web-Browse Tool – Webseiten lesen, Text extrahieren, Links auflisten
const axios = require("axios");
const https = require("https");
const cheerio = require("cheerio");

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const MAX_CONTENT = 8000; // Max Zeichen für Antwort

const definitions = [
  {
    name: "web_read",
    description:
      "Liest eine Webseite und gibt den Textinhalt zurück. Entfernt HTML, Scripts, Styles. " +
      "Nützlich um Artikel, Dokumentationen, Blog-Posts oder andere Webinhalte zu lesen.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL der Webseite (z.B. https://example.com)" },
        selector: {
          type: "string",
          description: "Optionaler CSS-Selektor um nur einen Teil der Seite zu extrahieren (z.B. 'article', '.content', '#main')",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "web_links",
    description:
      "Listet alle Links einer Webseite auf. Nützlich um Unterseiten, Navigation oder Downloads zu finden.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL der Webseite" },
        filter: {
          type: "string",
          description: "Optionaler Filter — nur Links die diesen Text enthalten (z.B. 'download', '.pdf')",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "web_extract",
    description:
      "Extrahiert strukturierte Daten aus einer Webseite per CSS-Selektoren. " +
      "Gibt Text, Attribute oder HTML der gefundenen Elemente zurück.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL der Webseite" },
        selectors: {
          type: "object",
          description: 'Key-Value Paare von Name → CSS-Selektor (z.B. {"title": "h1", "price": ".price", "description": "meta[name=description]@content"}). Mit @attribut ein Attribut statt Text extrahieren.',
        },
      },
      required: ["url", "selectors"],
    },
  },
];

async function fetchPage(url) {
  const resp = await axios.get(url, {
    timeout: 15000,
    maxRedirects: 5,
    headers: {
      "User-Agent": "JARVIS/1.0 (Personal Assistant Bot)",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
    },
    responseType: "text",
    httpsAgent,
  });
  return resp.data;
}

function htmlToText($, element) {
  // Scripts, Styles, Nav, Footer entfernen
  const el = element || $.root();
  el.find("script, style, noscript, nav, footer, iframe, svg, [hidden]").remove();

  let text = el.text();
  // Whitespace normalisieren
  text = text.replace(/[ \t]+/g, " ").replace(/\n\s*\n/g, "\n\n").trim();
  return text;
}

async function execute(name, input) {
  try {
    switch (name) {
      case "web_read": {
        const html = await fetchPage(input.url);
        const $ = cheerio.load(html);

        // Titel
        const title = $("title").text().trim();

        // Meta-Description
        const description = $('meta[name="description"]').attr("content") || "";

        // Text extrahieren
        let text;
        if (input.selector) {
          const selected = $(input.selector);
          if (selected.length === 0) return `Kein Element gefunden für Selektor: ${input.selector}`;
          text = htmlToText($, selected);
        } else {
          // Versuche zuerst article/main, dann body
          const mainContent = $("article, main, [role=main], .content, .post-content, .entry-content").first();
          if (mainContent.length > 0) {
            text = htmlToText($, mainContent);
          } else {
            text = htmlToText($);
          }
        }

        // Kürzen falls zu lang
        if (text.length > MAX_CONTENT) {
          text = text.substring(0, MAX_CONTENT) + "\n\n[... gekürzt, " + text.length + " Zeichen gesamt]";
        }

        let result = "";
        if (title) result += `# ${title}\n\n`;
        if (description) result += `> ${description}\n\n`;
        result += text;

        return result || "Keine Textinhalte auf dieser Seite gefunden.";
      }

      case "web_links": {
        const html = await fetchPage(input.url);
        const $ = cheerio.load(html);
        const baseUrl = new URL(input.url);

        const links = [];
        $("a[href]").each((_, el) => {
          let href = $(el).attr("href") || "";
          const text = $(el).text().trim().substring(0, 100);
          if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;

          // Relative URLs auflösen
          try {
            href = new URL(href, baseUrl).href;
          } catch { return; }

          // Filter anwenden
          if (input.filter) {
            const f = input.filter.toLowerCase();
            if (!href.toLowerCase().includes(f) && !text.toLowerCase().includes(f)) return;
          }

          // Duplikate vermeiden
          if (!links.find((l) => l.url === href)) {
            links.push({ url: href, text: text || "(kein Text)" });
          }
        });

        if (links.length === 0) return "Keine Links gefunden" + (input.filter ? ` für Filter "${input.filter}"` : "") + ".";

        const maxLinks = 50;
        const shown = links.slice(0, maxLinks);
        let result = `${links.length} Links gefunden:\n\n`;
        result += shown.map((l) => `- [${l.text}](${l.url})`).join("\n");
        if (links.length > maxLinks) result += `\n\n... und ${links.length - maxLinks} weitere`;

        return result;
      }

      case "web_extract": {
        const html = await fetchPage(input.url);
        const $ = cheerio.load(html);

        const results = {};
        for (const [key, selector] of Object.entries(input.selectors)) {
          // @attribut Syntax: "meta[name=description]@content" → attr("content")
          const attrMatch = selector.match(/^(.+)@(\w+)$/);
          if (attrMatch) {
            const [, sel, attr] = attrMatch;
            const el = $(sel).first();
            results[key] = el.length > 0 ? el.attr(attr) || "" : "(nicht gefunden)";
          } else {
            const el = $(selector);
            if (el.length === 0) {
              results[key] = "(nicht gefunden)";
            } else if (el.length === 1) {
              results[key] = el.text().trim().substring(0, 1000);
            } else {
              results[key] = [];
              el.each((i, e) => {
                if (i < 20) results[key].push($(e).text().trim().substring(0, 200));
              });
            }
          }
        }

        return JSON.stringify(results, null, 2);
      }

      default:
        return "Unbekanntes Web-Tool: " + name;
    }
  } catch (err) {
    if (err.response) {
      return `HTTP-Fehler ${err.response.status}: ${err.response.statusText} für ${input.url}`;
    }
    return `Fehler beim Laden von ${input.url}: ${err.message}`;
  }
}

module.exports = { definitions, execute };
