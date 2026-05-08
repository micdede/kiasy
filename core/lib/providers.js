// providers.js — LLM-Clients mit Rollen-System
//
// Drei Rollen:
//   chat   — Hauptmodell für Antworten + Tool-Calls (OLLAMA_MODEL / ANTHROPIC_MODEL)
//   cheap  — Kleines/schnelles Modell für Klassifikation, Routing (OLLAMA_MODEL_CHEAP)
//   embed  — Embedding-Modell (OLLAMA_MODEL_EMBED, default bge-m3)
//
// Pro Rolle: getProvider(role) → Instance mit chat/chatStream/embed.
//
// Body von /api/chat/send akzeptiert {provider:"chat"|"cheap"} (legacy: {provider:"ollama"|"anthropic"})

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const DEFAULT_PROVIDER = process.env.LLM_PROVIDER || "ollama";

const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || `\
Du bist JARVIS, Michaels persönlicher KI-Assistent.
Sprichst Deutsch (technische Begriffe englisch). Direkt, kurz, kein Geschwätz.
Wenn ein Tool helfen würde, nutze es ohne Rückfrage. Bei mehreren möglichen
Tools: nimm das passendste, nicht alle.

WICHTIG — Übersetzungs-Anfragen ("wie sagt man auf X", "übersetz das ins X",
"auf X:") MUSST du IMMER mit dem Tool translate_and_speak beantworten,
NIEMALS nur als Text. Der User will die korrekte Aussprache hören.`;

// ─── Role → Model-Mapping ───────────────────────────────────
function modelForRole(role) {
  switch (role) {
    case "embed":
      return process.env.OLLAMA_MODEL_EMBED || "bge-m3";
    case "cheap":
      return process.env.OLLAMA_MODEL_CHEAP || process.env.OLLAMA_MODEL || "qwen2.5:1.5b";
    case "code":
      return process.env.OLLAMA_MODEL_CODE || "qwen3-coder:480b-cloud";
    case "chat":
    default:
      return process.env.OLLAMA_MODEL || "qwen2.5:1.5b";
  }
}

// ─── Anthropic ───────────────────────────────────────────────
class AnthropicProvider {
  constructor(model) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY fehlt");
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    this.model = model || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
  }

  async chat({ messages, tools = [], system }) {
    const params = {
      model: this.model,
      max_tokens: Number(process.env.MAX_TOKENS) || 4096,
      system: system || SYSTEM_PROMPT,
      messages: toAnthropicMessages(messages)
    };
    if (tools.length) params.tools = tools.map(toAnthropicTool);
    const res = await this.client.messages.create(params);
    return parseAnthropicResponse(res);
  }

  async *chatStream({ messages, tools = [], system }) {
    const params = {
      model: this.model,
      max_tokens: Number(process.env.MAX_TOKENS) || 4096,
      system: system || SYSTEM_PROMPT,
      messages: toAnthropicMessages(messages)
    };
    if (tools.length) params.tools = tools.map(toAnthropicTool);
    const stream = this.client.messages.stream(params);
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { delta: event.delta.text };
      }
    }
    const final = await stream.finalMessage();
    yield { final: parseAnthropicResponse(final) };
  }

  async embed() { throw new Error("Anthropic kann keine Embeddings"); }
}

function toAnthropicTool(t) {
  return { name: t.name, description: t.description, input_schema: t.input_schema || { type: "object", properties: {} } };
}
function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const last = out[out.length - 1];
      const block = { type: "tool_result", tool_use_id: m.tool_call_id, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) };
      if (last && last.role === "user" && Array.isArray(last.content)) last.content.push(block);
      else out.push({ role: "user", content: [block] });
    } else if (m.role === "assistant" && m.tool_calls?.length) {
      const blocks = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls) blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
      out.push({ role: "assistant", content: blocks });
    } else {
      out.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
    }
  }
  return out;
}
function parseAnthropicResponse(res) {
  let text = ""; const tool_calls = [];
  for (const c of res.content || []) {
    if (c.type === "text") text += c.text;
    else if (c.type === "tool_use") tool_calls.push({ id: c.id, name: c.name, input: c.input });
  }
  return { text, tool_calls: tool_calls.length ? tool_calls : null, stop_reason: res.stop_reason, usage: res.usage };
}

// ─── Ollama (OpenAI-compat) ─────────────────────────────────
class OllamaProvider {
  constructor(model) {
    const baseURL = (process.env.OLLAMA_URL || "http://ollama:11434").replace(/\/$/, "") + "/v1";
    this.client = new OpenAI({ baseURL, apiKey: "ollama" });
    this.model = model;
    this.baseURL = (process.env.OLLAMA_URL || "http://ollama:11434").replace(/\/$/, "");
  }

