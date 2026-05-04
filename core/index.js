// kiasy-core — HTTP-Server (Phase 3 Komplett-Sprint)

import http from "node:http";
import { readFileSync, existsSync } from "node:fs";

import * as db from "./lib/db.js";
import * as agent from "./lib/agent.js";
import * as tools from "./lib/tools.js";
import * as telegram from "./lib/telegram.js";
import * as scheduler from "./lib/scheduler.js";
import * as mailWatcher from "./lib/mail-watcher.js";
import * as whisper from "./lib/whisper.js";
import * as piper from "./lib/piper.js";

const PORT = Number(process.env.PORT || 8080);
const STARTED = Date.now();
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url)));

db.init();
telegram.start();
scheduler.start();
mailWatcher.start();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const sendJson = (status, obj) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.writeHead(status); res.end(JSON.stringify(obj));
  };

  try {
    // ─── /health ────────────────────────────────────────────
    if (url.pathname === "/health" && req.method === "GET") {
      return sendJson(200, {
        ok: true, service: "kiasy-core", version: pkg.version,
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
        phase: 3, etappe: "sprint",
        provider: process.env.LLM_PROVIDER || "ollama",
        model_anthropic: process.env.ANTHROPIC_MODEL,
        model_ollama:    process.env.OLLAMA_MODEL,
        telegram:    telegram.getInfo(),
        scheduler:   scheduler.getInfo(),
        mailWatcher: mailWatcher.getInfo(),
        tools:       toolInfo
      });
    }

    // ─── Tools ───────────────────────────────────────────────
    if (url.pathname === "/api/tools" && req.method === "GET") {
      const defs = await tools.getDefinitions();
      return sendJson(200, { count: defs.length, tools: defs });
    }
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
    if (url.pathname === "/api/tools/reload" && req.method === "POST") {
      tools.reload();
      const info = await tools.listInfo();
      return sendJson(200, { reloaded: true, ...info });
    }

    // ─── Chat ────────────────────────────────────────────────
    if (url.pathname === "/api/chat/history" && req.method === "GET") {
      const chatId = url.searchParams.get("chatId") || "default";
      const limit  = Number(url.searchParams.get("limit") || 30);
      return sendJson(200, { chatId, messages: db.getRecentMessages(chatId, limit) });
    }
    if (url.pathname === "/api/chat/send" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.message) return sendJson(400, { error: "message fehlt" });
      const result = await agent.handle({
        chatId: body.chatId || "default",
        message: body.message,
        provider: body.provider
      });
      return sendJson(200, { chatId: body.chatId || "default", ...result });
    }
    if (url.pathname === "/api/chat/send/stream" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.message) return sendJson(400, { error: "message fehlt" });
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      const sse = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
      try {
        for await (const ev of agent.streamHandle({
          chatId: body.chatId || "default",
          message: body.message,
          provider: body.provider
        })) {
          if (ev.delta) sse("delta", { text: ev.delta });
          if (ev.tool_use) sse("tool_use", ev.tool_use);
          if (ev.tool_result) sse("tool_result", ev.tool_result);
          if (ev.done)  sse("done", ev.done);
        }
      } catch (err) {
        sse("error", { error: String(err.message || err) });
      }
      return res.end();
    }

    // ─── Voice: Transcribe (audio in → Text) ─────────────────
    if (url.pathname === "/api/voice/transcribe" && req.method === "POST") {
      const buf = await readBinary(req);
      const lang = url.searchParams.get("lang") || "de";
      const result = await whisper.transcribe(buf, { language: lang, ext: url.searchParams.get("ext") || "m4a" });
      return sendJson(200, result);
    }

    // ─── Voice: Synthesize (Text → Audio) ────────────────────
    if (url.pathname === "/api/voice/synth" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.text) return sendJson(400, { error: "text fehlt" });
      const wav = await piper.synthesize(body.text, { voice: body.voice, asWav: true });
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length });
      return res.end(wav);
    }

    // ─── Voice-Chat (audio in → STT → agent → TTS → audio out + JSON) ─
    if (url.pathname === "/api/chat/voice" && req.method === "POST") {
      const buf = await readBinary(req);
      const chatId = url.searchParams.get("chatId") || "voice-default";
      const lang = url.searchParams.get("lang") || "de";

      const trans = await whisper.transcribe(buf, { language: lang });
      const result = await agent.handle({ chatId, message: trans.text || "" });
      const wav = await piper.synthesize(result.text, { asWav: true });

      // Multipart-Antwort wäre sauberer — pragmatisch: Text als Header, Audio als Body
      res.writeHead(200, {
        "Content-Type": "audio/wav",
        "X-Transcript": encodeURIComponent(trans.text || ""),
        "X-Reply":      encodeURIComponent(result.text || ""),
        "X-Turns":      String(result.turns)
      });
      return res.end(wav);
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
    req.on("data", c => { raw += c; if (raw.length > 5_000_000) reject(new Error("body too large")); });
    req.on("end",  () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

function readBinary(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", c => {
      total += c.length;
      if (total > 50_000_000) reject(new Error("body too large (>50MB)"));
      else chunks.push(c);
    });
    req.on("end",  () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ─── Graceful Shutdown ───────────────────────────────────────
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`[kiasy-core] ${sig} → shutdown`);
    mailWatcher.stop();
    scheduler.stop();
    telegram.stop();
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
