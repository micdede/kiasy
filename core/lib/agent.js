// agent.js — Agent-Loop mit Tool-Calls (Phase 3 Etappe 3)
//
// handle({chatId, message}) → {text, turns, messageId, usage}
//   max MAX_TURNS Iterationen: LLM → tool_calls? → execute → next turn
//
// streamHandle yieldet {delta} während LLM streamt + {tool_use, tool_result, done}

import * as db from "./db.js";
import * as tools from "./tools.js";
import { getProvider } from "./providers.js";

const HISTORY_LIMIT = Number(process.env.AGENT_HISTORY_LIMIT) || 30;
const MAX_TURNS     = Number(process.env.AGENT_MAX_TURNS) || 10;

export async function handle({ chatId, message, provider }) {
  if (!chatId || !message) throw new Error("chatId+message erforderlich");

  // 1. User-Message persistieren
  db.saveMessage({ chatId, role: "user", content: message });

  // 2. Verlauf laden + Tools holen
  const history = loadHistory(chatId);
  const toolDefs = await tools.getDefinitions();
  const llm = getProvider(provider);

  // 3. Loop bis kein tool_use mehr ODER MAX_TURNS
  const messages = [...history];
  let lastText = "";
  let lastUsage = null;
  let turn = 0;

  while (turn < MAX_TURNS) {
    turn++;
    const res = await llm.chat({ messages, tools: toolDefs });
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
      let result;
      try {
        result = await tools.execute(tc.name, tc.input);
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

  // 4. Finale Assistant-Antwort speichern
  const messageId = db.saveMessage({
    chatId, role: "assistant", content: lastText,
    meta: { usage: lastUsage, model: llm.model, turn, final: true }
  });

  db.logEvent({
    type: "message",
    message: `chat:${chatId} ${turn} turn(s) ${lastText.length} chars`,
    meta: { usage: lastUsage, turns: turn }
  });

  return { text: lastText, turns: turn, messageId, usage: lastUsage };
}

export async function* streamHandle({ chatId, message, provider }) {
  if (!chatId || !message) throw new Error("chatId+message erforderlich");

  db.saveMessage({ chatId, role: "user", content: message });

  const history = loadHistory(chatId);
  const toolDefs = await tools.getDefinitions();
  const llm = getProvider(provider);

  const messages = [...history];
  let lastText = "";
  let lastUsage = null;
  let turn = 0;

  while (turn < MAX_TURNS) {
    turn++;
    let streamedText = "";
    let toolCallsInTurn = null;

    for await (const ev of llm.chatStream({ messages, tools: toolDefs })) {
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
      yield { tool_use: { name: tc.name, input: tc.input } };
      let result;
      try {
        result = await tools.execute(tc.name, tc.input);
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
    meta: { usage: lastUsage, model: llm.model, turn, final: true }
  });

  yield { done: { text: lastText, turns: turn, messageId, usage: lastUsage } };
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
