// kiasy-core — HTTP-Server (Phase 3 Etappe 1)
//
// Endpoints:
//   GET  /health              — System-Status + Upstreams
//   GET  /api/status          — Phase-Info
//   POST /api/chat/send       — { chatId?, message, provider? } → { text, messageId }
//   POST /api/chat/send/stream — SSE-Stream mit delta/done events
//   GET  /api/chat/history?chatId=… → { messages: [...] }

import http from "node:http";
import { readFileSync, existsSync } from "node:fs";

import * as db from "./lib/db.js";
import * as agent from "./lib/agent.js";
import * as tools from "./lib/tools.js";
import * as telegram from "./lib/telegram.js";
import * as scheduler from "./lib/scheduler.js";
import { getProvider } from "./lib/providers.js";

const PORT = Number(process.env.PORT || 8080);
const STARTED = Date.now();
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url)));

// DB initialisieren (führt Migrations aus)
db.init();
// Telegram + Scheduler starten (beide respektieren _ENABLED env)
telegram.start();
scheduler.start();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const setJson  = () => res.setHeader("Content-Type", "application/json; charset=utf-8");
  const sendJson = (status, obj) => { setJson(); res.writeHead(status); res.end(JSON.stringify(obj)); };

  try {
    // ─── /health ────────────────────────────────────────────
    if (url.pathname === "/health" && req.method === "GET") {
      return sendJson(200, {
        ok: true,
        service: "kiasy-core",
        version: pkg.version,
        uptime_s: Math.round((Date.now() - STARTED) / 1000),
        upstreams: upstreams(),
        data_volume_mounted: existsSync("/data"),
        db: { messages: db.countMessages() }
      });
    }

    // ─── /api/status ────────────────────────────────────────
    if (url.pathname === "/api/status" && req.method === "GET") {
      const toolInfo = await tools.listInfo();
      return sendJson(200, {
        phase: 3,
        etappe: 3,
        provider: process.env.LLM_PROVIDER || "ollama",
        model_anthropic: process.env.ANTHROPIC_MODEL,
        model_ollama:    process.env.OLLAMA_MODEL,
        telegram:  telegram.getInfo(),
        scheduler: scheduler.getInfo(),
        tools:     toolInfo
      });
    }

    // ─── /api/tools ─────────────────────────────────────────
    if (url.pathname === "/api/tools" && req.method === "GET") {
      const defs = await tools.getDefinitions();
      return sendJson(200, { count: defs.length, tools: defs });
    }

    // ─── /api/tools/exec ────────────────────────────────────
    if (url.pathname === "/api/tools/exec" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.name) return sendJson(400, { error: "name fehlt" });
      try {
        const result = await tools.execute(body.name, body.input || {});
        return sendJson(200, { name: body.name, result });
      } catch (err) {
        return sendJson(500, { name: body.name, error: String(err.message || err) });
      }
    }

    // ─── /api/tools/reload ──────────────────────────────────
    if (url.pathname === "/api/tools/reload" && req.method === "POST") {
      tools.reload();
      const info = await tools.listInfo();
      return sendJson(200, { reloaded: true, ...info });
    }

    // ─── /api/chat/history ──────────────────────────────────
    if (url.pathname === "/api/chat/history" && req.method === "GET") {
      const chatId = url.searchParams.get("chatId") || "default";
      const limit  = Number(url.searchParams.get("limit") || 30);
      const messages = db.getRecentMessages(chatId, limit);
      return sendJson(200, { chatId, messages });
    }

    // ─── /api/chat/send ─────────────────────────────────────
    if (url.pathname === "/api/chat/send" && req.method === "POST") {
      const body = await readJson(req);
      const chatId  = body.chatId || "default";
      const message = body.message;
      const provider = body.provider;
      if (!message) return sendJson(400, { error: "message fehlt" });

      const result = await agent.handle({ chatId, message, provider });
      return sendJson(200, { chatId, ...result });
    }

    // ─── /api/chat/send/stream (SSE) ────────────────────────
    if (url.pathname === "/api/chat/send/stream" && req.method === "POST") {
      const body = await readJson(req);
      const chatId  = body.chatId || "default";
      const message = body.message;
      const provider = body.provider;
      if (!message) return sendJson(400, { error: "message fehlt" });

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      try {
        for await (const ev of agent.streamHandle({ chatId, message, provider })) {
          if (ev.delta) sse("delta", { text: ev.delta });
          if (ev.done)  sse("done", ev.done);
        }
      } catch (err) {
        sse("error", { error: String(err.message || err) });
      }
      return res.end();
    }

    // ─── 404 ────────────────────────────────────────────────
    return sendJson(404, { error: "Not Found", path: url.pathname });
  } catch (err) {
    console.error("[kiasy-core] handler error:", err);
    return sendJson(500, { error: String(err.message || err) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[kiasy-core] v${pkg.version} listening on :${PORT}`);
  console.log(`[kiasy-core] provider: ${process.env.LLM_PROVIDER || "ollama"}`);
});

// ─── Helpers ─────────────────────────────────────────────────
function upstreams() {
  return {
    ollama:  process.env.OLLAMA_URL  || null,
    qdrant:  process.env.QDRANT_URL  || null,
    whisper: process.env.WHISPER_URL || null,
    piper:   process.env.PIPER_HOST ? `${process.env.PIPER_HOST}:${process.env.PIPER_PORT||"10200"}` : null,
    searxng: process.env.SEARXNG_URL || null
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 1_000_000) reject(new Error("body too large")); });
    req.on("end",  () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

// ─── Graceful Shutdown ───────────────────────────────────────
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`[kiasy-core] ${sig} → shutdown`);
    scheduler.stop();
    telegram.stop();
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
