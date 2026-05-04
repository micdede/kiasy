// kiasy-monitor — Phase 1 Skelett
// HTMX + Express, server-rendered. Modernes Default-Theme.
// Echte Pages folgen in Phase 3.

import express from "express";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.PORT || 3000);
const CORE_URL = process.env.CORE_URL || "http://kiasy-core:8080";
const STARTED = Date.now();

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url)));

const app = express();
app.disable("x-powered-by");
app.use(express.json());

// Health
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "kiasy-monitor",
    version: pkg.version,
    uptime_s: Math.round((Date.now() - STARTED) / 1000),
    core_url: CORE_URL
  });
});

// Phase-1 Landing-Page mit modernem Default-Theme
app.get("/", async (req, res) => {
  let coreStatus = "unbekannt";
  try {
    const r = await fetch(`${CORE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    coreStatus = r.ok ? "online" : `HTTP ${r.status}`;
  } catch (e) {
    coreStatus = "offline";
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(layout({
    title: "kiasy",
    body: `
      <section class="hero">
        <h1>kiasy</h1>
        <p class="tag">v${pkg.version} · Phase 1 Skelett</p>
        <p class="lead">Container-Stack läuft. Echte UI folgt in Phase 3.</p>
      </section>

      <section class="cards">
        <div class="card">
          <h3>Monitor</h3>
          <p class="status ok">online</p>
          <small>Port 3000</small>
        </div>
        <div class="card">
          <h3>Core</h3>
          <p class="status ${coreStatus === "online" ? "ok" : "err"}">${coreStatus}</p>
          <small>${CORE_URL}</small>
        </div>
      </section>

      <section class="info">
        <h2>Geplante Pages</h2>
        <ul class="grid">
          <li>/chat</li><li>/notes</li><li>/reminders</li><li>/memory</li>
          <li>/tools</li><li>/workflows</li><li>/news</li><li>/delegations</li>
          <li>/ha-editor</li><li>/voice</li><li>/health</li><li>/backup</li>
          <li>/labs</li><li>/settings</li>
        </ul>
      </section>
    `
  }));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[kiasy-monitor] v${pkg.version} listening on :${PORT}`);
  console.log(`[kiasy-monitor] core at ${CORE_URL}`);
});

// ─── Layout (modernes Default-Theme, dark, akzent cyan) ──────
function layout({ title, body }) {
  return `<!doctype html>
<html lang="de" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root {
      --bg: #0b0d12;
      --bg-card: #131722;
      --bg-elevated: #1a1f2e;
      --border: #232938;
      --text: #e6e9f0;
      --text-dim: #8b94a8;
      --accent: #4ec9ff;
      --accent-soft: rgba(78, 201, 255, 0.12);
      --ok: #6fe5a4;
      --err: #ff6b7a;
      --warn: #ffb86b;
      --radius: 10px;
      --space: 16px;
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
    .lead { color: var(--text-dim); margin-top: 16px; font-size: 16px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
    .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; transition: border-color .2s, transform .2s; }
    .card:hover { border-color: var(--accent); }
    .card h3 { font-size: 14px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }
    .card .status { font-size: 24px; font-weight: 600; margin-bottom: 6px; }
    .card .status.ok { color: var(--ok); }
    .card .status.err { color: var(--err); }
    .card small { color: var(--text-dim); font-family: var(--mono); font-size: 12px; }
    .info { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; }
    .info h2 { font-size: 18px; margin-bottom: 16px; color: var(--text); }
    .grid { list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
    .grid li { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; font-family: var(--mono); font-size: 13px; color: var(--text-dim); }
    @media (max-width: 600px) {
      .hero h1 { font-size: 40px; }
    }
  </style>
</head>
<body>
  <div class="container">
    ${body}
  </div>
</body>
</html>`;
}
