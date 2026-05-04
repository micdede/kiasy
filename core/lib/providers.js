// providers.js — LLM-Clients (Anthropic + Ollama via OpenAI-compat)
//
// Neutrales Message-Format:
//   { role: "user"|"assistant"|"tool", content: string, tool_calls?, tool_call_id?, name? }
//
// Tools-Format (neutral, kommt von tools.js):
//   { name, description, input_schema: {type:"object", properties:{}, required:[]} }
//
// chat({messages, tools, system}) → { text, tool_calls, usage }
// chatStream({...})              → AsyncIterable yielding {delta} und {final}

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const PROVIDER = process.env.LLM_PROVIDER || "ollama";

const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || `\
Du bist JARVIS, Michaels persönlicher KI-Assistent.
Sprichst Deutsch (technische Begriffe englisch). Direkt, kurz, kein Geschwätz.
Wenn ein Tool helfen würde, nutze es ohne Rückfrage. Bei mehreren möglichen
Tools: nimm das passendste, nicht alle.`;

// ─── Anthropic ───────────────────────────────────────────────
class AnthropicProvider {
  constructor() {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY fehlt");
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    this.model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
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
}

function toAnthropicTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema || { type: "object", properties: {} }
  };
}

function toAnthropicMessages(messages) {
  // Neutrales Format → Anthropic content blocks
  const out = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      // Tool-Result als user-message mit tool_result-Block
      const last = out[out.length - 1];
      const block = {
        type: "tool_result",
        tool_use_id: m.tool_call_id,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content)
      };
      if (last && last.role === "user" && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    } else if (m.role === "assistant" && m.tool_calls?.length) {
      const blocks = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
      }
      out.push({ role: "assistant", content: blocks });
    } else {
      out.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
    }
  }
  return out;
}

function parseAnthropicResponse(res) {
  let text = "";
  const tool_calls = [];
  for (const c of res.content || []) {
    if (c.type === "text") text += c.text;
    else if (c.type === "tool_use") {
      tool_calls.push({ id: c.id, name: c.name, input: c.input });
    }
  }
  return {
    text,
    tool_calls: tool_calls.length ? tool_calls : null,
    stop_reason: res.stop_reason,
    usage: res.usage
  };
}

// ─── Ollama (OpenAI-compat) ─────────────────────────────────
class OllamaProvider {
  constructor() {
    const baseURL = (process.env.OLLAMA_URL || "http://ollama:11434").replace(/\/$/, "") + "/v1";
    this.client = new OpenAI({ baseURL, apiKey: "ollama" });
    this.model = process.env.OLLAMA_MODEL || "llama3.2";
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
    let full = "";
    const accCalls = [];
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        full += delta.content;
        yield { delta: delta.content };
      }
      // Tool-Call Akkumulation (Ollama liefert sie meist am Stück, OpenAI in Fragmenten)
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
    const tool_calls = accCalls
      .filter(c => c.name)
      .map(c => ({ id: c.id || `call_${Math.random().toString(36).slice(2, 10)}`,
                   name: c.name,
                   input: safeJsonParse(c.arguments) }));
    yield { final: { text: full, tool_calls: tool_calls.length ? tool_calls : null, usage: null } };
  }
}

function toOpenAITool(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema || { type: "object", properties: {} }
    }
  };
}

function toOpenAIMessages(messages, system) {
  const out = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: m.tool_call_id,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content)
      });
    } else if (m.role === "assistant" && m.tool_calls?.length) {
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.tool_calls.map(tc => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.input) }
        }))
      });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

function parseOpenAIResponse(res) {
  const choice = res.choices[0];
  const msg = choice?.message || {};
  const tool_calls = (msg.tool_calls || []).map(tc => ({
    id: tc.id,
    name: tc.function?.name,
    input: safeJsonParse(tc.function?.arguments || "{}")
  }));
  return {
    text: msg.content || "",
    tool_calls: tool_calls.length ? tool_calls : null,
    stop_reason: choice?.finish_reason,
    usage: res.usage
  };
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

// ─── Provider-Factory ────────────────────────────────────────
let cached;
export function getProvider(name = PROVIDER) {
  if (cached?.name === name) return cached.instance;
  let instance;
  switch (name) {
    case "anthropic": instance = new AnthropicProvider(); break;
    case "ollama":    instance = new OllamaProvider();    break;
    default: throw new Error(`Unbekannter Provider: ${name}`);
  }
  cached = { name, instance };
  console.log(`[providers] active: ${name} (${instance.model})`);
  return instance;
}
