// lib/vector-memory.js — Semantisches Gedächtnis via Qdrant + Ollama Embeddings
// Nutzt bge-m3 (multilingual, 1024 dim) auf Unraid Ollama
// Qdrant auf Unraid (192.168.178.20:6333)

// OLLAMA_BASE_URL kann /v1 Suffix haben (OpenAI-kompatibel) — wir brauchen die Basis-URL
const OLLAMA_URL = (process.env.OLLAMA_BASE_URL || "http://192.168.178.20:11434").replace(/\/v1\/?$/, "");
const QDRANT_URL = process.env.QDRANT_URL || "http://192.168.178.20:6333";
const EMBED_MODEL = process.env.EMBED_MODEL || "bge-m3";
const COLLECTION = "jarvis_memory";
const VECTOR_DIM = 1024;

// ============================================================
// Embedding via Ollama
// ============================================================

async function embed(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Embed error: ${res.status}`);
  const data = await res.json();
  return data.embeddings[0];
}

// Batch-Embedding (mehrere Texte auf einmal)
async function embedBatch(texts) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Embed batch error: ${res.status}`);
  const data = await res.json();
  return data.embeddings;
}

// ============================================================
// Qdrant HTTP Client
// ============================================================

async function qdrant(method, path, body = null) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30000),
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${QDRANT_URL}${path}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Qdrant ${method} ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

// ============================================================
// Collection Setup
// ============================================================

async function ensureCollection() {
  try {
    await qdrant("GET", `/collections/${COLLECTION}`);
  } catch {
    // Collection existiert nicht → erstellen
    await qdrant("PUT", `/collections/${COLLECTION}`, {
      vectors: {
        size: VECTOR_DIM,
        distance: "Cosine",
      },
      optimizers_config: {
        default_segment_number: 2,
      },
    });
    // Payload-Indizes für Filterung
    await qdrant("PUT", `/collections/${COLLECTION}/index`, {
      field_name: "type",
      field_schema: "keyword",
    });
    await qdrant("PUT", `/collections/${COLLECTION}/index`, {
      field_name: "source_id",
      field_schema: "keyword",
    });
    await qdrant("PUT", `/collections/${COLLECTION}/index`, {
      field_name: "indexed_at",
      field_schema: "datetime",
    });
    console.log(`[Vector] Collection "${COLLECTION}" erstellt`);
  }
}

// ============================================================
// CRUD Operationen
// ============================================================

/**
 * Punkt in Qdrant speichern
 * @param {string} id - Eindeutige ID (z.B. "memory_123", "chat_456")
 * @param {string} text - Text der vektorisiert wird
 * @param {object} payload - Metadaten (type, source_id, preview, date, etc.)
 */
async function upsert(id, text, payload = {}) {
  const vector = await embed(text);
  await qdrant("PUT", `/collections/${COLLECTION}/points`, {
    points: [{
      id: stringToUUID(id),
      vector,
      payload: {
        ...payload,
        text_preview: text.substring(0, 500),
        original_id: id,
        indexed_at: new Date().toISOString(),
      },
    }],
  });
}

/**
 * Batch-Upsert — effizienter für Migrationen
 * @param {Array<{id: string, text: string, payload: object}>} items
 */
async function upsertBatch(items) {
  if (items.length === 0) return;

  // In Chunks von 50 verarbeiten (Ollama Embedding-Limit)
  const CHUNK_SIZE = 50;
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    const texts = chunk.map(item => item.text);
    const vectors = await embedBatch(texts);

    const points = chunk.map((item, idx) => ({
      id: stringToUUID(item.id),
      vector: vectors[idx],
      payload: {
        ...item.payload,
        text_preview: item.text.substring(0, 500),
        original_id: item.id,
        indexed_at: new Date().toISOString(),
      },
    }));

    await qdrant("PUT", `/collections/${COLLECTION}/points`, { points });
  }
}

/**
 * Semantische Suche
 * @param {string} query - Suchtext
 * @param {object} options - { limit, type, minScore }
 * @returns {Array<{id, score, payload}>}
 */
async function search(query, { limit = 10, type = null, minScore = 0.3 } = {}) {
  const vector = await embed(query);

  const result = await qdrant("POST", `/collections/${COLLECTION}/points/query`, {
    query: vector,
    limit,
    score_threshold: minScore,
    with_payload: true,
    filter: type ? { must: [{ key: "type", match: { value: type } }] } : undefined,
  });

  const points = result.result?.points || result.result || [];
  return points.map(point => ({
    id: point.payload?.original_id || point.id,
    score: point.score,
    payload: point.payload,
  }));
}

/**
 * Punkt löschen
 */
async function remove(id) {
  await qdrant("POST", `/collections/${COLLECTION}/points/delete`, {
    points: [stringToUUID(id)],
  });
}

/**
 * Collection-Statistiken
 */
async function stats() {
  const data = await qdrant("GET", `/collections/${COLLECTION}`);
  return {
    points: data.result?.points_count || 0,
    status: data.result?.status || "unknown",
  };
}

// ============================================================
// Kontext für Agent-Prompt holen
// ============================================================

/**
 * Holt semantisch relevanten Kontext für eine User-Nachricht
 * Sucht über alle Typen und formatiert für den System-Prompt
 * @param {string} userMessage - Die Nachricht des Users
 * @param {number} maxResults - Max Ergebnisse
 * @returns {string} Formatierter Kontext-Block
 */
async function getRelevantContext(userMessage, maxResults = 8) {
  try {
    const results = await search(userMessage, { limit: maxResults, minScore: 0.35 });

    if (results.length === 0) return "";

    const lines = results.map(r => {
      const p = r.payload;
      const typeLabel = { memory: "Erinnerung", chat: "Gespräch", kb: "Wissen" }[p.type] || p.type;
      const date = p.date ? ` (${p.date})` : "";
      const score = (r.score * 100).toFixed(0);
      return `[${typeLabel}${date}, ${score}%] ${p.text_preview}`;
    });

    return `\n--- Relevanter Kontext aus dem Gedächtnis ---\n${lines.join("\n")}\n--- Ende Kontext ---\n`;
  } catch (e) {
    // Qdrant nicht erreichbar → still weitermachen
    console.warn("[Vector] Kontext-Suche fehlgeschlagen:", e.message);
    return "";
  }
}

// ============================================================
// Hilfsfunktionen
// ============================================================

// Deterministische UUID aus String (für Qdrant Punkt-IDs)
function stringToUUID(str) {
  const { createHash } = require("crypto");
  const hash = createHash("md5").update(str).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    "4" + hash.slice(13, 16),
    ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16) + hash.slice(18, 20),
    hash.slice(20, 32),
  ].join("-");
}

/**
 * Prüft ob Qdrant erreichbar ist
 */
async function isAvailable() {
  try {
    await qdrant("GET", "/collections");
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// Export
// ============================================================

module.exports = {
  embed,
  embedBatch,
  ensureCollection,
  upsert,
  upsertBatch,
  search,
  remove,
  stats,
  getRelevantContext,
  isAvailable,
  COLLECTION,
};
