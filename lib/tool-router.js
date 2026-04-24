// lib/tool-router.js — Semantisches Tool-Routing
// Pickt pro Nachricht die ~K relevantesten Tools per Embedding-Ähnlichkeit,
// statt dem LLM den vollen Katalog (~67 Tools) zu schicken.
// Nutzt das gleiche Embedding-System wie das semantische Gedächtnis (bge-m3).

const ROUTING_ENABLED = (process.env.TOOL_ROUTING || "on").toLowerCase() !== "off";
const TOPK = parseInt(process.env.TOOL_TOPK || "8", 10);
const MIN_SIM = parseFloat(process.env.TOOL_MIN_SIMILARITY || "0.35");
const BASELINE = (process.env.TOOL_BASELINE || "memory_read,memory_write,kb_search,chat_search")
  .split(",").map(s => s.trim()).filter(Boolean);

let cachedEmbeddings = new Map(); // name → vector
let cachedToolsHash = "";

function hashTools(definitions) {
  return definitions
    .map(d => `${d.name}|${(d.description || "").slice(0, 200)}`)
    .join("\n");
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

// Sanitize: bge-m3 produziert manchmal NaN bei bestimmten Token-Folgen
// (z.B. "MODE=readwrite in .env."). Wir säubern aggressiver, fallen auf
// Zero-Vektor zurück wenn's trotzdem fehlschlägt.
function sanitizeText(text) {
  return text
    .replace(/=/g, " ist ")
    .replace(/\.env/gi, "env file")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ZERO_VECTOR = new Array(1024).fill(0);

async function embedSafe(vm, text) {
  try {
    return await vm.embed(text);
  } catch {
    try {
      return await vm.embed(sanitizeText(text));
    } catch {
      return ZERO_VECTOR;
    }
  }
}

async function ensureEmbeddings(definitions) {
  if (!definitions || definitions.length === 0) return;
  const hash = hashTools(definitions);
  if (hash === cachedToolsHash && cachedEmbeddings.size === definitions.length) return;

  const vm = require("./vector-memory");
  const texts = definitions.map(d => `${d.name}: ${d.description || ""}`);

  const fresh = new Map();
  let failed = 0;
  // Batch versuchen, bei Fehler einzeln mit Sanitize-Fallback
  for (let i = 0; i < texts.length; i += 16) {
    const slice = texts.slice(i, i + 16);
    let vectors;
    try {
      vectors = await vm.embedBatch(slice);
    } catch {
      vectors = [];
      for (const t of slice) {
        const v = await embedSafe(vm, t);
        if (v === ZERO_VECTOR) failed++;
        vectors.push(v);
      }
    }
    for (let j = 0; j < slice.length; j++) {
      fresh.set(definitions[i + j].name, vectors[j]);
    }
  }
  cachedEmbeddings = fresh;
  cachedToolsHash = hash;
  console.log(`[tool-router] ${definitions.length} Tools embedded${failed ? ` (${failed} mit Zero-Vektor wegen Embed-Fehler)` : ""}`);
}

async function selectTools(message, definitions) {
  if (!ROUTING_ENABLED) return definitions;
  if (!definitions || definitions.length <= TOPK) return definitions;
  if (!message || message.trim().length === 0) return definitions;

  try {
    await ensureEmbeddings(definitions);
    const vm = require("./vector-memory");
    const queryVec = await embedSafe(vm, message);
    if (queryVec === ZERO_VECTOR) {
      console.warn("[tool-router] Query-Embed fehlgeschlagen, Fallback auf alle Tools");
      return definitions;
    }

    const scored = definitions.map(def => ({
      def,
      score: cosine(queryVec, cachedEmbeddings.get(def.name)),
    }));
    scored.sort((a, b) => b.score - a.score);

    const top = scored
      .filter(s => s.score >= MIN_SIM)
      .slice(0, TOPK)
      .map(s => s.def);

    // Baseline immer dazu (falls vorhanden in den geladenen Tools)
    const selected = new Map();
    for (const def of top) selected.set(def.name, def);
    for (const name of BASELINE) {
      const baseline = definitions.find(d => d.name === name);
      if (baseline && !selected.has(name)) selected.set(name, baseline);
    }

    const result = [...selected.values()];

    // Falls gar nichts ausgewählt wurde (sehr kurze/unklare Nachricht), Baseline only — sonst kommt das LLM nicht weit
    if (result.length === 0) return definitions.filter(d => BASELINE.includes(d.name));

    const topScores = scored.slice(0, 3).map(s => `${s.def.name}=${s.score.toFixed(2)}`).join(", ");
    console.log(`[tool-router] ${result.length}/${definitions.length} Tools (top: ${topScores})`);
    return result;
  } catch (e) {
    console.warn(`[tool-router] Routing-Fehler, Fallback auf alle Tools: ${e.message}`);
    return definitions;
  }
}

module.exports = { selectTools, ensureEmbeddings };
