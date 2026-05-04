// kiasy-monitor — Web-UI (Sprint: + /chat Page)

import express from "express";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.PORT || 3000);
const CORE_URL = process.env.CORE_URL || "http://kiasy-core:8080";
const STARTED = Date.now();
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url)));

const app = express();
app.disable("x-powered-by");
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "kiasy-monitor", version: pkg.version,
             uptime_s: Math.round((Date.now() - STARTED) / 1000), core_url: CORE_URL });
});

app.get("/", async (req, res) => {
  let coreStatus = "unbekannt", upstreams = {};
  try {
    const r = await fetch(`${CORE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    const data = await r.json();
    coreStatus = r.ok ? "online" : `HTTP ${r.status}`;
    upstreams = data.upstreams || {};
  } catch { coreStatus = "offline"; }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(layout({ title: "kiasy", body: `
    <section class="hero">
      <h1>kiasy</h1>
      <p class="tag">v${pkg.version} · Phase 3 Komplett-Sprint</p>
    </section>
    <section class="cards">
      <a href="/chat" class="card-link"><div class="card"><h3>Chat</h3><p class="status ok">öffnen →</p><small>Web-UI</small></div></a>
      <div class="card"><h3>Core</h3><p class="status ${coreStatus === "online" ? "ok" : "err"}">${coreStatus}</p><small>${CORE_URL}</small></div>
      <div class="card"><h3>Upstreams</h3><p class="status ok">${Object.values(upstreams).filter(Boolean).length}/${Object.keys(upstreams).length}</p><small>online</small></div>
    </section>
    <section class="info">
      <h2>API-Endpoints</h2>
      <ul class="grid">
        <li>POST /api/chat/send</li>
        <li>POST /api/chat/send/stream</li>
        <li>GET /api/chat/history</li>
        <li>GET /api/tools</li>
        <li>POST /api/tools/exec</li>
        <li>POST /api/voice/transcribe</li>
        <li>POST /api/voice/synth</li>
        <li>POST /api/chat/voice</li>
        <li>GET /api/status</li>
      </ul>
    </section>
  `}));
});

app.get("/chat", async (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(layout({ title: "Chat — kiasy", body: chatBody() }));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[kiasy-monitor] v${pkg.version} listening on :${PORT}`);
});

// ─── Templates ───────────────────────────────────────────────
function chatBody() {
  return `
    <section class="chat-wrap">
      <header class="chat-header">
        <a href="/" class="back">← zurück</a>
        <h2>Chat</h2>
        <button id="clear" class="clear-btn">leeren</button>
      </header>
      <div id="messages" class="messages"></div>
      <form id="form" class="input-form">
        <textarea id="input" placeholder="Nachricht…" rows="2" autofocus></textarea>
        <button type="submit" id="send">Send</button>
      </form>
    </section>
    <style>
      .chat-wrap { display:flex; flex-direction:column; height: calc(100vh - 64px); max-width: 800px; margin: 0 auto; }
      .chat-header { display:flex; align-items:center; gap:16px; padding-bottom:16px; border-bottom: 1px solid var(--border); margin-bottom:16px; }
      .chat-header h2 { font-size:18px; flex:1; }
      .back, .clear-btn { color: var(--text-dim); font-size:13px; background:none; border:none; cursor:pointer; text-decoration:none; }
      .back:hover, .clear-btn:hover { color: var(--accent); }
      .messages { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:12px; padding-right:8px; }
      .msg { padding: 12px 16px; border-radius: 12px; max-width: 85%; line-height:1.5; word-wrap:break-word; white-space:pre-wrap; }
      .msg.user { background: var(--accent-soft); border:1px solid rgba(78,201,255,0.3); align-self:flex-end; }
      .msg.assistant { background: var(--bg-card); border:1px solid var(--border); align-self:flex-start; }
      .msg.tool { background: var(--bg-elevated); border:1px solid var(--border); align-self:flex-start; font-family: var(--mono); font-size:12px; color: var(--text-dim); max-width: 95%; }
      .msg.error { background: rgba(255,107,122,0.15); border:1px solid var(--err); align-self:flex-start; color: var(--err); }
      .msg .role { font-size:11px; color: var(--text-dim); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px; }
      .input-form { display:flex; gap:8px; padding-top:16px; border-top:1px solid var(--border); margin-top:16px; }
      .input-form textarea { flex:1; padding:10px 14px; background: var(--bg-card); border:1px solid var(--border); border-radius: var(--radius); color: var(--text); font-family: var(--font); font-size:14px; resize:none; }
      .input-form textarea:focus { outline:none; border-color: var(--accent); }
      .input-form button { padding: 0 20px; background: var(--accent); color: var(--bg); border:none; border-radius: var(--radius); font-weight:600; cursor:pointer; }
      .input-form button:disabled { opacity:0.4; cursor:not-allowed; }
      .card-link { text-decoration:none; color:inherit; }
    </style>
    <script>
      const messages = document.getElementById('messages');
      const form = document.getElementById('form');
      const input = document.getElementById('input');
      const send = document.getElementById('send');
      const clear = document.getElementById('clear');
      const CHAT_ID = 'web-chat';

      function addMsg(role, text) {
        const div = document.createElement('div');
        div.className = 'msg ' + role;
        div.innerHTML = '<div class="role">' + role + '</div><div class="text"></div>';
        div.querySelector('.text').textContent = text;
        messages.appendChild(div);
        messages.scrollTop = messages.scrollHeight;
        return div.querySelector('.text');
      }

      async function loadHistory() {
        try {
          const r = await fetch('/api/chat/history?chatId=' + CHAT_ID + '&limit=30');
          const data = await r.json();
          for (const m of data.messages || []) {
            if (m.role === 'system') continue;
            addMsg(m.role, m.content);
          }
        } catch(e) { console.error(e); }
      }

      clear.addEventListener('click', async () => {
        if (!confirm('Verlauf für diesen Web-Chat leeren?')) return;
        messages.innerHTML = '';
      });

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        send.disabled = true;
        addMsg('user', text);
        const target = addMsg('assistant', '');

        try {
          const res = await fetch('/api/chat/send/stream', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ chatId: CHAT_ID, message: text })
          });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let acc = '';
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split('\\n\\n');
            buffer = events.pop();
            for (const ev of events) {
              const lines = ev.split('\\n');
              const type = lines.find(l => l.startsWith('event: '))?.slice(7);
              const dataLine = lines.find(l => l.startsWith('data: '))?.slice(6);
              if (!dataLine) continue;
              const data = JSON.parse(dataLine);
              if (type === 'delta') {
                acc += data.text;
                target.textContent = acc;
                messages.scrollTop = messages.scrollHeight;
              } else if (type === 'tool_use') {
                addMsg('tool', '🔧 ' + data.name + '(' + JSON.stringify(data.input) + ')');
              } else if (type === 'tool_result') {
                addMsg('tool', '↳ ' + JSON.stringify(data.result).slice(0, 300));
              } else if (type === 'error') {
                addMsg('error', data.error);
              }
            }
          }
        } catch (err) {
          addMsg('error', err.message);
        } finally {
          send.disabled = false;
          input.focus();
        }
      });

      // Proxy-Routes über monitor zu core werden in Express weiter unten definiert
      loadHistory();
    </script>
  `;
}

// API-Proxy-Routes (Browser → monitor → core, da nur monitor erreichbar ist)
const proxyPaths = [
  ["GET",  "/api/chat/history"],
  ["POST", "/api/chat/send"],
  ["POST", "/api/chat/send/stream"],
  ["GET",  "/api/status"],
  ["GET",  "/api/tools"]
];
for (const [method, path] of proxyPaths) {
  app[method.toLowerCase()](path, async (req, res) => {
    try {
      const url = new URL(path, CORE_URL);
      for (const [k, v] of Object.entries(req.query)) url.searchParams.append(k, v);
      const headers = { "Content-Type": "application/json" };
      const body = method === "POST" ? JSON.stringify(req.body) : undefined;
      const upstream = await fetch(url, { method, headers, body });
      res.status(upstream.status);
      if (path.endsWith("/stream")) {
        res.setHeader("Content-Type", "text/event-stream");
        upstream.body.pipeTo(new WritableStream({
          write(chunk) { res.write(chunk); },
          close() { res.end(); }
        })).catch(() => res.end());
      } else {
        const data = await upstream.text();
        res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
        res.send(data);
      }
    } catch (err) {
      res.status(502).json({ error: "core unreachable", detail: err.message });
    }
  });
}

function layout({ title, body }) {
  return `<!doctype html>
<html lang="de" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root {
      --bg: #0b0d12; --bg-card: #131722; --bg-elevated: #1a1f2e; --border: #232938;
      --text: #e6e9f0; --text-dim: #8b94a8;
      --accent: #4ec9ff; --accent-soft: rgba(78, 201, 255, 0.12);
      --ok: #6fe5a4; --err: #ff6b7a; --warn: #ffb86b;
      --radius: 10px; --space: 16px;
      --font: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;
      --mono: "SF Mono", Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { background: var(--bg); color: var(--text); font-family: var(--font); -webkit-font-smoothing: antialiased; }
    body { min-height: 100vh; padding: 32px 20px; }
    .container { max-width: 960px; margin: 0 auto; display: flex; flex-direction: column; gap: 32px; }
    .hero { text-align: center; padding: 32px 0; }
    .hero h1 { font-size: 56px; letter-spacing: -2px; font-weight: 700; background: linear-gradient(135deg, var(--accent), #a872ff); -webkit-background-clip: text; background-clip: text; color: transparent; }
    .tag { color: var(--text-dim); font-family: var(--mono); font-size: 13px; margin-top: 8px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
    .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; transition: border-color .2s; }
    .card:hover { border-color: var(--accent); }
    .card h3 { font-size: 14px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }
    .card .status { font-size: 24px; font-weight: 600; margin-bottom: 6px; }
    .card .status.ok { color: var(--ok); } .card .status.err { color: var(--err); }
    .card small { color: var(--text-dim); font-family: var(--mono); font-size: 12px; }
    .info { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; }
    .info h2 { font-size: 18px; margin-bottom: 16px; color: var(--text); }
    .grid { list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; }
    .grid li { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; font-family: var(--mono); font-size: 12px; color: var(--text-dim); }
    @media (max-width: 600px) { .hero h1 { font-size: 40px; } body { padding: 16px; } }
  </style>
</head>
<body>
  <div class="container">${body}</div>
</body>
</html>`;
}
