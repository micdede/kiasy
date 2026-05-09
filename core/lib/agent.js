// agent.js — Agent-Loop mit Tool-Calls (Phase 3 Etappe 3)
//
// handle({chatId, message}) → {text, turns, messageId, usage}
//   max MAX_TURNS Iterationen: LLM → tool_calls? → execute → next turn
//
// streamHandle yieldet {delta} während LLM streamt + {tool_use, tool_result, done}

import * as db from "./db.js";
import * as tools from "./tools.js";
import * as vectors from "./vectors.js";
import { getProvider } from "./providers.js";

const HISTORY_LIMIT = Number(process.env.AGENT_HISTORY_LIMIT) || 30;
const MAX_TURNS     = Number(process.env.AGENT_MAX_TURNS) || 10;
const RECALL_K      = Number(process.env.AGENT_RECALL_K) || 5;
const AUTO_ROUTE    = process.env.AGENT_AUTO_ROUTE === "true";

// Übersetzungs-Pattern: Detection im Agent, weil LLMs (insbes. minimax)
// das Tool nicht zuverlässig selbst wählen. Match → direkter Tool-Call,
// kein LLM-Round.
const LANG_FLAG = { en: "🇺🇸", fr: "🇫🇷", es: "🇪🇸", it: "🇮🇹", de: "🇩🇪" };

// Akzeptiert Deklinationen: "italienisch", "italienische", "italienischen", "italian", …
function detectLang(s) {
  const t = s.toLowerCase();
  if (t.startsWith("englisch") || t.startsWith("english")) return "en";
  if (t.startsWith("französ")  || t.startsWith("french")  || t.startsWith("franz"))  return "fr";
  if (t.startsWith("spanisch") || t.startsWith("spanish") || t.startsWith("span"))   return "es";
  if (t.startsWith("italien")  || t.startsWith("italian"))  return "it";
  if (t.startsWith("deutsch")  || t.startsWith("german"))   return "de";
  return null;
}

