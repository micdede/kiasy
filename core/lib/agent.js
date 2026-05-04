// agent.js — minimaler Agent-Loop (Phase 3 Etappe 1, ohne Tools)
//
// handle({chatId, message}) → {text, messageId, usage}
// streamHandle({chatId, message}) → AsyncIterable mit {delta} und {done}

import * as db from "./db.js";
import { getProvider } from "./providers.js";

const HISTORY_LIMIT = Number(process.env.AGENT_HISTORY_LIMIT) || 30;

export async function handle({ chatId, message, provider }) {
  if (!chatId || !message) throw new Error("chatId+message erforderlich");

  // 1. User-Message persistieren
  db.saveMessage({ chatId, role: "user", content: message });

  // 2. Verlauf laden + LLM aufrufen
  const messages = db.getRecentMessages(chatId, HISTORY_LIMIT)
    .map(m => ({ role: m.role, content: m.content }));

  const llm = getProvider(provider);
  const result = await llm.chat(messages);

  // 3. Assistant-Antwort persistieren
  const messageId = db.saveMessage({
    chatId,
    role: "assistant",
    content: result.text,
    meta: { usage: result.usage, model: llm.model }
  });

  db.logEvent({
    type: "message",
    message: `chat:${chatId} ${result.text.length} chars`,
    meta: { usage: result.usage }
  });

  return { text: result.text, messageId, usage: result.usage };
}

export async function* streamHandle({ chatId, message, provider }) {
  if (!chatId || !message) throw new Error("chatId+message erforderlich");

  db.saveMessage({ chatId, role: "user", content: message });

  const messages = db.getRecentMessages(chatId, HISTORY_LIMIT)
    .map(m => ({ role: m.role, content: m.content }));

  const llm = getProvider(provider);
  let finalText = "";
  let finalUsage = null;

  for await (const ev of llm.chatStream(messages)) {
    if (ev.delta) {
      yield { delta: ev.delta };
    } else if (ev.final) {
      finalText = ev.final.text;
      finalUsage = ev.final.usage;
    }
  }

  const messageId = db.saveMessage({
    chatId,
    role: "assistant",
    content: finalText,
    meta: { usage: finalUsage, model: llm.model }
  });

  db.logEvent({
    type: "message",
    message: `chat:${chatId} stream ${finalText.length} chars`
  });

  yield { done: { text: finalText, messageId, usage: finalUsage } };
}
