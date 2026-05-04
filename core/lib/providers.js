// providers.js — LLM-Clients (Anthropic + Ollama via OpenAI-compat)
//
// Beide Provider implementieren:
//   chat(messages, opts)        → { text, usage }
//   chatStream(messages, opts)  → AsyncIterable yielding {delta} und {final}

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const PROVIDER = process.env.LLM_PROVIDER || "ollama";

const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || `\
Du bist JARVIS, Michaels persönlicher KI-Assistent.
Sprichst Deutsch (technische Begriffe englisch). Direkte, kurze Antworten,
kein Geschwätz. Gib zu, wenn du etwas nicht weißt.`;

// ─── Anthropic ───────────────────────────────────────────────
class AnthropicProvider {
  constructor() {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY fehlt für AnthropicProvider");
    }
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    this.model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
  }

  async chat(messages, opts = {}) {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: opts.maxTokens || Number(process.env.MAX_TOKENS) || 4096,
      system: opts.system || SYSTEM_PROMPT,
      messages: toAnthropic(messages)
    });
    const text = res.content.filter(c => c.type === "text").map(c => c.text).join("");
    return { text, usage: res.usage, raw: res };
  }

  async *chatStream(messages, opts = {}) {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: opts.maxTokens || Number(process.env.MAX_TOKENS) || 4096,
      system: opts.system || SYSTEM_PROMPT,
      messages: toAnthropic(messages)
    });
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { delta: event.delta.text };
      }
    }
    const final = await stream.finalMessage();
    const text = final.content.filter(c => c.type === "text").map(c => c.text).join("");
    yield { final: { text, usage: final.usage } };
  }
}

// ─── Ollama (OpenAI-kompatibel) ──────────────────────────────
class OllamaProvider {
  constructor() {
    const baseURL = (process.env.OLLAMA_URL || "http://ollama:11434").replace(/\/$/, "") + "/v1";
    this.client = new OpenAI({ baseURL, apiKey: "ollama" });  // dummy key, Ollama braucht keinen
    this.model = process.env.OLLAMA_MODEL || "llama3.2";
  }

  async chat(messages, opts = {}) {
    const res = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: opts.maxTokens || Number(process.env.MAX_TOKENS) || 4096,
      messages: toOpenAI(messages, opts.system || SYSTEM_PROMPT)
    });
    return {
      text: res.choices[0]?.message?.content || "",
      usage: res.usage,
      raw: res
    };
  }

  async *chatStream(messages, opts = {}) {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: opts.maxTokens || Number(process.env.MAX_TOKENS) || 4096,
      messages: toOpenAI(messages, opts.system || SYSTEM_PROMPT),
      stream: true
    });
    let full = "";
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || "";
      if (delta) {
        full += delta;
        yield { delta };
      }
    }
    yield { final: { text: full, usage: null } };
  }
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

// ─── Message-Format-Konverter ────────────────────────────────
function toAnthropic(messages) {
  // Anthropic erwartet [{role: "user"|"assistant", content: "..."}]
  // System wird separat übergeben.
  return messages
    .filter(m => m.role !== "system")
    .map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content
    }));
}

function toOpenAI(messages, system) {
  const out = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "system") continue;
    out.push({ role: m.role, content: m.content });
  }
  return out;
}