function detectTranslationRequest(message) {
  const re = /^\s*(?:wie\s+sagt\s+man\s+auf|übersetz(?:e)?\s+(?:das|mir|den\s+(?:text|satz))?\s*(?:ins?|nach|in)|sag\s+mir\s+auf|sprich\s+(?:es\s+)?auf|auf)\s+([a-zäöüß]+)\s*[:,.\-]?\s+(.+?)\s*[?!.]?\s*$/i;
  const m = message.match(re);
  if (!m) return null;
  const lang = detectLang(m[1]);
  if (!lang) return null;
  const text = m[2].trim().replace(/^["„»“]|["«"”]$/g, "").trim();
  if (text.length < 2) return null;
  return { target_lang: lang, text };
}

// AGENT_AUTO_ROUTE neu: chat first, cheap als Fallback wenn Cloud nicht erreichbar.
// Circuit-Breaker: 30s lang nach Fehler direkt cheap, ohne erneut in Cloud-Timeout zu rennen.
const FALLBACK_COOLDOWN_MS = 30_000;
let cloudDownUntil = 0;

function pickRole(explicitRole) {
  if (explicitRole) return explicitRole;
  return "chat";
}

// Wrapper: chat() mit Auto-Fallback auf cheap (ohne Tools) bei Fehler.
// Returns { res, providerUsed, fallback: true|false, error?: string }
async function chatWithFallback({ messages, tools: toolDefs, system }) {
  const useFallback = AUTO_ROUTE;
  if (useFallback && cloudDownUntil > Date.now()) {
    const remaining = Math.ceil((cloudDownUntil - Date.now()) / 1000);
    console.warn(`[agent] cloud known-down for ${remaining}s — using cheap directly`);
    const cheap = getProvider("cheap");
    const res = await cheap.chat({ messages, tools: [], system });
    return { res, providerUsed: cheap, fallback: true, reason: `cloud cooldown ${remaining}s` };
  }
  const primary = getProvider("chat");
  try {
    const res = await primary.chat({ messages, tools: toolDefs, system });
    if (cloudDownUntil) { cloudDownUntil = 0; console.log("[agent] cloud back online — fallback cleared"); }
    return { res, providerUsed: primary, fallback: false };
  } catch (err) {
    if (!useFallback) throw err;
    console.error(`[agent] chat-provider failed (${err.message}) — fallback to cheap`);
    cloudDownUntil = Date.now() + FALLBACK_COOLDOWN_MS;
    const cheap = getProvider("cheap");
    const res = await cheap.chat({ messages, tools: [], system });
    return { res, providerUsed: cheap, fallback: true, reason: err.message };
  }
}

export async function handle({ chatId, message, provider, role, attachments }) {
  if (!chatId || !message) throw new Error("chatId+message erforderlich");

  // 1. User-Message persistieren + im Hintergrund vektorisieren
  // Attachments selbst werden NICHT in DB gespeichert (zu groß), nur ein Hinweis in meta
  const userMeta = attachments?.length
    ? { attachments_count: attachments.length, attachment_types: attachments.map(a => a.type) }
    : null;
  const userMsgId = db.saveMessage({ chatId, role: "user", content: message, meta: userMeta });
  vectors.upsertMessage(userMsgId, message, { chat_id: chatId, role: "user" }).catch(() => {});

  // 1a. Übersetzungs-Shortcut: Pattern erkannt → direkter Tool-Call ohne LLM
  const tr = detectTranslationRequest(message);
  if (tr) {
    try {
      const result = await tools.execute("translate_and_speak", tr, { chatId });
      const flag = LANG_FLAG[tr.target_lang] || "🌐";
      const replyText = `${flag} ${result.translated || ""}\n\n_(Voice in ${result.voice} verschickt)_`;
      const messageId = db.saveMessage({
        chatId, role: "assistant", content: replyText,
        meta: { tools_used: ["translate_and_speak"], shortcut: true, voice: result.voice, lang: tr.target_lang }
      });
      vectors.upsertMessage(messageId, replyText, { chat_id: chatId, role: "assistant" }).catch(() => {});
      db.logEvent({ type: "translation-shortcut", message: `${tr.target_lang}: ${tr.text.substring(0,80)}`, meta: result });
      return { text: replyText, turns: 0, messageId, usage: null, role: "shortcut", tools_used: ["translate_and_speak"] };
    } catch (err) {
      console.error("[agent] translation shortcut failed:", err.message);
      // Fallthrough zum LLM
    }
  }

  // 2. Verlauf laden + Semantic-Recall + Tools
  const history = loadHistory(chatId);
  // Attachments an die zuletzt gespeicherte (= aktuelle) User-Message anhängen
  if (attachments?.length) {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === "user") {
        history[i].attachments = attachments;
        break;
      }
    }
  }
  const toolDefs = await tools.getDefinitions();
  const recall = await semanticRecall(chatId, message);
  const explicitRole = pickRole(role || provider);  // null oder "cheap" wenn explizit angefragt
  // Bei explizitem Role-Override: direkt das Modell, kein Fallback-Wrapper
  const explicitLLM = explicitRole && (explicitRole === "cheap" || explicitRole === "chat") ? getProvider(explicitRole) : null;
  const explicitTools = explicitRole === "cheap" ? [] : toolDefs;

  // 3. Loop bis kein tool_use mehr ODER MAX_TURNS
  const messages = [...history];
  let lastText = "";
  let lastUsage = null;
  let turn = 0;
  const toolsUsed = [];
  let usedFallback = false;
  let fallbackReason = null;
  let llm = explicitLLM;          // wird nach erstem Fallback "festgenagelt"
  let effectiveTools = explicitLLM ? explicitTools : toolDefs;
  const systemSuffix = recall.length ? buildRecallSystem(recall) : null;

  while (turn < MAX_TURNS) {
    turn++;
    let res;
    if (llm) {
      // Festes Modell (entweder explizit oder nach Fallback im vorigen Turn)
      res = await llm.chat({ messages, tools: effectiveTools, system: systemSuffix });
    } else {
      // chat first, mit Auto-Fallback
      const wrap = await chatWithFallback({ messages, tools: toolDefs, system: systemSuffix });
      res = wrap.res;
      llm = wrap.providerUsed;
      effectiveTools = wrap.fallback ? [] : toolDefs;
      if (wrap.fallback) { usedFallback = true; fallbackReason = wrap.reason; }
    }
    lastText = res.text;
    lastUsage = res.usage;

    if (!res.tool_calls || !res.tool_calls.length) {
      // Final-Antwort
      break;
    }

    // tool_use Block persistieren
    db.saveMessage({
      chatId, role: "assistant", content: res.text || "",
      meta: { tool_calls: res.tool_calls, model: llm.model, turn }
    });
    messages.push({
      role: "assistant",
      content: res.text || "",
      tool_calls: res.tool_calls
    });

    // Alle Tool-Calls ausführen
    for (const tc of res.tool_calls) {
      toolsUsed.push(tc.name);
      let result;
      try {
        result = await tools.execute(tc.name, tc.input, { chatId });
      } catch (err) {
        result = { error: String(err.message || err) };
        console.error(`[agent] tool ${tc.name} failed:`, err.message);
      }
      const resultStr = typeof result === "string" ? result : JSON.stringify(result);
      db.saveMessage({
        chatId, role: "tool", content: resultStr,
        msgType: "tool_result",
        meta: { tool_call_id: tc.id, tool_name: tc.name, input: tc.input }
      });
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        name: tc.name,
        content: resultStr
      });
    }
  }

  // 4. Finale Assistant-Antwort speichern + vektorisieren
  // Bei Fallback: Hinweis-Suffix anhängen, damit der User sieht dass das lokale Modell antwortete
  if (usedFallback) {
    lastText = (lastText || "").trimEnd() +
      `\n\n_⚠ Fallback: lokales Modell (${llm.model}) — Cloud nicht erreichbar` +
      (fallbackReason ? `: ${fallbackReason}` : "") + `_`;
  }
  const roleLabel = usedFallback ? "fallback-cheap" : (explicitRole || "chat");
  const messageId = db.saveMessage({
    chatId, role: "assistant", content: lastText,
    meta: { usage: lastUsage, model: llm.model, turn, final: true, recall: recall.length, fallback: usedFallback }
  });
  vectors.upsertMessage(messageId, lastText, { chat_id: chatId, role: "assistant" }).catch(() => {});

  db.logEvent({
    type: "message",
    message: `chat:${chatId} role=${roleLabel} ${turn} turn(s) ${lastText.length} chars${usedFallback ? " [FALLBACK]" : ""}`,
    meta: { usage: lastUsage, turns: turn, role: roleLabel, fallback: usedFallback, fallback_reason: fallbackReason }
  });

  return { text: lastText, turns: turn, messageId, usage: lastUsage, role: roleLabel, tools_used: toolsUsed, fallback: usedFallback };
}

