// vectors.js — Qdrant-Wrapper für Auto-Vektorisierung + Semantic Recall
//
// - init(): Stellt sicher dass Collection existiert (1024-dim, Cosine)
// - upsertMessage(messageId, text, payload) — fire-and-forget OK
// - upsertMemory(memoryId, text, payload)
// - search(query, k, filter?) → top-k mit payload
//
// Embedding via providers.getProvider("embed") → OllamaProvider.embed()

import { getProvider } from "./providers.js";

const QDRANT_URL = (process.env.QDRANT_URL || "http://qdrant:6333").replace(/\/$/, "");
const COLLECTION = process.env.QDRANT_COLLECTION || "jarvis_memory";
const EMBED_DIM  = Number(process.env.EMBED_DIM || 1024);
const ENABLED    = process.env.VECTOR_MEMORY_ENABLED === "true";

let initialized = false;

export async function init() {
  if (!ENABLED) {
    console.log("[vectors] disabled (VECTOR_MEMORY_ENABLED != true)");
    return;
  }

  // Existiert die Collection?
  try {
    const r = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const data = await r.json();
      console.log(`[vectors] collection ${COLLECTION}: ${data.result.points_count} points`);
      initialized = true;
      return;
    }
  } catch (err) {
    console.warn("[vectors] qdrant nicht erreichbar:", err.message);
    return;
  }

  // Anlegen
  console.log(`[vectors] creating collection ${COLLECTION}…`);
  const r = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vectors: { size: EMBED_DIM, distance: "Cosine" } }),
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) {
    console.error("[vectors] collection creation failed:", await r.text());
    return;
  }
  initialized = true;
  console.log(`[vectors] collection created`);
}

async function embed(text) {
  const provider = getProvider("embed");
  const v = await provider.embed(text);
  if (!v || !Array.isArray(v) || v.length === 0) throw new Error("embed: leerer Vektor");
  return v;
}

// ─── Upsert ──────────────────────────────────────────────────
export async function upsertMessage(messageId, text, payload = {}) {
  if (!ENABLED || !initialized) return;
  if (!text || text.length < 10) return;  // Kurze Messages skippen
  try {
    const vector = await embed(text);
    await qdrant("PUT", `/collections/${COLLECTION}/points`, {
      points: [{
        id: makeId("msg", messageId),
        vector,
        payload: { type: "message", message_id: messageId, text: text.substring(0, 500), ...payload }
      }]
    });
  } catch (err) {
    console.warn(`[vectors] message ${messageId} upsert failed:`, err.message);
  }
}

export async function upsertMemory(memoryId, text, payload = {}) {
  if (!ENABLED || !initialized) return;
  try {
    const vector = await embed(text);
    await qdrant("PUT", `/collections/${COLLECTION}/points`, {
      points: [{
        id: makeId("mem", memoryId),
        vector,
        payload: { type: "memory", memory_id: memoryId, text: text.substring(0, 500), ...payload }
      }]
    });
  } catch (err) {
    console.warn(`[vectors] memory ${memoryId} upsert failed:`, err.message);
  }
}

// ─── Search ──────────────────────────────────────────────────
export async function search(query, k = 5, filter = null) {
  if (!ENABLED || !initialized) return [];
  if (!query || query.length < 3) return [];
  try {
    const vector = await embed(query);
    const body = { vector, limit: k, with_payload: true };
    if (filter) body.filter = filter;
    const r = await qdrant("POST", `/collections/${COLLECTION}/points/search`, body);
    return r?.result || [];
  } catch (err) {
    console.warn("[vectors] search failed:", err.message);
    return [];
  }
}

// ─── Helpers ─────────────────────────────────────────────────
function makeId(prefix, n) {
  // Qdrant erlaubt UInt oder UUID. Wir nehmen synthetic uint:
  // prefix-Hash mit n kombiniert, deterministisch.
  let h = 0;
  for (const c of prefix) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  return Math.abs(h) * 100_000_000 + Number(n);
}

async function qdrant(method, path, body) {
  const r = await fetch(`${QDRANT_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error(`Qdrant ${method} ${path}: ${r.status}`);
  return r.json();
}

export function getInfo() {
  return { enabled: ENABLED, initialized, collection: COLLECTION, dim: EMBED_DIM };
}

// ─── Stats: Anzahl Punkte gesamt + nach Typ ──────────────────
export async function stats() {
  if (!ENABLED) return { enabled: false };
  try {
    const c = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, { signal: AbortSignal.timeout(5000) });
    if (!c.ok) return { enabled: true, initialized: false, error: `HTTP ${c.status}` };
    const meta = (await c.json()).result;
    const total = meta.points_count || 0;
    const types = {};
    for (const t of ["message", "memory", "note"]) {
      try {
        const r = await qdrant("POST", `/collections/${COLLECTION}/points/count`, {
          filter: { must: [{ key: "type", match: { value: t } }] },
          exact: true
        });
        types[t] = r?.result?.count ?? 0;
      } catch { types[t] = null; }
    }
    return {
      enabled: true,
      initialized,
      collection: COLLECTION,
      dim: EMBED_DIM,
      url: QDRANT_URL,
      total,
      types,
      vectors_size: meta.vectors_count ?? null,
      indexed_vectors_count: meta.indexed_vectors_count ?? null,
      status: meta.status,
      segments: meta.segments_count
    };
  } catch (err) {
    return { enabled: true, initialized: false, error: err.message };
  }
}

// ─── Delete by Type-Filter (für Cleanup von V1-Migrations-Vektoren) ──
export async function deleteByTypes(types) {
  if (!ENABLED || !initialized) return { deleted: 0, error: "vectors disabled" };
  if (!Array.isArray(types) || !types.length) return { deleted: 0, error: "types[] erforderlich" };
  const before = (await fetch(`${QDRANT_URL}/collections/${COLLECTION}`).then(r => r.json())).result.points_count;
  await qdrant("POST", `/collections/${COLLECTION}/points/delete`, {
    filter: { must: [{ key: "type", match: { any: types } }] }
  });
  // Qdrant ist async — kurz warten und Stats erneut holen
  await new Promise(r => setTimeout(r, 500));
  const after = (await fetch(`${QDRANT_URL}/collections/${COLLECTION}`).then(r => r.json())).result.points_count;
  return { deleted: before - after, before, after, types };
}

// ─── Scroll: Punkte auflisten (mit Pagination) ───────────────
export async function scroll({ limit = 50, offset = null, type = null } = {}) {
  if (!ENABLED || !initialized) return { points: [], next: null };
  const body = { limit, with_payload: true, with_vector: false };
  if (offset != null) body.offset = offset;
  if (type) body.filter = { must: [{ key: "type", match: { value: type } }] };
  const r = await qdrant("POST", `/collections/${COLLECTION}/points/scroll`, body);
  return { points: r?.result?.points || [], next: r?.result?.next_page_offset ?? null };
}
