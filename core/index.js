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

    // ─── Tools: Settings (Toggle) ────────────────────────────
    if (url.pathname === "/api/tools/settings" && req.method === "GET") {
      const rows = db.get().prepare("SELECT filename, enabled, visibility, updated FROM tool_settings ORDER BY filename").all();
      return sendJson(200, { count: rows.length, settings: rows });
    }
    {
      const m = url.pathname.match(/^\/api\/tools\/settings\/(.+)$/);
      if (m && req.method === "POST") {
        const filename = decodeURIComponent(m[1]);
        const body = await readJson(req);
        const enabled = body.enabled ? 1 : 0;
        const visibility = body.visibility || "public";
        db.get().prepare(`
          INSERT INTO tool_settings(filename, enabled, visibility, updated)
          VALUES (?, ?, ?, datetime('now','localtime'))
          ON CONFLICT(filename) DO UPDATE SET enabled = excluded.enabled,
            visibility = excluded.visibility, updated = excluded.updated
        `).run(filename, enabled, visibility);
        tools.reload();
        return sendJson(200, { filename, enabled, visibility });
      }
    }

    // ─── Memory CRUD ─────────────────────────────────────────
    if (url.pathname === "/api/memory" && req.method === "GET") {
      const cat = url.searchParams.get("category");
      const q   = url.searchParams.get("q");
      const limit = Math.min(Number(url.searchParams.get("limit") || 100), 500);
      let sql = "SELECT id, category, key, value, added FROM memory";
      const params = [];
      const wheres = [];
      if (cat) { wheres.push("category = ?"); params.push(cat); }
      if (q)   {
        wheres.push("id IN (SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?)");
        params.push(q);
      }
      if (wheres.length) sql += " WHERE " + wheres.join(" AND ");
      sql += " ORDER BY id DESC LIMIT ?";
      params.push(limit);
      const items = db.get().prepare(sql).all(...params);
      return sendJson(200, { count: items.length, items });
    }
    if (url.pathname === "/api/memory" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.category || !body.value) return sendJson(400, { error: "category+value erforderlich" });
      const info = db.get().prepare(`
        INSERT INTO memory(category, key, value, added)
        VALUES (?, ?, ?, date('now','localtime'))
      `).run(body.category, body.key || null, body.value);
      return sendJson(200, { id: Number(info.lastInsertRowid) });
    }
    {
      const m = url.pathname.match(/^\/api\/memory\/(\d+)$/);
      if (m && req.method === "DELETE") {
        const info = db.get().prepare("DELETE FROM memory WHERE id = ?").run(Number(m[1]));
        return sendJson(200, { deleted: info.changes });
      }
      if (m && req.method === "PUT") {
        const body = await readJson(req);
        const info = db.get().prepare("UPDATE memory SET value = ?, key = ? WHERE id = ?")
                       .run(body.value, body.key || null, Number(m[1]));
        return sendJson(200, { updated: info.changes });
      }
    }

    // ─── Reminders CRUD ──────────────────────────────────────
    if (url.pathname === "/api/reminders" && req.method === "GET") {
      const done = url.searchParams.get("done");
      let sql = "SELECT * FROM reminders";
      const params = [];
      if (done === "0" || done === "1") { sql += " WHERE done = ?"; params.push(Number(done)); }
      sql += " ORDER BY due ASC LIMIT 200";
      return sendJson(200, { items: db.get().prepare(sql).all(...params) });
    }
    if (url.pathname === "/api/reminders" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.text || !body.due) return sendJson(400, { error: "text+due erforderlich" });
      const info = db.get().prepare(`
        INSERT INTO reminders(text, due, chat_id, type, interval_hours)
        VALUES (?, ?, ?, ?, ?)
      `).run(body.text, body.due, body.chat_id || process.env.TELEGRAM_OWNER_CHAT_ID || null,
             body.type || "oneshot", body.interval_hours || null);
      return sendJson(200, { id: Number(info.lastInsertRowid) });
    }
    {
      const m = url.pathname.match(/^\/api\/reminders\/(\d+)$/);
      if (m && req.method === "PUT") {
        const body = await readJson(req);
        const sets = []; const params = [];
        for (const k of ["done", "text", "due"]) {
          if (k in body) { sets.push(`${k} = ?`); params.push(body[k]); }
        }
        if (!sets.length) return sendJson(400, { error: "nichts zu ändern" });
        params.push(Number(m[1]));
        const info = db.get().prepare(`UPDATE reminders SET ${sets.join(", ")} WHERE id = ?`).run(...params);
        return sendJson(200, { updated: info.changes });
      }
      if (m && req.method === "DELETE") {
        const info = db.get().prepare("DELETE FROM reminders WHERE id = ?").run(Number(m[1]));
        return sendJson(200, { deleted: info.changes });
      }
    }

    // ─── News-Sources CRUD ───────────────────────────────────
    if (url.pathname === "/api/news/sources" && req.method === "GET") {
      return sendJson(200, { items: db.get().prepare("SELECT * FROM news_sources ORDER BY type, name").all() });
    }
    if (url.pathname === "/api/news/sources" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.type || !body.name || !body.url) return sendJson(400, { error: "type+name+url erforderlich" });
      const info = db.get().prepare(`
        INSERT INTO news_sources(type, name, url, api_key, category, enabled)
        VALUES (?, ?, ?, ?, ?, 1)
      `).run(body.type, body.name, body.url, body.api_key || null, body.category || null);
      return sendJson(200, { id: Number(info.lastInsertRowid) });
    }
    {
      const m = url.pathname.match(/^\/api\/news\/sources\/(\d+)$/);
      if (m && req.method === "PUT") {
        const body = await readJson(req);
        const sets = []; const params = [];
        for (const k of ["enabled", "name", "url", "api_key", "category"]) {
          if (k in body) { sets.push(`${k} = ?`); params.push(body[k]); }
        }
        if (!sets.length) return sendJson(400, { error: "nichts zu ändern" });
        params.push(Number(m[1]));
        const info = db.get().prepare(`UPDATE news_sources SET ${sets.join(", ")} WHERE id = ?`).run(...params);
        return sendJson(200, { updated: info.changes });
      }
      if (m && req.method === "DELETE") {
        const info = db.get().prepare("DELETE FROM news_sources WHERE id = ?").run(Number(m[1]));
        return sendJson(200, { deleted: info.changes });
      }
    }

    // ─── Health-Check (Upstream-Pings) ───────────────────────
    if (url.pathname === "/api/health/check" && req.method === "GET") {
      const checks = [
        { name: "ollama",  url: `${process.env.OLLAMA_URL}/api/tags`, expect: 200 },
        { name: "qdrant",  url: `${process.env.QDRANT_URL}/`, expect: 200 },
        { name: "whisper", url: `${process.env.WHISPER_URL}/`, expect: 200 },
        { name: "searxng", url: `${process.env.SEARXNG_URL}/healthz`, expect: 200 }
      ];
      const results = await Promise.all(checks.map(async c => {
        const t0 = Date.now();
        try {
          const r = await fetch(c.url, { signal: AbortSignal.timeout(3000) });
          return { name: c.name, ok: r.status === c.expect, status: r.status, latency_ms: Date.now() - t0 };
        } catch (e) {
          return { name: c.name, ok: false, error: e.message, latency_ms: Date.now() - t0 };
        }
      }));
      // Piper TCP-Check separat
      const piperResult = await new Promise(resolve => {
        const t0 = Date.now();
        import("node:net").then(({ connect }) => {
          const s = connect({ host: process.env.PIPER_HOST || "piper", port: Number(process.env.PIPER_PORT || 10200) });
          const cleanup = (ok, err) => { s.destroy(); resolve({ name: "piper", ok, latency_ms: Date.now() - t0, error: err }); };
          s.on("connect", () => cleanup(true, null));
          s.on("error", e => cleanup(false, e.message));
          setTimeout(() => cleanup(false, "timeout"), 3000);
        });
      });
      results.push(piperResult);
      return sendJson(200, { checks: results, all_ok: results.every(r => r.ok) });
    }

    // ─── Settings GET (laufende Werte aus process.env) ─────
    if (url.pathname === "/api/settings" && req.method === "GET") {
      return sendJson(200, currentSettings());
    }

    // ─── Restart (über deploy-Sidecar) ──────────────────────
    if (url.pathname === "/api/restart" && req.method === "POST") {
      const body = await readJson(req);
      const svc = body.service || "kiasy-core";
      if (!/^[a-z0-9-]+$/.test(svc)) return sendJson(400, { error: "service-Name ungültig" });
      const fs = await import("node:fs");
      try {
        fs.writeFileSync(`/host/.recreate-${svc}`, "");
        return sendJson(202, { triggered: svc, hint: "Container kommt in 2-5s neu hoch" });
      } catch (err) {
        return sendJson(500, { error: "Trigger nicht schreibbar — deploy-Sidecar läuft?" });
      }
    }

    // ─── Settings PUT (.env-Datei updaten) ──────────────────
    if (url.pathname === "/api/settings" && req.method === "PUT") {
      const body = await readJson(req);
      const updates = body.updates || {};
      const path = "/host/.env";
      const fs = await import("node:fs");
      if (!fs.existsSync(path)) return sendJson(500, { error: ".env nicht gemountet auf /host/.env" });
      let content = fs.readFileSync(path, "utf8");
      for (const [k, v] of Object.entries(updates)) {
        const safeV = String(v ?? "");
        const re = new RegExp(`^(\\s*)${k}\\s*=.*$`, "m");
        if (re.test(content)) {
          content = content.replace(re, `$1${k}=${safeV}`);
        } else {
          content += (content.endsWith("\n") ? "" : "\n") + `${k}=${safeV}\n`;
        }
      }
      fs.writeFileSync(path, content);
      return sendJson(200, { saved: Object.keys(updates).length, restart_needed: true,
        hint: "sudo docker compose -f /home/mcde/kiasy/docker-compose.yml --project-directory /home/mcde/kiasy up -d kiasy-core" });
    }

    // ─── Notes (Markdown KB-Editor) ──────────────────────────
    if (url.pathname === "/api/notes" && req.method === "GET") {
      const fs = await import("node:fs");
      const dir = "/data/notes";
      if (!fs.existsSync(dir)) return sendJson(200, { items: [] });
      const items = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith(".md"))
        .map(e => {
          const st = fs.statSync(`${dir}/${e.name}`);
          return { filename: e.name, size: st.size, modified: st.mtime.toISOString() };
        }).sort((a,b) => b.modified.localeCompare(a.modified));
      return sendJson(200, { items });
    }
    {
      const m = url.pathname.match(/^\/api\/notes\/(.+)$/);
      if (m) {
        const fs = await import("node:fs");
        const filename = decodeURIComponent(m[1]);
        if (!/^[\w\-. ]+\.md$/.test(filename)) return sendJson(400, { error: "Ungültiger Dateiname" });
        const filepath = `/data/notes/${filename}`;
        if (req.method === "GET") {
          if (!fs.existsSync(filepath)) return sendJson(404, { error: "nicht gefunden" });
          return sendJson(200, { filename, content: fs.readFileSync(filepath, "utf8") });
        }
        if (req.method === "PUT") {
          const body = await readJson(req);
          fs.writeFileSync(filepath, body.content || "");
          return sendJson(200, { filename, saved: true, size: Buffer.byteLength(body.content || "") });
        }
        if (req.method === "DELETE") {
          if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
          return sendJson(200, { deleted: true });
        }
      }
    }

    // ─── Workflows ───────────────────────────────────────────
    if (url.pathname === "/api/workflows" && req.method === "GET") {
      const items = db.get().prepare("SELECT id, name, status, current_step, chat_id, created_at, updated_at FROM workflows ORDER BY id DESC LIMIT 50").all();
      return sendJson(200, { items });
    }
    if (url.pathname === "/api/workflows" && req.method === "POST") {
      const body = await readJson(req);
      const result = await tools.execute("workflow_create", body);
      return sendJson(200, result);
    }
    {
      const m = url.pathname.match(/^\/api\/workflows\/(\d+)$/);
      if (m && req.method === "GET") {
        const wf = db.get().prepare("SELECT * FROM workflows WHERE id = ?").get(Number(m[1]));
        if (!wf) return sendJson(404, { error: "nicht gefunden" });
        const steps = db.get().prepare("SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_num").all(Number(m[1]));
        return sendJson(200, { ...wf, steps });
      }
      if (m && req.method === "DELETE") {
        const tx = db.get().transaction(() => {
          db.get().prepare("DELETE FROM workflow_steps WHERE workflow_id = ?").run(Number(m[1]));
          db.get().prepare("DELETE FROM workflows WHERE id = ?").run(Number(m[1]));
        });
        tx();
        return sendJson(200, { deleted: true });
      }
    }

    // ─── Delegations ─────────────────────────────────────────
    if (url.pathname === "/api/delegations" && req.method === "GET") {
      const items = db.get().prepare("SELECT * FROM delegations ORDER BY id DESC LIMIT 100").all();
      return sendJson(200, { items });
    }
    if (url.pathname === "/api/delegations" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.assignee || !body.subject) return sendJson(400, { error: "assignee+subject erforderlich" });
      const info = db.get().prepare(`
        INSERT INTO delegations(assignee, assignee_email, subject, body, deadline, status, followup_days)
        VALUES (?, ?, ?, ?, ?, 'open', ?)
      `).run(body.assignee, body.assignee_email || null, body.subject, body.body || null,
             body.deadline || null, body.followup_days || 3);
      return sendJson(200, { id: Number(info.lastInsertRowid) });
    }
    {
      const m = url.pathname.match(/^\/api\/delegations\/(\d+)$/);
      if (m && req.method === "PUT") {
        const body = await readJson(req);
        const sets = []; const params = [];
        for (const k of ["status", "deadline", "followup_days", "subject", "body"]) {
          if (k in body) { sets.push(`${k} = ?`); params.push(body[k]); }
        }
        if (!sets.length) return sendJson(400, { error: "nichts zu ändern" });
        params.push(Number(m[1]));
        const info = db.get().prepare(`UPDATE delegations SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`).run(...params);
        return sendJson(200, { updated: info.changes });
      }
      if (m && req.method === "DELETE") {
        const info = db.get().prepare("DELETE FROM delegations WHERE id = ?").run(Number(m[1]));
        return sendJson(200, { deleted: info.changes });
      }
    }

    // ─── Home Assistant Devices (Markdown-Editor) ───────────
    if (url.pathname === "/api/ha/devices" && req.method === "GET") {
      const fs = await import("node:fs");
      const path = "/data/ha-devices.md";
      const content = fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";
      return sendJson(200, { content });
    }
    if (url.pathname === "/api/ha/devices" && req.method === "PUT") {
      const fs = await import("node:fs");
      const body = await readJson(req);
      fs.writeFileSync("/data/ha-devices.md", body.content || "");
      return sendJson(200, { saved: true, size: Buffer.byteLength(body.content || "") });
    }
    if (url.pathname === "/api/ha/devices/regenerate" && req.method === "POST") {
      // Hole alle states von HA, baue eine kompakte Markdown-Liste
      const states = await tools.execute("ha_states", {});
      const fs = await import("node:fs");
      const lines = ["# Home Assistant Devices", "",
        `Generiert: ${new Date().toISOString()}`, "",
        `Total: ${states.total}`, "",
        "## By Domain", ""
      ];
      for (const [dom, n] of Object.entries(states.by_domain)) {
        lines.push(`- **${dom}**: ${n}`);
      }
      const content = lines.join("\n") + "\n";
      fs.writeFileSync("/data/ha-devices.md", content);
      return sendJson(200, { saved: true, lines: lines.length });
    }

    // ─── Labs ────────────────────────────────────────────────
    if (url.pathname === "/api/labs" && req.method === "GET") {
      const items = db.get().prepare("SELECT * FROM labs_items ORDER BY id DESC").all();
      return sendJson(200, { items });
    }
    if (url.pathname === "/api/labs" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.title) return sendJson(400, { error: "title erforderlich" });
      const info = db.get().prepare(`
        INSERT INTO labs_items(title, description, type, status, notes)
        VALUES (?, ?, ?, ?, ?)
      `).run(body.title, body.description || null, body.type || "idea", body.status || "idee", body.notes || null);
      return sendJson(200, { id: Number(info.lastInsertRowid) });
    }
    {
      const m = url.pathname.match(/^\/api\/labs\/(\d+)$/);
      if (m && req.method === "PUT") {
        const body = await readJson(req);
        const sets = []; const params = [];
        for (const k of ["title", "description", "type", "status", "notes", "tool_link"]) {
          if (k in body) { sets.push(`${k} = ?`); params.push(body[k]); }
        }
        if (!sets.length) return sendJson(400, { error: "nichts zu ändern" });
        params.push(Number(m[1]));
        const info = db.get().prepare(`UPDATE labs_items SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`).run(...params);
        return sendJson(200, { updated: info.changes });
      }
      if (m && req.method === "DELETE") {
        const info = db.get().prepare("DELETE FROM labs_items WHERE id = ?").run(Number(m[1]));
        return sendJson(200, { deleted: info.changes });
      }
    }

    // ─── Backup-Liste ────────────────────────────────────────
    if (url.pathname === "/api/backup/list" && req.method === "GET") {
      const fs = await import("node:fs");
      const dir = "/host/backups";
      if (!fs.existsSync(dir)) return sendJson(200, { items: [], note: "/host/backups nicht gemountet" });
      const items = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith(".tar.gz"))
        .map(e => {
          const st = fs.statSync(`${dir}/${e.name}`);
          return { filename: e.name, size: st.size, size_human: humanSize(st.size), created: st.mtime.toISOString() };
        }).sort((a,b) => b.created.localeCompare(a.created));
      return sendJson(200, { items, dir });
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

function currentSettings() {
  return {
    provider: process.env.LLM_PROVIDER,
    models: { ollama: process.env.OLLAMA_MODEL, anthropic: process.env.ANTHROPIC_MODEL },
    flags: {
      telegram_enabled:    process.env.TELEGRAM_ENABLED === "true",
      scheduler_enabled:   process.env.SCHEDULER_ENABLED === "true",
      mail_watcher_enabled: process.env.MAIL_WATCHER_ENABLED === "true",
      telegram_voice_reply: process.env.TELEGRAM_VOICE_REPLY === "true"
    },
    tts: { piper_voice: process.env.PIPER_VOICE },
    stt: { whisper_model: process.env.WHISPER_MODEL },
    whitelist: (process.env.TELEGRAM_ALLOWED_USERS || "").split(",").filter(Boolean),
    embed_model: process.env.EMBED_MODEL,
    max_tokens: process.env.MAX_TOKENS
  };
}

function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  if (n < 1024*1024*1024) return `${(n/1024/1024).toFixed(1)} MB`;
  return `${(n/1024/1024/1024).toFixed(2)} GB`;
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