export async function* streamHandle({ chatId, message, provider, role, attachments }) {
  if (!chatId || !message) throw new Error("chatId+message erforderlich");

  const userMeta = attachments?.length
    ? { attachments_count: attachments.length, attachment_types: attachments.map(a => a.type) }
    : null;
  const userMsgId = db.saveMessage({ chatId, role: "user", content: message, meta: userMeta });
  vectors.upsertMessage(userMsgId, message, { chat_id: chatId, role: "user" }).catch(() => {});

  const history = loadHistory(chatId);
  if (attachments?.length) {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === "user") {
        history[i].attachments = attachments;
        break;
      }
    }
  }
  const toolDefs = await tools.getDefinitions();
  const recall = await semanticRecall(chatId, message);
  // Stream-Pfad: kein Auto-Fallback (würde Streaming bedeutend komplizieren).
  // Bei Cloud-Down → reiner Stream-Aufruf wirft, Caller muss notfalls non-stream nochmal probieren.
  const chosenRole = pickRole(role || provider) || "chat";
  const llm = getProvider(chosenRole);
  const effectiveTools = chosenRole === "cheap" ? [] : toolDefs;
  const systemSuffix = recall.length ? buildRecallSystem(recall) : null;

  const messages = [...history];
  let lastText = "";
  let lastUsage = null;
  let turn = 0;
  const toolsUsed = [];

  while (turn < MAX_TURNS) {
    turn++;
    let streamedText = "";
    let toolCallsInTurn = null;

    for await (const ev of llm.chatStream({ messages, tools: effectiveTools, system: systemSuffix })) {
      if (ev.delta) {
        streamedText += ev.delta;
        yield { delta: ev.delta };
      } else if (ev.final) {
        lastText = ev.final.text || streamedText;
        lastUsage = ev.final.usage;
        toolCallsInTurn = ev.final.tool_calls;
      }
    }

    if (!toolCallsInTurn || !toolCallsInTurn.length) break;

    // Persist + execute (wie in handle)
    db.saveMessage({
      chatId, role: "assistant", content: lastText,
      meta: { tool_calls: toolCallsInTurn, model: llm.model, turn }
    });
    messages.push({ role: "assistant", content: lastText, tool_calls: toolCallsInTurn });

    for (const tc of toolCallsInTurn) {
      toolsUsed.push(tc.name);
      yield { tool_use: { name: tc.name, input: tc.input } };
      let result;
      try {
        result = await tools.execute(tc.name, tc.input, { chatId });
      } catch (err) {
        result = { error: String(err.message || err) };
      }
      const resultStr = typeof result === "string" ? result : JSON.stringify(result);
      yield { tool_result: { name: tc.name, result: result } };
      db.saveMessage({
        chatId, role: "tool", content: resultStr,
        msgType: "tool_result",
        meta: { tool_call_id: tc.id, tool_name: tc.name, input: tc.input }
      });
      messages.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: resultStr });
    }
  }

  const messageId = db.saveMessage({
    chatId, role: "assistant", content: lastText,
    meta: { usage: lastUsage, model: llm.model, turn, final: true, recall: recall.length }
  });
  vectors.upsertMessage(messageId, lastText, { chat_id: chatId, role: "assistant" }).catch(() => {});

  yield { done: { text: lastText, turns: turn, messageId, usage: lastUsage, tools_used: toolsUsed } };
}

