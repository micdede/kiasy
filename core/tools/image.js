// image.js — Bild-Generierung via Pollinations.ai (gratis, kein API-Key)
//
// API: GET https://image.pollinations.ai/prompt/{encoded_prompt}?width=…&model=…
// Pollinations liefert das Bild direkt als PNG zurück. Wir speichern es lokal
// in IMAGES_DIR (default /data/images) und returnen eine /api/images/{file}-URL.

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const IMAGES_DIR = process.env.IMAGES_DIR || "/data/images";
const TIMEOUT    = Number(process.env.POLLINATIONS_TIMEOUT_MS) || 90_000;

if (!existsSync(IMAGES_DIR)) {
  try { mkdirSync(IMAGES_DIR, { recursive: true }); } catch (e) {
    console.warn("[image] mkdir failed:", e.message);
  }
}

export const definitions = [{
  name: "image_generate",
  description:
    "Generiert ein KI-Bild via Pollinations.ai (Flux-Modell, kostenlos). " +
    "Gibt eine relative URL zurück, unter der das Bild abrufbar ist (/api/images/...). " +
    "Nutze bei Anfragen wie 'erstell ein Bild von …', 'mach mir ein Bild …', 'zeichne mir …', 'generiere ein Foto von …'. " +
    "Pollinations versteht Englisch besser — übersetze deutsche Prompts intern. " +
    "Antworte dem User danach mit kurzem Text wie 'Hier ist dein Bild:' — die App zeigt es automatisch an.",
  input_schema: {
    type: "object",
    properties: {
      prompt:    { type: "string", description: "Bildbeschreibung (English bevorzugt für beste Qualität)" },
      width:     { type: "number", description: "Pixel-Breite, default 1024" },
      height:    { type: "number", description: "Pixel-Höhe, default 1024" },
      model:     { type: "string", description: "Optional: 'flux' (default), 'turbo', 'flux-realism'" },
      seed:      { type: "number", description: "Optional: Seed für reproduzierbare Ergebnisse" },
      enhance:   { type: "boolean", description: "Optional: Pollinations verbessert den Prompt automatisch" }
    },
    required: ["prompt"]
  }
}];

export async function execute(name, input) {
  if (name !== "image_generate") throw new Error(`unknown: ${name}`);
  if (!input?.prompt?.trim()) throw new Error("prompt fehlt");

  const width   = Math.max(64, Math.min(2048, Number(input.width)  || 1024));
  const height  = Math.max(64, Math.min(2048, Number(input.height) || 1024));
  const model   = String(input.model || "flux");
  const params = new URLSearchParams();
  params.set("width", String(width));
  params.set("height", String(height));
  params.set("model", model);
  params.set("nologo", "true");
  if (input.seed != null) params.set("seed", String(input.seed));
  if (input.enhance)      params.set("enhance", "true");

  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(input.prompt)}?${params}`;
  const t0 = Date.now();

  let r;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  } catch (err) {
    throw new Error(`Pollinations fetch fehlgeschlagen: ${err.message}`);
  }
  if (!r.ok) throw new Error(`Pollinations HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 1000) throw new Error(`Pollinations: zu kleines Image (${buf.length} bytes)`);

  const filename = `img-${Date.now()}-${randomBytes(3).toString("hex")}.png`;
  const filepath = join(IMAGES_DIR, filename);
  writeFileSync(filepath, buf);

  const tookMs = Date.now() - t0;
  console.log(`[image] generated ${filename} (${buf.length} bytes, ${tookMs}ms) prompt="${input.prompt.substring(0,80)}"`);

  return {
    url:    `/api/images/${filename}`,
    prompt: input.prompt,
    width, height, model,
    bytes:  buf.length,
    took_ms: tookMs
  };
}