  async chat({ messages, tools = [], system }) {
    const params = {
      model: this.model,
      max_tokens: Number(process.env.MAX_TOKENS) || 4096,
      messages: toOpenAIMessages(messages, system || SYSTEM_PROMPT)
    };
    if (tools.length) params.tools = tools.map(toOpenAITool);
    const res = await this.client.chat.completions.create(params);
    return parseOpenAIResponse(res);
  }

  async *chatStream({ messages, tools = [], system }) {
    const params = {
      model: this.model,
      max_tokens: Number(process.env.MAX_TOKENS) || 4096,
      messages: toOpenAIMessages(messages, system || SYSTEM_PROMPT),
      stream: true
    };
    if (tools.length) params.tools = tools.map(toOpenAITool);
    const stream = await this.client.chat.completions.create(params);
    let full = ""; const accCalls = [];
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) { full += delta.content; yield { delta: delta.content }; }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          accCalls[idx] ||= { id: "", name: "", arguments: "" };
          if (tc.id) accCalls[idx].id += tc.id;
          if (tc.function?.name) accCalls[idx].name += tc.function.name;
          if (tc.function?.arguments) accCalls[idx].arguments += tc.function.arguments;
        }
      }
    }
    const tool_calls = accCalls.filter(c => c.name).map(c => ({
      id: c.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      name: c.name, input: safeJsonParse(c.arguments)
    }));
    yield { final: { text: full, tool_calls: tool_calls.length ? tool_calls : null, usage: null } };
  }

  // Embedding via native Ollama API (zuverlässiger als /v1/embeddings für bge-m3)
  async embed(text) {
    const r = await fetch(`${this.baseURL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: text }),
      signal: AbortSignal.timeout(30_000)
    });
    if (!r.ok) throw new Error(`Embed ${r.status}: ${(await r.text()).substring(0, 200)}`);
    const data = await r.json();
    return data.embedding;
  }
}

function toOpenAITool(t) {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema || { type: "object", properties: {} } } };
}
function toOpenAIMessages(messages, system) {
  const out = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") out.push({ role: "tool", tool_call_id: m.tool_call_id, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) });
    else if (m.role === "assistant" && m.tool_calls?.length)
      out.push({ role: "assistant", content: m.content || null, tool_calls: m.tool_calls.map(tc => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.input) } })) });
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}
function parseOpenAIResponse(res) {
  const choice = res.choices[0]; const msg = choice?.message || {};
  const tool_calls = (msg.tool_calls || []).map(tc => ({
    id: tc.id, name: tc.function?.name, input: safeJsonParse(tc.function?.arguments || "{}")
  }));
  return { text: msg.content || "", tool_calls: tool_calls.length ? tool_calls : null, stop_reason: choice?.finish_reason, usage: res.usage };
}
function safeJsonParse(s) { try { return JSON.parse(s); } catch { return {}; } }

// ─── Factory mit Rollen-Cache ────────────────────────────────
const cache = new Map();  // key = `${providerName}:${model}`

export function getProvider(roleOrName = "chat") {
  // Legacy: "anthropic" / "ollama" → role="chat" mit fixem Provider
  let providerName, model;
  if (roleOrName === "anthropic") {
    providerName = "anthropic"; model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
  } else if (roleOrName === "ollama") {
    providerName = "ollama"; model = modelForRole("chat");
  } else {
    // role="chat"|"cheap"|"embed"|"code" → folge DEFAULT_PROVIDER
    // Ausnahmen: embed + code laufen immer über Ollama (Cloud-Coding-Modell)
    if (roleOrName === "embed" || roleOrName === "code") {
      providerName = "ollama"; model = modelForRole(roleOrName);
    } else {
      providerName = DEFAULT_PROVIDER; model = modelForRole(roleOrName);
    }
  }

  const key = `${providerName}:${model}`;
  if (cache.has(key)) return cache.get(key);

  let instance;
  switch (providerName) {
    case "anthropic": instance = new AnthropicProvider(model); break;
    case "ollama":    instance = new OllamaProvider(model);    break;
    default: throw new Error(`Unbekannter Provider: ${providerName}`);
  }
  cache.set(key, instance);
  console.log(`[providers] role=${roleOrName} → ${providerName} (${model})`);
  return instance;
}

// Reset für ENV-Änderung nach Recreate (eigentlich automatisch, aber explizit verfügbar)
export function resetCache() { cache.clear(); }