// ─── Semantic Recall ─────────────────────────────────────────
async function semanticRecall(chatId, query) {
  if (process.env.VECTOR_MEMORY_ENABLED !== "true") return [];
  try {
    // Top-K, optional filter auf type=message
    const results = await vectors.search(query, RECALL_K);
    // Aktuelle Conversation-Messages aus dem Recall raus (kommen schon in history)
    return (results || []).filter(r => {
      const p = r.payload || {};
      return p.text && p.text !== query;  // Eigene Eingabe nicht zurückgeben
    });
  } catch { return []; }
}

function buildRecallSystem(recall) {
  const items = recall.slice(0, 5).map(r => {
    const p = r.payload || {};
    const score = (r.score || 0).toFixed(2);
    return `- [${score}] ${p.type || "?"}${p.role ? "/" + p.role : ""}: ${p.text}`;
  }).join("\n");
  return `Du bist ${process.env.BOT_NAME || "JARVIS"}. Antworte direkt, kurz, deutsch. Nutze Tools wo sinnvoll.

Relevante frühere Inhalte aus dem Memory (Score = Cosine-Similarity):
${items}`;
}

// ─── Helpers ─────────────────────────────────────────────────
function loadHistory(chatId) {
  const rows = db.getRecentMessages(chatId, HISTORY_LIMIT);
  // Tool-Roles + tool_calls aus meta wieder ins neutrale Format heben
  return rows.map(r => {
    const m = { role: r.role, content: r.content };
    if (r.meta?.tool_calls) m.tool_calls = r.meta.tool_calls;
    if (r.meta?.tool_call_id) m.tool_call_id = r.meta.tool_call_id;
    if (r.meta?.tool_name) m.name = r.meta.tool_name;
    return m;
  });
}
