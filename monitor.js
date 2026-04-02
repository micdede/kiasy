// JARVIS Monitoring Dashboard – SSE-basiertes Live-Monitoring im Browser
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const agent = require("./agent");
const voice = require("./voice");
const db = require("./lib/db");

const BOT_NAME = process.env.BOT_NAME || "JARVIS";
const MAX_EVENTS = 200;
const events = [];
const clients = new Set();
const startTime = Date.now();
const TEMP_DIR = path.join(__dirname, "temp");
const MAX_UPLOAD = 5 * 1024 * 1024; // 5 MB

fs.mkdirSync(TEMP_DIR, { recursive: true });

// --- Event-Typen aus Log-Patterns erkennen ---

function detectType(msg) {
  if (/^\[\d{2}:\d{2}:\d{2}\]\s+\S+:/.test(msg)) return "telegram";
  if (/\[Monitor\]/i.test(msg)) return "telegram";
  if (/Mail-Watcher/i.test(msg)) return "mail";
  if (/^→\s/.test(msg) || /tool/i.test(msg)) return "tool";
  return "system";
}

// --- Event loggen + broadcasten ---

function logEvent(type, message) {
  const event = {
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 6),
    type,
    message: String(message),
    timestamp: new Date().toISOString(),
  };
  events.push(event);
  if (events.length > MAX_EVENTS) events.shift();

  // In DB persistieren
  try { db.events.log(type, event.message); } catch {}

  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    try { client.write(data); } catch { clients.delete(client); }
  }
}

// --- Console Interceptor ---

const originalLog = console.log;
const originalError = console.error;

console.log = function (...args) {
  originalLog.apply(console, args);
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  logEvent(detectType(msg), msg);
};

console.error = function (...args) {
  originalError.apply(console, args);
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  logEvent("error", msg);
};

// --- Cleanup Info ---

function getDirSize(dirPath) {
  try {
    const out = execSync(`du -sb "${dirPath}" 2>/dev/null`, { encoding: "utf-8" }).trim();
    return parseInt(out.split(/\s/)[0]) || 0;
  } catch { return 0; }
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function getCleanupInfo() {
  const categories = [];

  // temp/
  const tempDir = path.join(__dirname, "temp");
  const tempBytes = getDirSize(tempDir);
  categories.push({ id: "temp", label: "Temp-Dateien", size: formatBytes(tempBytes), bytes: tempBytes, cleanable: true });

  // logs/
  const logsDir = path.join(__dirname, "logs");
  const logsBytes = getDirSize(logsDir);
  categories.push({ id: "logs", label: "Log-Dateien", size: formatBytes(logsBytes), bytes: logsBytes, cleanable: true });

  // npm cache
  const npmCache = path.join(os.homedir(), ".npm", "_cacache");
  const npmBytes = getDirSize(npmCache);
  categories.push({ id: "npm-cache", label: "NPM Cache", size: formatBytes(npmBytes), bytes: npmBytes, cleanable: true });

  // apt cache (read-only)
  const aptCache = "/var/cache/apt/archives";
  const aptBytes = getDirSize(aptCache);
  categories.push({ id: "apt-cache", label: "APT Cache", size: formatBytes(aptBytes), bytes: aptBytes, cleanable: false, hint: "Braucht sudo – manuell: sudo apt clean" });

  // systemd journal (read-only)
  let journalBytes = 0;
  try {
    const out = execSync("journalctl --disk-usage 2>/dev/null", { encoding: "utf-8" });
    const match = out.match(/([\d.]+[KMGT]?)\s*B?\b/i);
    if (match) {
      const val = parseFloat(match[1]);
      const unit = match[0].replace(/[\d.]/g, "").trim().toUpperCase();
      if (unit.startsWith("K")) journalBytes = val * 1024;
      else if (unit.startsWith("M")) journalBytes = val * 1024 * 1024;
      else if (unit.startsWith("G")) journalBytes = val * 1024 * 1024 * 1024;
      else journalBytes = val;
    }
  } catch {}
  categories.push({ id: "journal", label: "Systemd Journal", size: formatBytes(journalBytes), bytes: journalBytes, cleanable: false, hint: "Braucht sudo – manuell: sudo journalctl --vacuum-time=3d" });

  const totalCleanable = categories.filter(c => c.cleanable).reduce((sum, c) => sum + c.bytes, 0);

  return { categories, totalCleanable: formatBytes(totalCleanable) };
}

function handleCleanup(req, res) {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const id = body.id;
      let freed = 0;

      if (id === "temp") {
        const dir = path.join(__dirname, "temp");
        freed = cleanDir(dir, null);
      } else if (id === "logs") {
        const dir = path.join(__dirname, "logs");
        freed = cleanDir(dir, ".log");
      } else if (id === "npm-cache") {
        const dir = path.join(os.homedir(), ".npm", "_cacache");
        freed = getDirSize(dir);
        fs.rmSync(dir, { recursive: true, force: true });
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Unbekannte Kategorie" }));
        return;
      }

      originalLog(`[Monitor] Cleanup "${id}": ${formatBytes(freed)} freigegeben`);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, freed: formatBytes(freed) }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });
}

function cleanDir(dir, ext) {
  let freed = 0;
  if (!fs.existsSync(dir)) return 0;
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      if (ext && !entry.endsWith(ext)) continue;
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          freed += stat.size;
          fs.unlinkSync(fullPath);
        } else if (stat.isDirectory()) {
          freed += getDirSize(fullPath);
          fs.rmSync(fullPath, { recursive: true, force: true });
        }
      } catch {}
    }
  } catch {}
  return freed;
}

// --- Theme System ---

// --- Theme-Variablen-Definition ---
const THEME_VARS = [
  { key: "bg-primary", label: "Hintergrund", group: "Farben", type: "color" },
  { key: "bg-secondary", label: "Panels/Header", group: "Farben", type: "color" },
  { key: "bg-tertiary", label: "Hover/Aktiv", group: "Farben", type: "color" },
  { key: "border-color", label: "Rahmen", group: "Farben", type: "color" },
  { key: "border-glow", label: "Rahmen Glow", group: "Farben", type: "color" },
  { key: "text-primary", label: "Text", group: "Farben", type: "color" },
  { key: "text-muted", label: "Text gedämpft", group: "Farben", type: "color" },
  { key: "text-dim", label: "Text schwach", group: "Farben", type: "color" },
  { key: "text-bright", label: "Text hell", group: "Farben", type: "color" },
  { key: "accent", label: "Akzentfarbe", group: "Akzent", type: "color" },
  { key: "accent-bg", label: "Akzent Hintergrund", group: "Akzent", type: "color" },
  { key: "color-success", label: "Erfolg", group: "Status", type: "color" },
  { key: "color-error", label: "Fehler", group: "Status", type: "color" },
  { key: "color-warning", label: "Warnung", group: "Status", type: "color" },
  { key: "color-info", label: "Info", group: "Status", type: "color" },
  { key: "btn-primary-bg", label: "Button primär", group: "Buttons", type: "color" },
  { key: "btn-primary-hover", label: "Button Hover", group: "Buttons", type: "color" },
  { key: "bg-gradient", label: "Body-Gradient", group: "Effekte", type: "text" },
  { key: "accent-glow", label: "Akzent-Glow", group: "Effekte", type: "text" },
  { key: "glow-shadow", label: "Glow Shadow", group: "Effekte", type: "text" },
  { key: "card-shadow", label: "Card Shadow", group: "Effekte", type: "text" },
  { key: "scan-lines", label: "Scan-Lines", group: "Effekte", type: "text" },
  { key: "font-heading", label: "Schrift Headlines", group: "Fonts", type: "text" },
  { key: "font-body", label: "Schrift Body", group: "Fonts", type: "text" },
];

const BUILTIN_THEMES = {
  classic: {
    "bg-primary": "#0d1117", "bg-secondary": "#161b22", "bg-tertiary": "#21262d",
    "border-color": "#30363d", "border-glow": "#30363d",
    "text-primary": "#c9d1d9", "text-muted": "#8b949e", "text-dim": "#484f58", "text-bright": "#e6edf3",
    "accent": "#58a6ff", "accent-glow": "transparent", "accent-bg": "#1f6feb33",
    "color-success": "#3fb950", "color-error": "#f85149", "color-warning": "#d29922", "color-info": "#d2a8ff",
    "btn-primary-bg": "#238636", "btn-primary-hover": "#2ea043",
    "font-heading": "'SF Mono', 'Cascadia Code', monospace", "font-body": "'SF Mono', 'Cascadia Code', monospace",
    "glow-shadow": "none", "card-shadow": "none", "scan-lines": "none",
    "bg-gradient": "#0d1117",
  },
  joy: {
    "bg-primary": "#06081A", "bg-secondary": "rgba(15, 18, 50, 0.8)", "bg-tertiary": "rgba(100, 140, 255, 0.06)",
    "border-color": "rgba(120, 160, 255, 0.18)", "border-glow": "rgba(140, 120, 255, 0.35)",
    "text-primary": "#D8DEFF", "text-muted": "rgba(200, 210, 255, 0.55)", "text-dim": "rgba(180, 190, 255, 0.25)", "text-bright": "#F0F2FF",
    "accent": "#7EB4FF", "accent-glow": "0 0 18px rgba(126, 180, 255, 0.4)", "accent-bg": "rgba(126, 180, 255, 0.08)",
    "color-success": "#6EEDB0", "color-error": "#FF6B8A", "color-warning": "#FFB86E", "color-info": "#C8A0FF",
    "btn-primary-bg": "rgba(140, 120, 255, 0.25)", "btn-primary-hover": "rgba(140, 120, 255, 0.4)",
    "font-heading": "'Exo 2', sans-serif", "font-body": "'Exo 2', sans-serif",
    "glow-shadow": "0 0 25px rgba(140, 120, 255, 0.12)", "card-shadow": "0 0 15px rgba(100, 140, 255, 0.06)",
    "scan-lines": "none",
    "bg-gradient": "radial-gradient(ellipse at 50% 50%, #0E1240, #06081A)",
  },
  tron: {
    "bg-primary": "#05070A", "bg-secondary": "rgba(10, 20, 40, 0.6)", "bg-tertiary": "rgba(0, 240, 255, 0.05)",
    "border-color": "rgba(0, 240, 255, 0.2)", "border-glow": "rgba(0, 240, 255, 0.4)",
    "text-primary": "#E6F7FF", "text-muted": "rgba(230, 247, 255, 0.6)", "text-dim": "rgba(230, 247, 255, 0.3)", "text-bright": "#fff",
    "accent": "#00F0FF", "accent-glow": "0 0 15px #00F0FF", "accent-bg": "rgba(0, 240, 255, 0.1)",
    "color-success": "#00FF88", "color-error": "#FF3B3B", "color-warning": "#FFB000", "color-info": "#00F0FF",
    "btn-primary-bg": "transparent", "btn-primary-hover": "rgba(0, 240, 255, 0.1)",
    "font-heading": "'Orbitron', sans-serif", "font-body": "'Rajdhani', sans-serif",
    "glow-shadow": "0 0 20px rgba(0, 240, 255, 0.15)", "card-shadow": "0 0 20px rgba(0, 240, 255, 0.08)",
    "scan-lines": "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0, 240, 255, 0.03) 2px, rgba(0, 240, 255, 0.03) 4px)",
    "bg-gradient": "radial-gradient(circle at center, #0A1A2F, #05070A)",
  },
};

function getCustomThemes() {
  try {
    const row = db.db.prepare("SELECT value FROM terminal_state WHERE key = 'custom_themes'").get();
    return row ? JSON.parse(row.value) : {};
  } catch { return {}; }
}

function saveCustomThemes(themes) {
  db.db.prepare("INSERT OR REPLACE INTO terminal_state (key, value) VALUES (?, ?)").run("custom_themes", JSON.stringify(themes));
}

function getAllThemes() {
  const custom = getCustomThemes();
  return { ...BUILTIN_THEMES, ...custom };
}

function getActiveTheme() {
  try {
    const row = db.db.prepare("SELECT value FROM terminal_state WHERE key = 'theme'").get();
    return (row && row.value) || "tron";
  } catch { return "tron"; }
}

function getThemeVars(themeName) {
  const all = getAllThemes();
  return all[themeName] || all.tron || BUILTIN_THEMES.tron;
}

function isGlowTheme(themeName) {
  const vars = getThemeVars(themeName);
  return vars["glow-shadow"] && vars["glow-shadow"] !== "none";
}

function getGoogleFontsLink(theme) {
  const vars = getThemeVars(theme);
  const fonts = [];
  const heading = vars["font-heading"] || "";
  const body = vars["font-body"] || "";
  if (heading.includes("Orbitron") || body.includes("Orbitron")) fonts.push("family=Orbitron:wght@400;600;700");
  if (heading.includes("Rajdhani") || body.includes("Rajdhani")) fonts.push("family=Rajdhani:wght@400;500;600;700");
  if (heading.includes("Exo 2") || body.includes("Exo 2")) fonts.push("family=Exo+2:wght@300;400;500;600;700");
  if (fonts.length > 0) {
    return `<link href="https://fonts.googleapis.com/css2?${fonts.join("&")}&display=swap" rel="stylesheet">`;
  }
  return '';
}

function getThemeCSS() {
  const theme = getActiveTheme();
  const themeVars = getThemeVars(theme);

  const vars = Object.entries(themeVars).map(([k, v]) => `--${k}: ${v};`).join("\n      ");

  let tronExtras = '';
  if (isGlowTheme(theme)) {
    tronExtras = `
    body::after {
      content: ''; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: var(--scan-lines); pointer-events: none; z-index: 9999;
    }
    @keyframes glow-pulse {
      0%, 100% { box-shadow: 0 0 4px var(--color-success); }
      50% { box-shadow: 0 0 12px var(--color-success), 0 0 20px var(--color-success); }
    }
    .dot { animation: glow-pulse 2s ease-in-out infinite; }
    h1, h2, h3 { font-family: var(--font-heading); }
    .btn-primary {
      background: var(--btn-primary-bg) !important;
      border-color: var(--accent) !important;
      color: var(--accent) !important;
      text-shadow: 0 0 8px var(--accent);
    }
    .btn-primary:hover {
      background: var(--btn-primary-hover) !important;
      box-shadow: var(--accent-glow);
    }
    `;
  }

  return `<style>
  :root { ${vars} }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--bg-gradient); color: var(--text-primary);
    font-family: var(--font-body); font-size: 13px;
  }
  header {
    background: var(--bg-secondary); border-bottom: 1px solid var(--border-color);
    padding: 12px 16px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  }
  header h1 { font-size: 16px; color: var(--accent); font-weight: 600; font-family: var(--font-heading); }
  header a {
    color: var(--text-muted); text-decoration: none; font-size: 12px;
    padding: 4px 10px; border: 1px solid var(--border-color); border-radius: 6px;
    transition: all 0.15s;
  }
  header a:hover { color: var(--text-primary); border-color: var(--accent); }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 3px; }
  .btn {
    padding: 6px 14px; border-radius: 6px; border: 1px solid var(--border-color);
    font-size: 12px; font-family: inherit; cursor: pointer; transition: all 0.15s;
    background: var(--bg-tertiary); color: var(--text-primary);
  }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .btn-primary { background: var(--btn-primary-bg); border-color: var(--btn-primary-hover); color: #fff; }
  .btn-primary:hover { background: var(--btn-primary-hover); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .status-msg {
    font-size: 12px; color: var(--color-success); opacity: 0; transition: opacity 0.3s; white-space: nowrap;
  }
  .status-msg.show { opacity: 1; }
  .status-msg.error { color: var(--color-error); }
  .empty-state {
    flex: 1; display: flex; align-items: center; justify-content: center;
    color: var(--border-color); font-size: 48px; font-weight: 700; user-select: none;
  }
  .save-status { font-size: 11px; color: var(--color-success); opacity: 0; transition: opacity 0.3s; }
  .save-status.show { opacity: 1; }
  .save-status.error { color: var(--color-error); }
  ${tronExtras}
</style>`;
}

// --- Dashboard HTML ---

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon/favicon.svg">
<link rel="icon" type="image/png" sizes="96x96" href="/favicon/favicon-96x96.png">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="apple-touch-icon" sizes="180x180" href="/favicon/apple-touch-icon.png">
<title>${BOT_NAME} Monitor</title>
${getGoogleFontsLink(getActiveTheme())}
${getThemeCSS()}
<style>
  body { height: 100vh; display: flex; flex-direction: column; }
  .status-bar {
    display: flex; gap: 16px; font-size: 11px; color: var(--text-muted); flex-wrap: wrap;
  }
  .status-bar span { display: flex; align-items: center; gap: 4px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--color-success); display: inline-block; }
  .filters {
    background: var(--bg-secondary); border-bottom: 1px solid var(--border-color); padding: 8px 16px;
    display: flex; gap: 6px; flex-wrap: wrap;
  }
  .filter-btn {
    background: var(--bg-tertiary); border: 1px solid var(--border-color); color: var(--text-muted); padding: 4px 10px;
    border-radius: 12px; cursor: pointer; font-size: 11px; font-family: inherit;
    transition: all 0.15s;
  }
  .filter-btn:hover { border-color: var(--accent); color: var(--text-primary); }
  .filter-btn.active { background: var(--accent)33; border-color: var(--accent); color: var(--accent); }
  .filter-btn .count { margin-left: 4px; opacity: 0.6; }
  #feed {
    flex: 1; overflow-y: auto; padding: 8px 0; scroll-behavior: smooth;
  }
  .event {
    padding: 3px 16px; display: flex; gap: 10px; line-height: 1.5;
    border-left: 3px solid transparent;
  }
  .event:hover { background: var(--bg-secondary); }
  .event .time { color: var(--text-dim); white-space: nowrap; min-width: 75px; }
  .event .tag {
    font-size: 10px; font-weight: 600; text-transform: uppercase; padding: 1px 6px;
    border-radius: 3px; white-space: nowrap; min-width: 65px; text-align: center;
    line-height: 1.7;
  }
  .event .msg { word-break: break-word; flex: 1; }
  .type-telegram { border-left-color: var(--accent); }
  .type-telegram .tag { background: color-mix(in srgb, var(--accent) 13%, transparent); color: var(--accent); }
  .type-mail { border-left-color: var(--color-success); }
  .type-mail .tag { background: color-mix(in srgb, var(--color-success) 13%, transparent); color: var(--color-success); }
  .type-tool { border-left-color: var(--color-warning); }
  .type-tool .tag { background: color-mix(in srgb, var(--color-warning) 13%, transparent); color: var(--color-warning); }
  .type-error { border-left-color: var(--color-error); }
  .type-error .tag { background: color-mix(in srgb, var(--color-error) 13%, transparent); color: var(--color-error); }
  .type-system { border-left-color: var(--text-dim); }
  .type-system .tag { background: color-mix(in srgb, var(--text-dim) 13%, transparent); color: var(--text-muted); }
  #feed::-webkit-scrollbar { width: 6px; }
  #feed::-webkit-scrollbar-track { background: transparent; }
  #feed::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 3px; }
  .empty {
    display: flex; align-items: center; justify-content: center;
    height: 100%; color: var(--text-dim); font-size: 14px;
  }

  @media (max-width: 600px) {
    header { padding: 8px 10px; }
    .event { padding: 3px 10px; gap: 6px; }
    .event .time { min-width: 55px; font-size: 11px; }
  }
</style>
</head>
<body>
<header>
  <h1><span class="dot"></span> ${BOT_NAME} Monitor</h1>
  <a href="/chat">Chat</a>
  <a href="/system">System</a>
  <a href="/ha-editor">Smart Home Editor</a>
  <a href="/notes">Wissensbasis</a>
  <a href="/reminders">Erinnerungen</a>
  <a href="/terminal">Terminal</a>
  <a href="/settings">Einstellungen</a>
  <a href="/community">Community</a>
  <a href="/delegations">Delegationen</a>
  <a href="/roadmap">Roadmap</a>
  <a href="/tools">Tools</a>
  <a href="/workflows">Workflows</a>
  <div class="status-bar">
    <span>Uptime: <b id="uptime">-</b></span>
    <span>Modell: <b id="model">-</b></span>
    <span>Events: <b id="eventCount">0</b></span>
    <span>Clients: <b id="clientCount">-</b></span>
  </div>
</header>
<div class="filters">
  <button class="filter-btn active" data-type="all">Alle <span class="count" id="count-all">0</span></button>
  <button class="filter-btn active" data-type="telegram">Telegram <span class="count" id="count-telegram">0</span></button>
  <button class="filter-btn active" data-type="mail">Mail <span class="count" id="count-mail">0</span></button>
  <button class="filter-btn active" data-type="tool">Tool <span class="count" id="count-tool">0</span></button>
  <button class="filter-btn active" data-type="error">Fehler <span class="count" id="count-error">0</span></button>
  <button class="filter-btn active" data-type="system">System <span class="count" id="count-system">0</span></button>
</div>
<div id="feed"><div class="empty">Warte auf Events...</div></div>

<script>
const feed = document.getElementById("feed");
const counts = { all: 0, telegram: 0, mail: 0, tool: 0, error: 0, system: 0 };
const activeFilters = new Set(["telegram", "mail", "tool", "error", "system"]);
function formatTime(iso) {
  return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function escapeHtml(s) {
  const d = document.createElement("div"); d.textContent = s; return d.innerHTML;
}

function addEvent(ev) {
  if (feed.querySelector(".empty")) feed.innerHTML = "";
  counts.all++;
  counts[ev.type] = (counts[ev.type] || 0) + 1;
  Object.keys(counts).forEach(k => {
    const el = document.getElementById("count-" + k);
    if (el) el.textContent = counts[k];
  });
  document.getElementById("eventCount").textContent = counts.all;

  const div = document.createElement("div");
  div.className = "event type-" + ev.type;
  div.dataset.type = ev.type;
  if (!activeFilters.has(ev.type)) div.style.display = "none";
  div.innerHTML =
    '<span class="time">' + formatTime(ev.timestamp) + '</span>' +
    '<span class="tag">' + escapeHtml(ev.type) + '</span>' +
    '<span class="msg">' + escapeHtml(ev.message) + '</span>';
  feed.prepend(div);
}

// Filter-Buttons
document.querySelectorAll(".filter-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const type = btn.dataset.type;
    if (type === "all") {
      const allActive = activeFilters.size === 5;
      document.querySelectorAll(".filter-btn").forEach(b => {
        if (b.dataset.type === "all") return;
        if (allActive) { activeFilters.delete(b.dataset.type); b.classList.remove("active"); }
        else { activeFilters.add(b.dataset.type); b.classList.add("active"); }
      });
      btn.classList.toggle("active", !allActive);
    } else {
      btn.classList.toggle("active");
      if (activeFilters.has(type)) activeFilters.delete(type);
      else activeFilters.add(type);
      const allBtn = document.querySelector('[data-type="all"]');
      allBtn.classList.toggle("active", activeFilters.size === 5);
    }
    feed.querySelectorAll(".event").forEach(el => {
      el.style.display = activeFilters.has(el.dataset.type) ? "" : "none";
    });
  });
});

// Uptime
function updateUptime() {
  fetch("/api/history").then(r => r.json()).then(data => {
    document.getElementById("uptime").textContent = data.uptime;
    document.getElementById("model").textContent = data.model;
    document.getElementById("clientCount").textContent = data.clients;
  }).catch(() => {});
}
updateUptime();
setInterval(updateUptime, 10000);

// History laden
fetch("/api/history").then(r => r.json()).then(data => {
  document.getElementById("uptime").textContent = data.uptime;
  document.getElementById("model").textContent = data.model;
  document.getElementById("clientCount").textContent = data.clients;
  data.events.slice().reverse().forEach(ev => addEvent(ev));
}).catch(() => {});

// SSE
const sse = new EventSource("/events");
sse.onmessage = (e) => { addEvent(JSON.parse(e.data)); };
sse.onerror = () => {
  document.querySelector("header .dot").style.background = getComputedStyle(document.documentElement).getPropertyValue("--color-error").trim();
};
sse.onopen = () => {
  document.querySelector("header .dot").style.background = getComputedStyle(document.documentElement).getPropertyValue("--color-success").trim();
};

</script>
</body>
</html>`;
}

// --- System HTML ---

function getSystemHTML() {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon/favicon.svg">
<link rel="icon" type="image/png" sizes="96x96" href="/favicon/favicon-96x96.png">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="apple-touch-icon" sizes="180x180" href="/favicon/apple-touch-icon.png">
<title>${BOT_NAME} - System</title>
${getGoogleFontsLink(getActiveTheme())}
${getThemeCSS()}
<style>

  .content { max-width: 1000px; margin: 20px auto; padding: 0 16px; }

  .sys-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 10px; margin-bottom: 24px;
  }
  .sys-card {
    background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; padding: 10px 14px;
  }
  .sys-card h3 {
    font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;
    margin-bottom: 6px; font-weight: 600;
  }
  .sys-card .sys-value { font-size: 18px; font-weight: 700; color: var(--text-bright); margin-bottom: 4px; }
  .sys-card .sys-detail { font-size: 11px; color: var(--text-muted); line-height: 1.5; }
  .sys-bar {
    height: 6px; background: var(--bg-tertiary); border-radius: 3px; margin-top: 6px; overflow: hidden;
  }
  .sys-bar-fill {
    height: 100%; border-radius: 3px; transition: width 0.5s ease, background 0.3s ease;
  }
  .sys-bar-fill.green { background: var(--color-success); }
  .sys-bar-fill.yellow { background: var(--color-warning); }
  .sys-bar-fill.red { background: var(--color-error); }

  .cleanup-section {
    background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px;
    padding: 14px 16px;
  }
  .cleanup-header {
    display: flex; align-items: center; gap: 10px; margin-bottom: 10px;
  }
  .cleanup-title {
    font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .cleanup-total {
    font-size: 11px; color: var(--color-success); margin-left: auto;
  }
  .cleanup-refresh-btn {
    background: none; border: 1px solid var(--border-color); color: var(--text-muted); width: 28px; height: 28px;
    border-radius: 6px; cursor: pointer; font-size: 16px; display: flex;
    align-items: center; justify-content: center; transition: all 0.15s;
  }
  .cleanup-refresh-btn:hover { border-color: var(--accent); color: var(--text-primary); }
  .cleanup-refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .cleanup-row {
    display: flex; align-items: center; gap: 8px; padding: 6px 0;
    border-bottom: 1px solid var(--bg-tertiary);
  }
  .cleanup-row:last-child { border-bottom: none; }
  .cleanup-icon { font-size: 14px; width: 22px; text-align: center; }
  .cleanup-label { font-size: 12px; color: var(--text-primary); flex: 1; }
  .cleanup-size { font-size: 12px; color: var(--text-muted); min-width: 60px; text-align: right; }
  .cleanup-btn {
    font-size: 11px; padding: 3px 10px; border-radius: 4px; border: 1px solid var(--btn-primary-bg);
    background: var(--btn-primary-bg)22; color: var(--color-success); cursor: pointer; font-family: inherit;
    transition: all 0.15s;
  }
  .cleanup-btn:hover { background: var(--btn-primary-bg); color: #fff; }
  .cleanup-btn.disabled {
    border-color: var(--border-color); background: none; color: var(--text-dim); cursor: default;
  }
  .cleanup-btn.disabled:hover { background: none; color: var(--text-dim); }
  .cleanup-btn:disabled { opacity: 0.7; cursor: not-allowed; }

  @media (max-width: 600px) {
    .sys-grid { grid-template-columns: 1fr; }
  }

</style>
</head>
<body>
<header>
  <h1>${BOT_NAME} System</h1>
  <a href="/">Monitor</a>
  <a href="/chat">Chat</a>
  <a href="/ha-editor">Smart Home Editor</a>
  <a href="/notes">Wissensbasis</a>
  <a href="/reminders">Erinnerungen</a>
  <a href="/terminal">Terminal</a>
  <a href="/settings">Einstellungen</a>
  <a href="/community">Community</a>
  <a href="/delegations">Delegationen</a>
  <a href="/roadmap">Roadmap</a>
  <a href="/tools">Tools</a>
  <a href="/workflows">Workflows</a>
</header>

<div class="content">
  <div class="sys-grid">
    <div class="sys-card">
      <h3>CPU</h3>
      <div class="sys-value" id="sys-cpu-load">-</div>
      <div class="sys-detail" id="sys-cpu-detail">-</div>
    </div>
    <div class="sys-card">
      <h3>RAM</h3>
      <div class="sys-value" id="sys-mem-value">-</div>
      <div class="sys-bar"><div class="sys-bar-fill green" id="sys-mem-bar" style="width:0%"></div></div>
      <div class="sys-detail" id="sys-mem-detail">-</div>
    </div>
    <div class="sys-card">
      <h3>Disk</h3>
      <div class="sys-value" id="sys-disk-value">-</div>
      <div class="sys-bar"><div class="sys-bar-fill green" id="sys-disk-bar" style="width:0%"></div></div>
      <div class="sys-detail" id="sys-disk-detail">-</div>
    </div>
    <div class="sys-card">
      <h3>Uptime / Node.js</h3>
      <div class="sys-value" id="sys-uptime-value">-</div>
      <div class="sys-detail" id="sys-node-detail">-</div>
    </div>
  </div>

  <div class="sys-grid" id="sensors-grid" style="display:none">
  </div>

  <div class="cleanup-section">
    <div class="cleanup-header">
      <span class="cleanup-title">Systembereinigung</span>
      <span id="cleanup-total" class="cleanup-total">-</span>
      <button id="cleanup-refresh" class="cleanup-refresh-btn" title="Neu scannen">&#x21bb;</button>
    </div>
    <div id="cleanup-list"></div>
  </div>
</div>

<script>
function escapeHtml(s) {
  const d = document.createElement("div"); d.textContent = s; return d.innerHTML;
}

// ==================== System Info ====================
function barColor(pct) {
  if (pct >= 85) return "red";
  if (pct >= 60) return "yellow";
  return "green";
}

function updateSystemPanel(d) {
  document.getElementById("sys-cpu-load").textContent = d.cpu.loadAvg.join("  /  ");
  document.getElementById("sys-cpu-detail").textContent = d.cpu.cores + " Cores — " + d.cpu.model;

  document.getElementById("sys-mem-value").textContent = d.memory.used + " / " + d.memory.total;
  const memBar = document.getElementById("sys-mem-bar");
  memBar.style.width = d.memory.percent + "%";
  memBar.className = "sys-bar-fill " + barColor(d.memory.percent);
  document.getElementById("sys-mem-detail").textContent = d.memory.percent + "% belegt — " + d.memory.free + " frei";

  document.getElementById("sys-disk-value").textContent = d.disk.used + " / " + d.disk.total;
  const diskBar = document.getElementById("sys-disk-bar");
  diskBar.style.width = d.disk.percent + "%";
  diskBar.className = "sys-bar-fill " + barColor(d.disk.percent);
  document.getElementById("sys-disk-detail").textContent = d.disk.percent + "% belegt — " + d.disk.free + " frei";

  document.getElementById("sys-uptime-value").textContent = "System: " + d.uptime.system + " — Prozess: " + d.uptime.process;
  document.getElementById("sys-node-detail").textContent = "Heap: " + d.node.heapUsed + " / " + d.node.heapTotal + " — RSS: " + d.node.rss;

  // Sensors
  const grid = document.getElementById("sensors-grid");
  if (d.sensors && (d.sensors.temps.length || d.sensors.fans.length)) {
    grid.style.display = "";
    let html = "";
    d.sensors.temps.forEach(t => {
      const pct = t.crit ? Math.round((t.value / t.crit) * 100) : 0;
      const color = t.value >= 80 ? "red" : t.value >= 60 ? "yellow" : "green";
      const detail = (t.max ? "Max: " + t.max + "°C" : "") + (t.crit ? " / Krit: " + t.crit + "°C" : "");
      html += '<div class="sys-card">' +
        '<h3>' + escapeHtml(t.label) + '</h3>' +
        '<div class="sys-value">' + t.value + '°C</div>' +
        (t.crit ? '<div class="sys-bar"><div class="sys-bar-fill ' + color + '" style="width:' + pct + '%"></div></div>' : '') +
        '<div class="sys-detail">' + escapeHtml(detail) + '</div>' +
        '</div>';
    });
    d.sensors.fans.forEach(f => {
      html += '<div class="sys-card">' +
        '<h3>' + escapeHtml(f.label) + '</h3>' +
        '<div class="sys-value">' + f.value + ' RPM</div>' +
        '<div class="sys-detail">' + escapeHtml(f.chip) + '</div>' +
        '</div>';
    });
    grid.innerHTML = html;
  }
}

function fetchSystem() {
  fetch("/api/system").then(r => r.json()).then(updateSystemPanel).catch(() => {});
}

fetchSystem();
setInterval(fetchSystem, 5000);

// ==================== Cleanup ====================
(function() {
  const listEl = document.getElementById("cleanup-list");
  const totalEl = document.getElementById("cleanup-total");
  const refreshBtn = document.getElementById("cleanup-refresh");

  async function loadCleanup() {
    refreshBtn.disabled = true;
    listEl.innerHTML = '<div style="color:var(--text-dim);padding:8px 0">Scanne...</div>';
    try {
      const res = await fetch("/api/cleanup");
      const data = await res.json();
      renderCleanup(data);
    } catch (err) {
      listEl.innerHTML = '<div style="color:var(--color-error);padding:8px 0">Fehler beim Laden</div>';
    } finally {
      refreshBtn.disabled = false;
    }
  }

  function renderCleanup(data) {
    const icons = { temp: "\\ud83d\\udcc1", logs: "\\ud83d\\udcdd", "npm-cache": "\\ud83d\\udce6", "apt-cache": "\\ud83d\\udee0", journal: "\\ud83d\\udcd3" };
    let html = "";
    data.categories.forEach(cat => {
      const icon = icons[cat.id] || "\\ud83d\\udcc2";
      const btnClass = cat.cleanable ? "cleanup-btn" : "cleanup-btn disabled";
      const btnText = cat.cleanable ? "Aufräumen" : "sudo";
      const hint = cat.hint ? ' title="' + escapeHtml(cat.hint) + '"' : "";
      html += '<div class="cleanup-row">' +
        '<span class="cleanup-icon">' + icon + '</span>' +
        '<span class="cleanup-label">' + escapeHtml(cat.label) + '</span>' +
        '<span class="cleanup-size">' + escapeHtml(cat.size) + '</span>' +
        '<button class="' + btnClass + '"' + hint + ' data-id="' + cat.id + '"' +
        (cat.cleanable ? "" : " disabled") + '>' + btnText + '</button>' +
        '</div>';
    });
    listEl.innerHTML = html;
    totalEl.textContent = "Freigebar: " + data.totalCleanable;

    listEl.querySelectorAll(".cleanup-btn:not(.disabled)").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const cat = data.categories.find(c => c.id === id);
        if (!confirm(cat.label + " (" + cat.size + ") aufräumen?")) return;
        btn.disabled = true;
        btn.textContent = "...";
        try {
          const res = await fetch("/api/cleanup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id })
          });
          const result = await res.json();
          if (result.ok) {
            btn.textContent = result.freed + " frei";
            btn.style.color = "var(--color-success)";
            setTimeout(() => loadCleanup(), 2000);
          } else {
            btn.textContent = "Fehler";
            btn.style.color = "var(--color-error)";
            setTimeout(() => loadCleanup(), 2000);
          }
        } catch {
          btn.textContent = "Fehler";
          btn.style.color = "var(--color-error)";
        }
      });
    });
  }

  refreshBtn.addEventListener("click", loadCleanup);
  loadCleanup();
})();
</script>
</body>
</html>`;
}

// --- HA Editor HTML ---

function getEditorHTML() {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon/favicon.svg">
<link rel="icon" type="image/png" sizes="96x96" href="/favicon/favicon-96x96.png">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="apple-touch-icon" sizes="180x180" href="/favicon/apple-touch-icon.png">
<title>${BOT_NAME} - Smart Home Editor</title>
${getGoogleFontsLink(getActiveTheme())}
${getThemeCSS()}
<style>
  body { height: 100vh; display: flex; flex-direction: column; }
  .toolbar {
    background: var(--bg-secondary); border-bottom: 1px solid var(--border-color); padding: 8px 16px;
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  }
  .file-tab {
    background: var(--bg-tertiary); border: 1px solid var(--border-color); color: var(--text-muted); padding: 6px 14px;
    border-radius: 6px; cursor: pointer; font-size: 12px; font-family: inherit;
    transition: all 0.15s;
  }
  .file-tab:hover { border-color: var(--accent); color: var(--text-primary); }
  .file-tab.active { background: var(--accent)33; border-color: var(--accent); color: var(--accent); }
  .file-tab .badge {
    font-size: 10px; background: var(--text-dim); color: var(--text-primary); padding: 1px 5px;
    border-radius: 8px; margin-left: 6px;
  }
  .file-tab.active .badge { background: var(--accent); color: var(--bg-primary); }
  .spacer { flex: 1; }
  .btn-save { background: var(--btn-primary-bg); border-color: var(--btn-primary-hover); color: #fff; }
  .btn-save:hover { background: var(--btn-primary-hover); }
  .btn-save:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-regen { background: var(--bg-tertiary); border-color: var(--border-color); color: var(--color-warning); }
  .btn-regen:hover { background: var(--border-color); }
  .btn-regen:disabled { opacity: 0.5; cursor: not-allowed; }
  .main {
    flex: 1; display: flex; overflow: hidden;
  }
  .editor-pane {
    flex: 1; display: flex; flex-direction: column; min-width: 0;
    border-right: 1px solid var(--border-color);
  }
  .editor-pane .pane-header {
    background: var(--bg-secondary); padding: 6px 16px; font-size: 11px; color: var(--text-muted);
    border-bottom: 1px solid var(--border-color); display: flex; align-items: center; gap: 8px;
  }
  .editor-pane .pane-header .line-count { margin-left: auto; }
  #editor {
    flex: 1; width: 100%; background: var(--bg-primary); color: var(--text-primary); border: none;
    padding: 12px 16px; font-family: inherit; font-size: 13px; line-height: 1.6;
    resize: none; outline: none; tab-size: 2;
  }
  #editor:focus { background: var(--bg-primary); }
  .preview-pane {
    flex: 1; display: flex; flex-direction: column; min-width: 0; overflow: hidden;
  }
  .preview-pane .pane-header {
    background: var(--bg-secondary); padding: 6px 16px; font-size: 11px; color: var(--text-muted);
    border-bottom: 1px solid var(--border-color);
  }
  #preview {
    flex: 1; overflow-y: auto; padding: 16px; line-height: 1.6;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px;
  }
  #preview h1 { font-size: 20px; color: var(--accent); margin: 16px 0 8px; border-bottom: 1px solid var(--border-color); padding-bottom: 6px; }
  #preview h2 { font-size: 17px; color: var(--color-info); margin: 14px 0 6px; }
  #preview h3 { font-size: 14px; color: var(--color-warning); margin: 10px 0 4px; }
  #preview ul, #preview ol { padding-left: 20px; margin: 4px 0; }
  #preview li { margin: 2px 0; }
  #preview code {
    background: var(--bg-secondary); padding: 2px 6px; border-radius: 4px;
    font-family: var(--font-body); font-size: 12px; color: var(--accent);
  }
  #preview table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 12px; }
  #preview th {
    background: var(--bg-secondary); border: 1px solid var(--border-color); padding: 6px 10px;
    text-align: left; color: var(--text-muted); font-weight: 600;
  }
  #preview td { border: 1px solid var(--border-color); padding: 4px 10px; }
  #preview tr:hover td { background: var(--bg-secondary); }
  #preview blockquote {
    border-left: 3px solid var(--text-dim); padding: 4px 12px; margin: 8px 0;
    color: var(--text-muted); font-style: italic;
  }
  #preview strong { color: var(--text-bright); }
  #preview em { color: var(--text-muted); }
  .loading-overlay {
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: color-mix(in srgb, var(--bg-primary) 80%, transparent); display: none; align-items: center;
    justify-content: center; z-index: 100; font-size: 16px; color: var(--color-warning);
  }
  .loading-overlay.show { display: flex; }

  /* Mobile: stack vertically */
  @media (max-width: 900px) {
    .main { flex-direction: column; }
    .editor-pane { border-right: none; border-bottom: 1px solid var(--border-color); flex: none; height: 50%; }
    .preview-pane { flex: none; height: 50%; }
  }

  /* scrollbar */
  #editor::-webkit-scrollbar, #preview::-webkit-scrollbar { width: 6px; }
  #editor::-webkit-scrollbar-track, #preview::-webkit-scrollbar-track { background: transparent; }
  #editor::-webkit-scrollbar-thumb, #preview::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 3px; }
</style>
</head>
<body>
<header>
  <h1>Smart Home Editor</h1>
  <a href="/">Monitor</a>
  <a href="/chat">Chat</a>
  <a href="/system">System</a>
  <a href="/notes">Wissensbasis</a>
  <a href="/reminders">Erinnerungen</a>
  <a href="/terminal">Terminal</a>
  <a href="/settings">Einstellungen</a>
  <a href="/community">Community</a>
  <a href="/delegations">Delegationen</a>
  <a href="/roadmap">Roadmap</a>
  <a href="/tools">Tools</a>
  <a href="/workflows">Workflows</a>
</header>

<div class="toolbar">
  <button class="file-tab active" data-file="ha-devices-compact.md">
    Geräte-Referenz <span class="badge">Prompt</span>
  </button>
  <button class="file-tab" data-file="ha-devices.md">
    Vollständige Liste <span class="badge">Detail</span>
  </button>
  <span class="spacer"></span>
  <span class="save-status" id="saveStatus"></span>
  <button class="btn btn-regen" id="regenBtn" title="Vollständige Liste aus Home Assistant neu generieren">Regenerieren</button>
  <button class="btn btn-save" id="saveBtn" disabled>Speichern (Ctrl+S)</button>
</div>

<div class="main">
  <div class="editor-pane">
    <div class="pane-header">
      <span id="fileName">ha-devices-compact.md</span>
      <span class="line-count" id="lineCount">0 Zeilen</span>
    </div>
    <textarea id="editor" spellcheck="false"></textarea>
  </div>
  <div class="preview-pane">
    <div class="pane-header">Vorschau</div>
    <div id="preview"></div>
  </div>
</div>

<div class="loading-overlay" id="loading">Regeneriere aus Home Assistant...</div>

<script>
const editor = document.getElementById('editor');
const preview = document.getElementById('preview');
const saveBtn = document.getElementById('saveBtn');
const regenBtn = document.getElementById('regenBtn');
const saveStatus = document.getElementById('saveStatus');
const fileNameEl = document.getElementById('fileName');
const lineCountEl = document.getElementById('lineCount');
const loading = document.getElementById('loading');

let currentFile = 'ha-devices-compact.md';
let originalContent = '';
let dirty = false;

// --- Markdown to HTML (lightweight) ---
function md2html(md) {
  let html = '';
  const lines = md.split('\\n');
  let inTable = false;
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Close list if line is not a list item
    if (inList && !/^\\s*[-*]\\s/.test(line)) {
      html += '</ul>'; inList = false;
    }

    // Table
    if (/^\\|(.+)\\|\\s*$/.test(line)) {
      // Check if next line is separator
      if (!inTable) {
        html += '<table>';
        inTable = true;
        const cells = line.split('|').filter(c => c.trim());
        html += '<tr>' + cells.map(c => '<th>' + esc(c.trim()) + '</th>').join('') + '</tr>';
        // Skip separator line
        if (i + 1 < lines.length && /^\\|[-:\\s|]+\\|\\s*$/.test(lines[i+1])) i++;
        continue;
      }
      const cells = line.split('|').filter(c => c.trim());
      html += '<tr>' + cells.map(c => '<td>' + inlineFormat(c.trim()) + '</td>').join('') + '</tr>';
      continue;
    } else if (inTable) {
      html += '</table>'; inTable = false;
    }

    // Headers
    if (/^### /.test(line)) { html += '<h3>' + inlineFormat(line.slice(4)) + '</h3>'; continue; }
    if (/^## /.test(line)) { html += '<h2>' + inlineFormat(line.slice(3)) + '</h2>'; continue; }
    if (/^# /.test(line)) { html += '<h1>' + inlineFormat(line.slice(2)) + '</h1>'; continue; }

    // Blockquote
    if (/^>\\s?/.test(line)) { html += '<blockquote>' + inlineFormat(line.replace(/^>\\s?/, '')) + '</blockquote>'; continue; }

    // List
    if (/^\\s*[-*]\\s/.test(line)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += '<li>' + inlineFormat(line.replace(/^\\s*[-*]\\s/, '')) + '</li>';
      continue;
    }

    // Empty line
    if (line.trim() === '') { html += '<br>'; continue; }

    // Paragraph
    html += '<p>' + inlineFormat(line) + '</p>';
  }

  if (inTable) html += '</table>';
  if (inList) html += '</ul>';
  return html;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineFormat(s) {
  s = esc(s);
  s = s.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  s = s.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
  s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
  return s;
}

// --- File operations ---
async function loadFile(filename) {
  try {
    const res = await fetch('/api/ha-files/' + encodeURIComponent(filename));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    editor.value = data.content;
    originalContent = data.content;
    currentFile = filename;
    dirty = false;
    saveBtn.disabled = true;
    updatePreview();
    updateLineCount();
    fileNameEl.textContent = filename;

    document.querySelectorAll('.file-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.file === filename);
    });
  } catch (err) {
    showStatus('Fehler beim Laden: ' + err.message, true);
  }
}

async function saveFile() {
  if (!dirty) return;
  saveBtn.disabled = true;
  try {
    const res = await fetch('/api/ha-files/' + encodeURIComponent(currentFile), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: editor.value })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    originalContent = editor.value;
    dirty = false;
    showStatus('Gespeichert!', false);
  } catch (err) {
    saveBtn.disabled = false;
    showStatus('Fehler: ' + err.message, true);
  }
}

async function regenerate() {
  regenBtn.disabled = true;
  loading.classList.add('show');
  try {
    const res = await fetch('/api/ha-regenerate', { method: 'POST' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    showStatus(data.message || 'Regeneriert!', false);
    // Reload current file if it's the full list
    if (currentFile === 'ha-devices.md') {
      await loadFile('ha-devices.md');
    }
  } catch (err) {
    showStatus('Fehler: ' + err.message, true);
  } finally {
    regenBtn.disabled = false;
    loading.classList.remove('show');
  }
}

function showStatus(msg, isError) {
  saveStatus.textContent = msg;
  saveStatus.className = 'save-status show' + (isError ? ' error' : '');
  setTimeout(() => { saveStatus.classList.remove('show'); }, 3000);
}

function updatePreview() {
  preview.innerHTML = md2html(editor.value);
}

function updateLineCount() {
  const lines = editor.value.split('\\n').length;
  lineCountEl.textContent = lines + ' Zeilen';
}

// --- Events ---
editor.addEventListener('input', () => {
  dirty = editor.value !== originalContent;
  saveBtn.disabled = !dirty;
  updatePreview();
  updateLineCount();
});

// Tab key inserts spaces
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = editor.selectionStart;
    editor.value = editor.value.substring(0, start) + '  ' + editor.value.substring(editor.selectionEnd);
    editor.selectionStart = editor.selectionEnd = start + 2;
    editor.dispatchEvent(new Event('input'));
  }
});

// Ctrl+S to save
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveFile();
  }
});

// File tabs
document.querySelectorAll('.file-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (dirty && !confirm('Ungespeicherte Änderungen verwerfen?')) return;
    loadFile(tab.dataset.file);
  });
});

saveBtn.addEventListener('click', saveFile);
regenBtn.addEventListener('click', regenerate);

// Initial load
loadFile('ha-devices-compact.md');
</script>
</body>
</html>`;
}

// --- Settings HTML ---

function getSettingsHTML() {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon/favicon.svg">
<link rel="icon" type="image/png" sizes="96x96" href="/favicon/favicon-96x96.png">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="apple-touch-icon" sizes="180x180" href="/favicon/apple-touch-icon.png">
<title>${BOT_NAME} - Einstellungen</title>
${getGoogleFontsLink(getActiveTheme())}
${getThemeCSS()}
<style>

  .banner {
    background: var(--btn-primary-bg); color: #fff; padding: 10px 16px; display: none;
    align-items: center; gap: 12px; font-size: 13px;
  }
  .banner.show { display: flex; }
  .banner .restart-btn {
    background: #fff; color: var(--btn-primary-bg); border: none; padding: 4px 14px;
    border-radius: 4px; cursor: pointer; font-family: inherit; font-size: 12px;
    font-weight: 600;
  }
  .banner .restart-btn:hover { background: var(--text-bright); }
  .banner .restart-btn:disabled { opacity: 0.6; cursor: not-allowed; }

  .settings-container {
    max-width: 800px; margin: 20px auto; padding: 0 16px;
  }
  .settings-group {
    background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px;
    margin-bottom: 16px; overflow: hidden;
  }
  .settings-group h2 {
    font-size: 13px; color: var(--accent); padding: 12px 16px;
    background: var(--bg-primary); border-bottom: 1px solid var(--border-color);
    font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
  }
  .settings-group .fields { padding: 12px 16px; }
  .field-row {
    display: flex; align-items: center; gap: 12px; padding: 8px 0;
    border-bottom: 1px solid var(--bg-tertiary);
  }
  .field-row:last-child { border-bottom: none; }
  .field-label {
    min-width: 200px; font-size: 12px; color: var(--text-muted); font-weight: 600;
  }
  .field-input-wrap {
    flex: 1; position: relative; display: flex; align-items: center;
  }
  .field-input-wrap input, .field-input-wrap select {
    width: 100%; background: var(--bg-primary); border: 1px solid var(--border-color); color: var(--text-primary);
    padding: 8px 12px; border-radius: 6px; font-family: inherit; font-size: 13px;
    outline: none; transition: border-color 0.15s;
  }
  .field-input-wrap input:focus, .field-input-wrap select:focus {
    border-color: var(--accent);
  }
  .field-input-wrap select {
    appearance: none; cursor: pointer;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%238b949e'%3E%3Cpath d='M6 8L1 3h10z'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 10px center;
    padding-right: 30px;
  }
  .eye-toggle {
    position: absolute; right: 8px; background: none; border: none;
    color: var(--text-dim); cursor: pointer; font-size: 16px; padding: 4px;
    line-height: 1;
  }
  .eye-toggle:hover { color: var(--text-muted); }
  .field-input-wrap input[type="password"] { padding-right: 36px; }
  .field-input-wrap input[type="text"].has-eye { padding-right: 36px; }

  .save-bar {
    position: sticky; bottom: 0; background: var(--bg-secondary);
    border-top: 1px solid var(--border-color); padding: 12px 16px;
    display: flex; align-items: center; justify-content: center; gap: 12px;
  }
  .save-btn {
    background: var(--btn-primary-bg); border: 1px solid var(--btn-primary-hover); color: #fff;
    padding: 8px 24px; border-radius: 6px; cursor: pointer;
    font-family: inherit; font-size: 13px; font-weight: 600;
    transition: all 0.15s;
  }
  .save-btn:hover { background: var(--btn-primary-hover); }
  .save-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .model-row {
    display: flex; align-items: center; gap: 10px; padding: 6px 0;
    border-bottom: 1px solid var(--bg-tertiary);
  }
  .model-row:last-child { border-bottom: none; }
  .model-name { flex: 1; font-size: 13px; color: var(--text-primary); }
  .model-info { font-size: 11px; color: var(--text-dim); }
  .model-active { font-size: 10px; color: var(--color-success); background: rgba(63,185,80,0.1); padding: 2px 8px; border-radius: 10px; }
  .model-btn {
    font-size: 11px; padding: 3px 10px; border-radius: 4px; cursor: pointer;
    border: 1px solid var(--border-color); background: var(--bg-tertiary);
    color: var(--text-muted); font-family: inherit;
  }
  .model-btn:hover { border-color: var(--accent); color: var(--accent); }
  .model-btn.active-btn { border-color: var(--color-success); color: var(--color-success); }
  .model-btn.del-btn:hover { border-color: var(--color-error); color: var(--color-error); }

  .avatar-section {
    display: flex; align-items: center; gap: 16px; padding: 12px 0;
  }
  .avatar-preview {
    width: 80px; height: 80px; border-radius: 50%; border: 2px solid var(--border-color);
    object-fit: cover; background: var(--bg-tertiary);
  }
  .avatar-placeholder {
    width: 80px; height: 80px; border-radius: 50%; border: 2px dashed var(--border-color);
    display: flex; align-items: center; justify-content: center;
    font-size: 28px; color: var(--text-dim); background: var(--bg-tertiary);
  }
  .avatar-actions { display: flex; flex-direction: column; gap: 6px; }
  .avatar-actions label, .avatar-actions button {
    font-size: 12px; padding: 5px 14px; border-radius: 5px; cursor: pointer;
    border: 1px solid var(--border-color); background: var(--bg-tertiary);
    color: var(--text-primary); font-family: inherit; text-align: center;
    transition: all 0.15s;
  }
  .avatar-actions label:hover, .avatar-actions button:hover {
    border-color: var(--accent); color: var(--accent);
  }
  .avatar-actions .delete-btn:hover { border-color: var(--color-error); color: var(--color-error); }
  .avatar-status { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
  #avatarFileInput { display: none; }

  @media (max-width: 600px) {
    .field-row { flex-direction: column; align-items: flex-start; gap: 4px; }
    .field-label { min-width: unset; }
  }

  /* scrollbar */
</style>
</head>
<body>
<header>
  <h1>Einstellungen</h1>
  <a href="/">Monitor</a>
  <a href="/chat">Chat</a>
  <a href="/system">System</a>
  <a href="/ha-editor">Smart Home Editor</a>
  <a href="/notes">Wissensbasis</a>
  <a href="/reminders">Erinnerungen</a>
  <a href="/terminal">Terminal</a>
  <a href="/community">Community</a>
  <a href="/delegations">Delegationen</a>
  <a href="/roadmap">Roadmap</a>
  <a href="/tools">Tools</a>
  <a href="/workflows">Workflows</a>
</header>

<div class="banner" id="banner">
  <span>Gespeichert. Neustart erforderlich f&uuml;r &Auml;nderungen.</span>
  <button class="restart-btn" id="restartBtn" onclick="doRestart()">Neustart</button>
</div>

<div class="settings-container">
  <div class="settings-group">
    <h2>Profil</h2>
    <div class="fields">
      <div class="field-row">
        <label class="field-label">Profilbild</label>
        <div class="avatar-section">
          <div id="avatarContainer"><div class="avatar-placeholder">?</div></div>
          <div class="avatar-actions">
            <label for="avatarFileInput">Bild hochladen</label>
            <input type="file" id="avatarFileInput" accept="image/png,image/jpeg,image/webp">
            <button class="delete-btn" id="avatarDeleteBtn" style="display:none" onclick="deleteAvatar()">Entfernen</button>
            <div class="avatar-status" id="avatarStatus"></div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div class="settings-group">
    <h2>Erscheinungsbild</h2>
    <div class="fields">
      <div class="field-row">
        <label class="field-label">Theme</label>
        <div class="field-input-wrap" style="display:flex;gap:8px;align-items:center">
          <select id="themeSelect" onchange="changeTheme(this.value)"></select>
          <a href="/theme-editor" style="font-size:11px;color:var(--accent);text-decoration:none;white-space:nowrap">Editor</a>
        </div>
      </div>
    </div>
  </div>
  <div id="settingsInner"></div>

  <div class="settings-group" id="ollamaModels" style="display:none">
    <h2>Ollama Modelle</h2>
    <div class="fields">
      <div id="modelList" style="padding:4px 0"></div>
      <div class="field-row" style="border:none;padding-top:8px">
        <label class="field-label">Modell hinzufügen</label>
        <div class="field-input-wrap" style="display:flex;gap:6px">
          <input type="text" id="newModelName" placeholder="z.B. minimax-m2.7:cloud oder llama3.1:8b">
          <button onclick="pullModel()" style="background:var(--btn-primary-bg);color:#fff;border:1px solid var(--btn-primary-hover);padding:6px 16px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:12px;white-space:nowrap">Laden</button>
        </div>
      </div>
      <div id="pullStatus" style="font-size:12px;color:var(--text-muted);padding:4px 0"></div>
    </div>
  </div>
</div>

<div class="save-bar">
  <span class="save-status" id="saveStatus"></span>
  <button class="save-btn" id="saveBtn" onclick="saveSettings()">Speichern (Ctrl+S)</button>
</div>

<script>
const SETTINGS_GROUPS = [
  {
    title: "Personalisierung",
    fields: [
      { key: "BOT_NAME", label: "Bot-Name", type: "text" },
      { key: "OWNER_NAME", label: "Dein Name", type: "text" },
      { key: "OWNER_CITY", label: "Stadt (Wetter)", type: "text" },
      { key: "BOT_LANG", label: "Sprache", type: "select",
        options: [
          { value: "de", label: "Deutsch" },
          { value: "en", label: "English" }
        ]
      },
      { key: "TZ", label: "Zeitzone", type: "text" }
    ]
  },
  {
    title: "Monitor (Zugang)",
    fields: [
      { key: "MONITOR_USER", label: "Benutzername", type: "text" },
      { key: "MONITOR_PASS", label: "Passwort", type: "password" }
    ]
  },
  {
    title: "KI-Modell",
    fields: [
      { key: "LLM_PROVIDER", label: "Provider", type: "select",
        options: [
          { value: "ollama", label: "Ollama" },
          { value: "anthropic", label: "Anthropic (Claude)" },
          { value: "groq", label: "Groq" },
          { value: "openai", label: "OpenAI" }
        ]
      },
      { key: "OLLAMA_BASE_URL", label: "Ollama URL", type: "text", provider: "ollama" },
      { key: "OLLAMA_MODEL", label: "Aktives Modell", type: "text", provider: "ollama", hidden: true },
      { key: "ANTHROPIC_API_KEY", label: "Anthropic API Key", type: "password", provider: "anthropic" },
      { key: "CLAUDE_MODEL", label: "Claude Modell", type: "text", provider: "anthropic" },
      { key: "GROQ_API_KEY", label: "Groq API Key", type: "password", provider: "groq" },
      { key: "GROQ_MODEL", label: "Groq Modell", type: "text", provider: "groq" },
      { key: "MAX_TOKENS", label: "Max Tokens", type: "text" },
      { key: "OPENAI_API_KEY", label: "OpenAI API Key (DALL-E)", type: "password" }
    ]
  },
  {
    title: "Sprache",
    fields: [
      { key: "TTS_VOICE", label: "TTS Stimme", type: "select",
        options: [
          { value: "de-DE-KillianNeural", label: "Killian (männlich)" },
          { value: "de-DE-ConradNeural", label: "Conrad (männlich)" },
          { value: "de-DE-FlorianMultilingualNeural", label: "Florian (männlich, multilingual)" },
          { value: "de-DE-AmalaNeural", label: "Amala (weiblich)" },
          { value: "de-DE-KatjaNeural", label: "Katja (weiblich)" },
          { value: "de-DE-SeraphinaMultilingualNeural", label: "Seraphina (weiblich, multilingual)" }
        ]
      },
      { key: "WHISPER_MODEL", label: "Whisper Modell", type: "select",
        options: [
          { value: "tiny", label: "tiny" },
          { value: "base", label: "base" },
          { value: "small", label: "small" },
          { value: "medium", label: "medium" }
        ]
      }
    ]
  },
  {
    title: "Telegram",
    fields: [
      { key: "TELEGRAM_TOKEN", label: "Bot Token", type: "password" },
      { key: "TELEGRAM_ALLOWED_USERS", label: "Erlaubte User-IDs", type: "text" }
    ]
  },
  {
    title: "E-Mail (IMAP/SMTP)",
    fields: [
      { key: "EMAIL_HOST", label: "IMAP-Host (z.B. imap.gmail.com)", type: "text" },
      { key: "EMAIL_USER", label: "E-Mail-Adresse", type: "text" },
      { key: "EMAIL_PASSWORD", label: "Passwort (App-Passwort)", type: "password" },
      { key: "EMAIL_SMTP_HOST", label: "SMTP-Host (optional, default: auto)", type: "text" },
      { key: "EMAIL_FROM", label: "Absender (optional)", type: "text" },
      { key: "EMAIL_MODE", label: "Berechtigung", type: "select",
        options: [
          { value: "read", label: "Nur lesen" },
          { value: "readwrite", label: "Lesen + Senden" }
        ]
      },
      { key: "EMAIL_MARK_READ", label: "Als gelesen markieren", type: "select",
        options: [
          { value: "false", label: "Nicht erlaubt" },
          { value: "true", label: "Erlaubt" }
        ]
      },
      { key: "EMAIL_ALLOWED_DOMAINS", label: "Senden: Erlaubte Domains", type: "text" },
      { key: "EMAIL_WHITELIST", label: "Senden: Whitelist-Adressen", type: "text" }
    ]
  },
  {
    title: "Kalender (CalDAV)",
    fields: [
      { key: "CALDAV_URL", label: "CalDAV-URL", type: "text" },
      { key: "CALDAV_USER", label: "Benutzername", type: "text" },
      { key: "CALDAV_PASSWORD", label: "Passwort", type: "password" },
      { key: "CALDAV_MODE", label: "Berechtigung", type: "select",
        options: [
          { value: "read", label: "Nur lesen" },
          { value: "readwrite", label: "Lesen + Schreiben" }
        ]
      }
    ]
  },
  {
    title: "Home Assistant",
    fields: [
      { key: "HOMEASSISTANT_URL", label: "URL", type: "text" },
      { key: "HOMEASSISTANT_TOKEN", label: "Token", type: "password" }
    ]
  },
  {
    title: "E-Mail (Kerio Connect)",
    fields: [
      { key: "KERIO_HOST", label: "Host", type: "text" },
      { key: "KERIO_USER", label: "Benutzer", type: "text" },
      { key: "KERIO_PASSWORD", label: "Passwort", type: "password" },
      { key: "KERIO_FROM", label: "Absender", type: "text" },
      { key: "MAIL_ALLOWED_DOMAINS", label: "Erlaubte Domains (kommagetrennt)", type: "text" },
      { key: "MAIL_WHITELIST", label: "Whitelist E-Mails (kommagetrennt)", type: "text" }
    ]
  },
  {
    title: "Community Chat",
    fields: [
      { key: "COMMUNITY_USER_ENABLED", label: "User-Chat aktiv", type: "select",
        options: [{ value: "false", label: "Deaktiviert" }, { value: "true", label: "Aktiviert" }]
      },
      { key: "COMMUNITY_USER_NAME", label: "Dein Chat-Name", type: "text" },
      { key: "COMMUNITY_USER_APIKEY", label: "User API-Key", type: "password" },
      { key: "COMMUNITY_ASSISTANT_ENABLED", label: "Assistent-Chat aktiv", type: "select",
        options: [{ value: "false", label: "Deaktiviert" }, { value: "true", label: "Aktiviert" }]
      },
      { key: "COMMUNITY_ASSISTANT_NAME", label: "Assistent Chat-Name", type: "text" },
      { key: "COMMUNITY_ASSISTANT_APIKEY", label: "Assistent API-Key", type: "password" },
    ]
  },
  {
    title: "Support",
    fields: [
      { key: "SUPPORT_EMAIL", label: "Support E-Mail (für Diagnose-Reports)", type: "text" }
    ]
  },
  {
    title: "Wissensbasis",
    fields: [
      { key: "GITHUB_NOTES_REPO", label: "GitHub Repo URL", type: "text" }
    ]
  }
];

let currentSettings = {};

function escapeHtml(s) {
  const d = document.createElement("div"); d.textContent = s; return d.innerHTML;
}

function renderSettings(data) {
  currentSettings = data;
  const container = document.getElementById("settingsInner");
  let html = "";

  SETTINGS_GROUPS.forEach(group => {
    html += '<div class="settings-group"><h2>' + escapeHtml(group.title) + '</h2><div class="fields">';
    group.fields.forEach(field => {
      const val = data[field.key] || "";
      const providerAttr = field.provider ? ' data-provider="' + field.provider + '"' : "";
      html += '<div class="field-row"' + providerAttr + '>';
      html += '<label class="field-label">' + escapeHtml(field.label) + '</label>';
      html += '<div class="field-input-wrap">';

      if (field.type === "select") {
        html += '<select data-key="' + field.key + '">';
        field.options.forEach(opt => {
          const sel = opt.value === val ? " selected" : "";
          html += '<option value="' + opt.value + '"' + sel + '>' + escapeHtml(opt.label) + '</option>';
        });
        html += '</select>';
      } else if (field.type === "password") {
        html += '<input type="password" data-key="' + field.key + '" value="' + escapeHtml(val) + '">';
        html += '<button type="button" class="eye-toggle" onclick="toggleEye(this)" title="Anzeigen/Verbergen">&#x1F441;</button>';
      } else {
        html += '<input type="text" data-key="' + field.key + '" value="' + escapeHtml(val) + '">';
      }

      html += '</div></div>';
    });
    html += '</div></div>';
  });

  container.innerHTML = html;
  updateProviderVisibility();

  // Provider change listener
  const providerSelect = document.querySelector('[data-key="LLM_PROVIDER"]');
  if (providerSelect) {
    providerSelect.addEventListener("change", updateProviderVisibility);
  }
}

function updateProviderVisibility() {
  const providerSelect = document.querySelector('[data-key="LLM_PROVIDER"]');
  if (!providerSelect) return;
  const provider = providerSelect.value;

  document.querySelectorAll("[data-provider]").forEach(row => {
    row.style.display = row.dataset.provider === provider ? "" : "none";
  });
}

function toggleEye(btn) {
  const input = btn.previousElementSibling;
  if (input.type === "password") {
    input.type = "text";
    input.classList.add("has-eye");
  } else {
    input.type = "password";
    input.classList.remove("has-eye");
  }
}

function gatherValues() {
  const values = {};
  document.querySelectorAll("[data-key]").forEach(el => {
    values[el.dataset.key] = el.value;
  });
  return values;
}

async function saveSettings() {
  const btn = document.getElementById("saveBtn");
  btn.disabled = true;
  try {
    const values = gatherValues();
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values)
    });
    const data = await res.json();
    if (data.ok) {
      showStatus("Gespeichert!", false);
      document.getElementById("banner").classList.add("show");
    } else {
      showStatus("Fehler: " + (data.error || "Unbekannt"), true);
    }
  } catch (err) {
    showStatus("Fehler: " + err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function doRestart() {
  const btn = document.getElementById("restartBtn");
  btn.disabled = true;
  btn.textContent = "Neustart...";
  try {
    await fetch("/api/restart", { method: "POST" });
  } catch {}
  // Poll until server is back
  let attempts = 0;
  const poll = setInterval(async () => {
    attempts++;
    try {
      const res = await fetch("/api/history", { cache: "no-store" });
      if (res.ok) {
        clearInterval(poll);
        location.reload();
      }
    } catch {}
    if (attempts > 30) {
      clearInterval(poll);
      btn.textContent = "Fehlgeschlagen";
      btn.disabled = false;
    }
  }, 2000);
}

function showStatus(msg, isError) {
  const el = document.getElementById("saveStatus");
  el.textContent = msg;
  el.className = "save-status show" + (isError ? " error" : "");
  setTimeout(() => el.classList.remove("show"), 3000);
}

// Ctrl+S
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    saveSettings();
  }
});

// Theme selector
fetch('/api/themes').then(r=>r.json()).then(d => {
  const sel = document.getElementById('themeSelect');
  sel.innerHTML = Object.entries(d.themes).map(([name, info]) =>
    '<option value="' + name + '">' + name + (info.builtin ? '' : ' (Custom)') + '</option>'
  ).join('');
  sel.value = d.active;
}).catch(() => {});
function changeTheme(t) {
  fetch('/api/theme', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({theme:t}) })
    .then(() => location.reload());
}

// Load settings
fetch("/api/settings")
  .then(r => r.json())
  .then(renderSettings)
  .catch(err => {
    document.getElementById("settingsInner").innerHTML =
      '<div style="color:var(--color-error);padding:20px;text-align:center">Fehler beim Laden: ' + err.message + '</div>';
  });

// ==================== Avatar ====================
function loadAvatar() {
  fetch("/api/avatar").then(r => {
    if (r.ok) {
      r.blob().then(blob => {
        const url = URL.createObjectURL(blob);
        document.getElementById("avatarContainer").innerHTML =
          '<img src="' + url + '" class="avatar-preview" alt="Profilbild">';
        document.getElementById("avatarDeleteBtn").style.display = "";
      });
    }
  }).catch(() => {});
}

document.getElementById("avatarFileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    document.getElementById("avatarStatus").textContent = "Max. 5 MB";
    return;
  }
  const status = document.getElementById("avatarStatus");
  status.textContent = "Hochladen...";
  try {
    const formData = new FormData();
    formData.append("avatar", file);
    const res = await fetch("/api/avatar", { method: "POST", body: formData });
    const data = await res.json();
    if (data.ok) {
      status.textContent = data.telegram ? "Gespeichert + Telegram aktualisiert" : "Gespeichert";
      status.style.color = "var(--color-success)";
      loadAvatar();
    } else {
      status.textContent = data.error || "Fehler";
      status.style.color = "var(--color-error)";
    }
  } catch (err) {
    status.textContent = "Fehler: " + err.message;
    status.style.color = "var(--color-error)";
  }
  e.target.value = "";
});

async function deleteAvatar() {
  if (!confirm("Profilbild entfernen?")) return;
  const status = document.getElementById("avatarStatus");
  try {
    const res = await fetch("/api/avatar", { method: "DELETE" });
    const data = await res.json();
    if (data.ok) {
      document.getElementById("avatarContainer").innerHTML = '<div class="avatar-placeholder">?</div>';
      document.getElementById("avatarDeleteBtn").style.display = "none";
      status.textContent = data.telegram ? "Entfernt + Telegram aktualisiert" : "Entfernt";
      status.style.color = "var(--color-success)";
    }
  } catch (err) {
    status.textContent = "Fehler: " + err.message;
    status.style.color = "var(--color-error)";
  }
}

loadAvatar();

// ==================== Ollama Model Manager ====================
let ollamaModels = [];

async function loadOllamaModels() {
  const panel = document.getElementById('ollamaModels');
  const providerSel = document.querySelector('[data-key="LLM_PROVIDER"]');
  const urlInput = document.querySelector('[data-key="OLLAMA_BASE_URL"]');

  // Nur anzeigen wenn Provider = ollama
  const isOllama = (providerSel && providerSel.value === 'ollama') ||
    (currentSettings.LLM_PROVIDER === 'ollama');
  if (!isOllama) { panel.style.display = 'none'; return; }
  panel.style.display = '';

  const baseUrl = (urlInput ? urlInput.value : currentSettings.OLLAMA_BASE_URL || 'http://localhost:11434/v1').replace('/v1', '');
  try {
    const res = await fetch('/api/ollama/models?base=' + encodeURIComponent(baseUrl));
    if (!res.ok) throw new Error('Nicht erreichbar');
    const data = await res.json();
    ollamaModels = data.models || [];
    renderModels();
  } catch (e) {
    document.getElementById('modelList').innerHTML =
      '<div style="color:var(--color-error);padding:8px 0;font-size:12px">Ollama nicht erreichbar (' + baseUrl + ')</div>';
  }
}

function renderModels() {
  const list = document.getElementById('modelList');
  const activeModel = currentSettings.OLLAMA_MODEL || '';

  if (ollamaModels.length === 0) {
    list.innerHTML = '<div style="color:var(--text-dim);padding:8px 0;font-size:12px">Keine Modelle geladen</div>';
    return;
  }

  list.innerHTML = ollamaModels.map(m => {
    const isActive = m.name === activeModel;
    const size = m.size > 1e9 ? (m.size / 1e9).toFixed(1) + ' GB' :
                 m.size > 1e6 ? (m.size / 1e6).toFixed(0) + ' MB' :
                 m.size > 0 ? (m.size / 1e3).toFixed(0) + ' KB' : 'Cloud';
    return '<div class="model-row">' +
      '<span class="model-name">' + escapeHtml(m.name) + '</span>' +
      '<span class="model-info">' + size + '</span>' +
      (isActive ? '<span class="model-active">aktiv</span>' : '<button class="model-btn active-btn" onclick="selectModel(\\'' + escapeHtml(m.name) + '\\')">Aktivieren</button>') +
      '<button class="model-btn del-btn" onclick="deleteModel(\\'' + escapeHtml(m.name) + '\\')" title="Modell löschen">\\u2715</button>' +
      '</div>';
  }).join('');
}

function selectModel(name) {
  const input = document.querySelector('[data-key="OLLAMA_MODEL"]');
  if (input) input.value = name;
  currentSettings.OLLAMA_MODEL = name;
  renderModels();
  document.getElementById('saveStatus').textContent = 'Modell gewählt — bitte speichern';
  document.getElementById('saveStatus').style.color = 'var(--color-warning)';
}

async function deleteModel(name) {
  if (!confirm('Modell "' + name + '" wirklich löschen?')) return;
  const baseUrl = (currentSettings.OLLAMA_BASE_URL || 'http://localhost:11434/v1').replace('/v1', '');
  try {
    const res = await fetch('/api/ollama/models?base=' + encodeURIComponent(baseUrl) + '&name=' + encodeURIComponent(name), { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) loadOllamaModels();
    else alert(data.error || 'Fehler');
  } catch (e) { alert('Fehler: ' + e.message); }
}

async function pullModel() {
  const name = document.getElementById('newModelName').value.trim();
  if (!name) return;
  const status = document.getElementById('pullStatus');
  const baseUrl = (currentSettings.OLLAMA_BASE_URL || 'http://localhost:11434/v1').replace('/v1', '');
  status.textContent = 'Lade ' + name + '... (kann etwas dauern)';
  status.style.color = 'var(--color-warning)';
  try {
    const res = await fetch('/api/ollama/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base: baseUrl, name })
    });
    const data = await res.json();
    if (data.ok) {
      status.textContent = name + ' erfolgreich geladen!';
      status.style.color = 'var(--color-success)';
      document.getElementById('newModelName').value = '';
      loadOllamaModels();
    } else {
      status.textContent = data.error || 'Fehler';
      status.style.color = 'var(--color-error)';
    }
  } catch (e) {
    status.textContent = 'Fehler: ' + e.message;
    status.style.color = 'var(--color-error)';
  }
}

// Provider-Wechsel beobachten
setTimeout(() => {
  const sel = document.querySelector('[data-key="LLM_PROVIDER"]');
  if (sel) sel.addEventListener('change', () => setTimeout(loadOllamaModels, 100));
  loadOllamaModels();
}, 500);
</script>
</body>
</html>`;
}

// --- Notes Editor HTML ---

function getNotesHTML() {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon/favicon.svg">
<link rel="icon" type="image/png" sizes="96x96" href="/favicon/favicon-96x96.png">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="apple-touch-icon" sizes="180x180" href="/favicon/apple-touch-icon.png">
<title>${BOT_NAME} - Wissensbasis</title>
${getGoogleFontsLink(getActiveTheme())}
${getThemeCSS()}
<style>
  body { height: 100vh; display: flex; flex-direction: column; }
  .toolbar {
    background: var(--bg-secondary); border-bottom: 1px solid var(--border-color); padding: 8px 16px;
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  }
  .btn-danger { background: var(--bg-tertiary); border-color: var(--color-error); color: var(--color-error); }
  .btn-danger:hover { background: color-mix(in srgb, var(--color-error) 13%, transparent); }
  .btn-sync { background: var(--bg-tertiary); border-color: var(--color-warning); color: var(--color-warning); }
  .btn-sync:hover { background: color-mix(in srgb, var(--color-warning) 13%, transparent); }
  .spacer { flex: 1; }
  .search-input {
    background: var(--bg-primary); border: 1px solid var(--border-color); color: var(--text-primary);
    padding: 6px 12px; border-radius: 6px; font-family: inherit; font-size: 12px;
    outline: none; width: 200px;
  }
  .search-input:focus { border-color: var(--accent); }
  .main {
    flex: 1; display: flex; overflow: hidden;
  }
  /* Sidebar */
  .sidebar {
    width: 260px; min-width: 200px; background: var(--bg-primary);
    border-right: 1px solid var(--border-color); overflow-y: auto; display: flex;
    flex-direction: column;
  }
  .sidebar-header {
    padding: 8px 12px; font-size: 11px; color: var(--text-muted); border-bottom: 1px solid var(--bg-tertiary);
    font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
  }
  .note-item {
    padding: 10px 12px; cursor: pointer; border-bottom: 1px solid var(--bg-tertiary);
    transition: background 0.15s;
  }
  .note-item:hover { background: var(--bg-secondary); }
  .note-item.active { background: color-mix(in srgb, var(--accent) 13%, transparent); border-left: 3px solid var(--accent); }
  .note-item .note-title {
    font-size: 12px; font-weight: 600; color: var(--text-bright);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .note-item .note-meta {
    font-size: 10px; color: var(--text-muted); margin-top: 3px;
    display: flex; gap: 8px; align-items: center;
  }
  .note-item .note-tags {
    font-size: 10px; color: var(--color-info); margin-top: 2px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .sidebar-empty {
    padding: 20px 12px; color: var(--text-dim); text-align: center; font-size: 12px;
  }
  /* Editor + Preview */
  .editor-pane {
    flex: 1; display: flex; flex-direction: column; min-width: 0;
    border-right: 1px solid var(--border-color);
  }
  .editor-pane .pane-header {
    background: var(--bg-secondary); padding: 6px 16px; font-size: 11px; color: var(--text-muted);
    border-bottom: 1px solid var(--border-color); display: flex; align-items: center; gap: 8px;
  }
  .editor-pane .pane-header .line-count { margin-left: auto; }
  #editor {
    flex: 1; width: 100%; background: var(--bg-primary); color: var(--text-primary); border: none;
    padding: 12px 16px; font-family: inherit; font-size: 13px; line-height: 1.6;
    resize: none; outline: none; tab-size: 2;
  }
  .preview-pane {
    flex: 1; display: flex; flex-direction: column; min-width: 0; overflow: hidden;
  }
  .preview-pane .pane-header {
    background: var(--bg-secondary); padding: 6px 16px; font-size: 11px; color: var(--text-muted);
    border-bottom: 1px solid var(--border-color);
  }
  #preview {
    flex: 1; overflow-y: auto; padding: 16px; line-height: 1.6;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px;
  }
  #preview h1 { font-size: 20px; color: var(--accent); margin: 16px 0 8px; border-bottom: 1px solid var(--border-color); padding-bottom: 6px; }
  #preview h2 { font-size: 17px; color: var(--color-info); margin: 14px 0 6px; }
  #preview h3 { font-size: 14px; color: var(--color-warning); margin: 10px 0 4px; }
  #preview ul, #preview ol { padding-left: 20px; margin: 4px 0; }
  #preview li { margin: 2px 0; }
  #preview code {
    background: var(--bg-secondary); padding: 2px 6px; border-radius: 4px;
    font-family: var(--font-body); font-size: 12px; color: var(--accent);
  }
  #preview table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 12px; }
  #preview th {
    background: var(--bg-secondary); border: 1px solid var(--border-color); padding: 6px 10px;
    text-align: left; color: var(--text-muted); font-weight: 600;
  }
  #preview td { border: 1px solid var(--border-color); padding: 4px 10px; }
  #preview tr:hover td { background: var(--bg-secondary); }
  #preview blockquote {
    border-left: 3px solid var(--text-dim); padding: 4px 12px; margin: 8px 0;
    color: var(--text-muted); font-style: italic;
  }
  #preview strong { color: var(--text-bright); }
  #preview em { color: var(--text-muted); }
  .welcome-msg {
    display: flex; align-items: center; justify-content: center;
    height: 100%; color: var(--text-dim); font-size: 14px; text-align: center;
    padding: 20px; line-height: 1.8;
  }
  /* Upload overlay */
  .upload-input { display: none; }
  @media (max-width: 900px) {
    .main { flex-direction: column; }
    .sidebar { width: 100%; max-height: 200px; border-right: none; border-bottom: 1px solid var(--border-color); }
    .editor-pane { border-right: none; border-bottom: 1px solid var(--border-color); }
  }
</style>
</head>
<body>
<header>
  <h1>Wissensbasis</h1>
  <a href="/">Monitor</a>
  <a href="/chat">Chat</a>
  <a href="/system">System</a>
  <a href="/ha-editor">Smart Home Editor</a>
  <a href="/reminders">Erinnerungen</a>
  <a href="/terminal">Terminal</a>
  <a href="/settings">Einstellungen</a>
  <a href="/community">Community</a>
  <a href="/delegations">Delegationen</a>
  <a href="/roadmap">Roadmap</a>
  <a href="/tools">Tools</a>
  <a href="/workflows">Workflows</a>
</header>

<div class="toolbar">
  <button class="btn btn-primary" id="newBtn">Neue Notiz</button>
  <button class="btn" id="uploadBtn">Upload</button>
  <button class="btn btn-sync" id="syncBtn">Git Sync</button>
  <input type="file" id="uploadInput" class="upload-input" accept=".txt,.md" multiple>
  <span class="spacer"></span>
  <span class="save-status" id="saveStatus"></span>
  <input type="text" class="search-input" id="searchInput" placeholder="Suche...">
  <button class="btn btn-danger" id="deleteBtn" style="display:none">Löschen</button>
  <button class="btn btn-primary" id="saveBtn" disabled>Speichern (Ctrl+S)</button>
</div>

<div class="main">
  <div class="sidebar" id="sidebar">
    <div class="sidebar-header">Notizen <span id="noteCount">0</span></div>
    <div id="noteList"></div>
  </div>
  <div class="editor-pane">
    <div class="pane-header">
      <span id="fileName">-</span>
      <span class="line-count" id="lineCount">0 Zeilen</span>
    </div>
    <textarea id="editor" spellcheck="false" placeholder="Notiz auswählen oder neue erstellen..."></textarea>
  </div>
  <div class="preview-pane">
    <div class="pane-header">Vorschau</div>
    <div id="preview"><div class="welcome-msg">Notiz auswählen oder neue Notiz erstellen</div></div>
  </div>
</div>

<script>
const editor = document.getElementById('editor');
const preview = document.getElementById('preview');
const saveBtn = document.getElementById('saveBtn');
const deleteBtn = document.getElementById('deleteBtn');
const syncBtn = document.getElementById('syncBtn');
const newBtn = document.getElementById('newBtn');
const uploadBtn = document.getElementById('uploadBtn');
const uploadInput = document.getElementById('uploadInput');
const saveStatus = document.getElementById('saveStatus');
const fileNameEl = document.getElementById('fileName');
const lineCountEl = document.getElementById('lineCount');
const noteListEl = document.getElementById('noteList');
const noteCountEl = document.getElementById('noteCount');
const searchInput = document.getElementById('searchInput');

let currentFile = null;
let originalContent = '';
let dirty = false;
let allNotes = [];

// --- Markdown to HTML ---
function md2html(md) {
  let html = '';
  const lines = md.split('\\n');
  let inTable = false, inList = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (inList && !/^\\s*[-*]\\s/.test(line)) { html += '</ul>'; inList = false; }
    if (/^\\|(.+)\\|\\s*$/.test(line)) {
      if (!inTable) {
        html += '<table>'; inTable = true;
        const cells = line.split('|').filter(c => c.trim());
        html += '<tr>' + cells.map(c => '<th>' + esc(c.trim()) + '</th>').join('') + '</tr>';
        if (i + 1 < lines.length && /^\\|[-:\\s|]+\\|\\s*$/.test(lines[i+1])) i++;
        continue;
      }
      const cells = line.split('|').filter(c => c.trim());
      html += '<tr>' + cells.map(c => '<td>' + inlineFormat(c.trim()) + '</td>').join('') + '</tr>';
      continue;
    } else if (inTable) { html += '</table>'; inTable = false; }
    if (/^### /.test(line)) { html += '<h3>' + inlineFormat(line.slice(4)) + '</h3>'; continue; }
    if (/^## /.test(line)) { html += '<h2>' + inlineFormat(line.slice(3)) + '</h2>'; continue; }
    if (/^# /.test(line)) { html += '<h1>' + inlineFormat(line.slice(2)) + '</h1>'; continue; }
    if (/^>\\s?/.test(line)) { html += '<blockquote>' + inlineFormat(line.replace(/^>\\s?/, '')) + '</blockquote>'; continue; }
    if (/^\\s*[-*]\\s/.test(line)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += '<li>' + inlineFormat(line.replace(/^\\s*[-*]\\s/, '')) + '</li>';
      continue;
    }
    if (line.trim() === '') { html += '<br>'; continue; }
    html += '<p>' + inlineFormat(line) + '</p>';
  }
  if (inTable) html += '</table>';
  if (inList) html += '</ul>';
  return html;
}
function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function inlineFormat(s) {
  s = esc(s);
  s = s.replace(/\\\`([^\\\`]+)\\\`/g, '<code>$1</code>');
  s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  s = s.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
  s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
  return s;
}

// --- API ---
async function loadNotes() {
  try {
    const res = await fetch('/api/notes');
    allNotes = await res.json();
    renderNoteList();
  } catch (err) {
    showStatus('Fehler beim Laden: ' + err.message, true);
  }
}

function renderNoteList(filter) {
  const q = (filter || searchInput.value || '').toLowerCase();
  const filtered = q
    ? allNotes.filter(n => (n.title + ' ' + (n.tags||[]).join(' ')).toLowerCase().includes(q))
    : allNotes;

  noteCountEl.textContent = filtered.length;

  if (filtered.length === 0) {
    noteListEl.innerHTML = '<div class="sidebar-empty">' + (q ? 'Keine Treffer' : 'Noch keine Notizen') + '</div>';
    return;
  }

  noteListEl.innerHTML = filtered.map(n =>
    '<div class="note-item' + (n.filename === currentFile ? ' active' : '') + '" data-file="' + esc(n.filename) + '">' +
    '<div class="note-title">' + esc(n.title) + '</div>' +
    (n.tags && n.tags.length ? '<div class="note-tags">' + n.tags.map(t => '#' + esc(t)).join(' ') + '</div>' : '') +
    '<div class="note-meta"><span>' + esc(n.updated) + '</span><span>' + esc(n.sizeStr || '') + '</span></div>' +
    '</div>'
  ).join('');

  noteListEl.querySelectorAll('.note-item').forEach(el => {
    el.addEventListener('click', () => {
      if (dirty && !confirm('Ungespeicherte Änderungen verwerfen?')) return;
      openNote(el.dataset.file);
    });
  });
}

async function openNote(filename) {
  try {
    const res = await fetch('/api/notes/' + encodeURIComponent(filename));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    editor.value = data.content;
    originalContent = data.content;
    currentFile = filename;
    dirty = false;
    saveBtn.disabled = true;
    deleteBtn.style.display = '';
    fileNameEl.textContent = filename;
    updatePreview();
    updateLineCount();
    renderNoteList();
  } catch (err) {
    showStatus('Fehler: ' + err.message, true);
  }
}

async function saveNote() {
  if (!dirty || !currentFile) return;
  saveBtn.disabled = true;
  try {
    const res = await fetch('/api/notes/' + encodeURIComponent(currentFile), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: editor.value })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    originalContent = editor.value;
    dirty = false;
    showStatus('Gespeichert!', false);
    loadNotes();
  } catch (err) {
    saveBtn.disabled = false;
    showStatus('Fehler: ' + err.message, true);
  }
}

async function createNote() {
  const title = prompt('Titel der neuen Notiz:');
  if (!title) return;
  const tags = prompt('Tags (kommagetrennt, optional):', '') || '';
  try {
    const res = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content: '', tags })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    await loadNotes();
    openNote(data.filename);
    showStatus('Erstellt: ' + data.filename, false);
  } catch (err) {
    showStatus('Fehler: ' + err.message, true);
  }
}

async function deleteNote() {
  if (!currentFile) return;
  if (!confirm('Notiz "' + currentFile + '" wirklich löschen?')) return;
  try {
    const res = await fetch('/api/notes/' + encodeURIComponent(currentFile), { method: 'DELETE' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    currentFile = null;
    editor.value = '';
    originalContent = '';
    dirty = false;
    saveBtn.disabled = true;
    deleteBtn.style.display = 'none';
    fileNameEl.textContent = '-';
    preview.innerHTML = '<div class="welcome-msg">Notiz gelöscht</div>';
    showStatus('Gelöscht!', false);
    loadNotes();
  } catch (err) {
    showStatus('Fehler: ' + err.message, true);
  }
}

async function uploadFiles(files) {
  for (const file of files) {
    try {
      const text = await file.text();
      const filename = file.name.endsWith('.md') ? file.name : file.name.replace(/\\.txt$/, '') + '.md';
      const res = await fetch('/api/notes/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, content: text })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      showStatus('Hochgeladen: ' + filename, false);
    } catch (err) {
      showStatus('Upload-Fehler: ' + err.message, true);
    }
  }
  loadNotes();
}

async function gitSyncManual() {
  syncBtn.disabled = true;
  syncBtn.textContent = 'Sync...';
  try {
    const res = await fetch('/api/notes/sync', { method: 'POST' });
    const data = await res.json();
    showStatus(data.message || 'Sync OK', !data.ok);
  } catch (err) {
    showStatus('Sync-Fehler: ' + err.message, true);
  } finally {
    syncBtn.disabled = false;
    syncBtn.textContent = 'Git Sync';
  }
}

function showStatus(msg, isError) {
  saveStatus.textContent = msg;
  saveStatus.className = 'save-status show' + (isError ? ' error' : '');
  setTimeout(() => saveStatus.classList.remove('show'), 3000);
}

function updatePreview() {
  // Strip frontmatter for preview
  let content = editor.value;
  if (content.startsWith('---\\n')) {
    const endIdx = content.indexOf('\\n---\\n', 4);
    if (endIdx !== -1) content = content.substring(endIdx + 5);
  }
  preview.innerHTML = md2html(content);
}

function updateLineCount() {
  lineCountEl.textContent = editor.value.split('\\n').length + ' Zeilen';
}

// --- Events ---
editor.addEventListener('input', () => {
  dirty = currentFile && editor.value !== originalContent;
  saveBtn.disabled = !dirty;
  updatePreview();
  updateLineCount();
});

editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = editor.selectionStart;
    editor.value = editor.value.substring(0, start) + '  ' + editor.value.substring(editor.selectionEnd);
    editor.selectionStart = editor.selectionEnd = start + 2;
    editor.dispatchEvent(new Event('input'));
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveNote();
  }
});

saveBtn.addEventListener('click', saveNote);
deleteBtn.addEventListener('click', deleteNote);
newBtn.addEventListener('click', createNote);
syncBtn.addEventListener('click', gitSyncManual);
uploadBtn.addEventListener('click', () => uploadInput.click());
uploadInput.addEventListener('change', () => {
  if (uploadInput.files.length) uploadFiles(uploadInput.files);
  uploadInput.value = '';
});

searchInput.addEventListener('input', () => renderNoteList());

// Initial
loadNotes();
</script>
</body>
</html>`;
}

// --- Notes API Handlers ---

function handleNotesList(req, res) {
  try {
    const { getAllNotes } = require('./lib/notes-utils');
    const notes = getAllNotes().map(n => ({
      ...n,
      sizeStr: n.size < 1024 ? n.size + ' B' : (n.size / 1024).toFixed(1) + ' KB'
    }));
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(notes));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}

function handleNoteRead(req, res, filename) {
  const { validateNoteFilename, NOTES_DIR } = require('./lib/notes-utils');
  if (!validateNoteFilename(filename)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Ungültiger Dateiname" }));
    return;
  }
  try {
    const content = fs.readFileSync(path.join(NOTES_DIR, filename), "utf-8");
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ filename, content }));
  } catch {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Notiz nicht gefunden" }));
  }
}

function handleNoteCreate(req, res) {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const { ensureNotesDir, slugify, buildFrontmatter, NOTES_DIR } = require('./lib/notes-utils');
      const { gitSync } = require('./lib/git-sync');

      ensureNotesDir();
      const title = body.title || "Unbenannt";
      const tags = body.tags ? body.tags.split(",").map(t => t.trim()).filter(Boolean) : [];
      const now = new Date().toISOString().split("T")[0];
      const filename = slugify(title);

      const meta = { title, tags, created: now, updated: now };
      const content = buildFrontmatter(meta) + (body.content || "");
      fs.writeFileSync(path.join(NOTES_DIR, filename), content, "utf-8");
      db.notes.upsert(filename);
      gitSync("Neue Notiz: " + title);

      originalLog("[Monitor] Notiz erstellt: " + filename);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, filename }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

function handleNoteWrite(req, res, filename) {
  const { validateNoteFilename, NOTES_DIR } = require('./lib/notes-utils');
  if (!validateNoteFilename(filename)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Ungültiger Dateiname" }));
    return;
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const { gitSync } = require('./lib/git-sync');
      const filePath = path.join(NOTES_DIR, filename);

      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Notiz nicht gefunden" }));
        return;
      }

      fs.writeFileSync(filePath, body.content, "utf-8");
      db.notes.upsert(filename);
      gitSync("Notiz aktualisiert: " + filename);

      originalLog("[Monitor] Notiz gespeichert: " + filename);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, filename }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

function handleNoteDelete(req, res, filename) {
  const { validateNoteFilename, NOTES_DIR } = require('./lib/notes-utils');
  if (!validateNoteFilename(filename)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Ungültiger Dateiname" }));
    return;
  }
  try {
    const filePath = path.join(NOTES_DIR, filename);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Notiz nicht gefunden" }));
      return;
    }
    const { gitSync } = require('./lib/git-sync');
    fs.unlinkSync(filePath);
    db.notes.remove(filename);
    gitSync("Notiz gelöscht: " + filename);

    originalLog("[Monitor] Notiz gelöscht: " + filename);
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}

function handleNoteUpload(req, res) {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const { ensureNotesDir, validateNoteFilename, slugify, buildFrontmatter, parseFrontmatter, NOTES_DIR } = require('./lib/notes-utils');
      const { gitSync } = require('./lib/git-sync');

      ensureNotesDir();

      let filename = body.filename || "upload.md";
      if (!filename.endsWith(".md")) filename += ".md";
      // Sanitize
      filename = filename.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
      if (!validateNoteFilename(filename)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Ungültiger Dateiname" }));
        return;
      }

      let content = body.content || "";
      // Add frontmatter if missing
      if (!content.startsWith("---\n")) {
        const title = filename.replace(/\.md$/, "").replace(/-/g, " ");
        const now = new Date().toISOString().split("T")[0];
        content = buildFrontmatter({ title, tags: [], created: now, updated: now }) + content;
      }

      // Collision check
      let finalFilename = filename;
      let counter = 2;
      while (fs.existsSync(path.join(NOTES_DIR, finalFilename))) {
        finalFilename = filename.replace(/\.md$/, "-" + counter + ".md");
        counter++;
      }

      fs.writeFileSync(path.join(NOTES_DIR, finalFilename), content, "utf-8");
      db.notes.upsert(finalFilename);
      gitSync("Upload: " + finalFilename);

      originalLog("[Monitor] Notiz hochgeladen: " + finalFilename);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, filename: finalFilename }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

function handleNoteSync(req, res) {
  try {
    const { gitSync, isGitRepo } = require('./lib/git-sync');
    if (!isGitRepo()) {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: false, message: "notes/ ist kein Git-Repo. Setup: cd notes && git init && git remote add origin <repo-url>" }));
      return;
    }
    gitSync("Manueller Sync");
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true, message: "Git-Sync gestartet" }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, message: err.message }));
  }
}

// --- Chat HTML ---

function getChatHTML() {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="icon" type="image/svg+xml" href="/favicon/favicon.svg">
<link rel="icon" type="image/png" sizes="96x96" href="/favicon/favicon-96x96.png">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="apple-touch-icon" sizes="180x180" href="/favicon/apple-touch-icon.png">
<title>${BOT_NAME} Chat</title>
${getGoogleFontsLink(getActiveTheme())}
${getThemeCSS()}
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="${getActiveTheme() === 'tron' ? '#05070A' : '#0d1117'}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<style>
  body { font-size: 14px; height: 100vh; height: 100dvh; display: flex; flex-direction: column; }
  header { padding: 10px 16px; gap: 12px; flex-shrink: 0; }
  header h1 { white-space: nowrap; }
  .header-actions { margin-left: auto; display: flex; gap: 8px; align-items: center; }
  .header-btn {
    background: none; border: 1px solid var(--border-color); color: var(--text-muted);
    padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 12px;
    font-family: inherit; transition: all 0.15s;
  }
  .header-btn:hover { color: var(--text-primary); border-color: var(--accent); }
  .header-btn.active { color: var(--accent); border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }

  #messages {
    flex: 1; overflow-y: auto; padding: 16px; display: flex;
    flex-direction: column; gap: 12px; scroll-behavior: smooth;
  }
  #messages::-webkit-scrollbar { width: 6px; }
  #messages::-webkit-scrollbar-track { background: transparent; }
  #messages::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 3px; }

  .msg { display: flex; flex-direction: column; max-width: 85%; animation: fadeIn 0.2s ease; }
  .msg.user { align-self: flex-end; align-items: flex-end; }
  .msg.assistant { align-self: flex-start; align-items: flex-start; }

  .bubble {
    padding: 10px 14px; border-radius: 12px; line-height: 1.55;
    word-wrap: break-word; overflow-wrap: break-word;
  }
  .msg.user .bubble {
    background: var(--accent); color: #fff; border-bottom-right-radius: 4px;
  }
  .msg.assistant .bubble {
    background: var(--bg-secondary); border: 1px solid var(--border-color); color: var(--text-primary);
    border-bottom-left-radius: 4px;
  }
  .msg .ts {
    font-size: 10px; color: var(--text-dim); margin-top: 4px; padding: 0 4px;
  }

  /* Markdown in Assistant-Bubbles */
  .bubble p { margin: 0 0 8px 0; }
  .bubble p:last-child { margin-bottom: 0; }
  .bubble strong, .bubble b { color: var(--text-bright); }
  .bubble code {
    background: color-mix(in srgb, var(--bg-primary) 53%, transparent); padding: 1px 5px; border-radius: 3px;
    font-size: 0.9em; color: var(--color-warning);
  }
  .bubble pre {
    background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px;
    padding: 10px; margin: 8px 0; overflow-x: auto; font-size: 12px;
    line-height: 1.5;
  }
  .bubble pre code { background: none; padding: 0; color: var(--text-primary); }
  .bubble ul, .bubble ol { margin: 6px 0 6px 20px; }
  .bubble li { margin: 2px 0; }
  .bubble a { color: var(--accent); text-decoration: none; }
  .bubble a:hover { text-decoration: underline; }
  .bubble blockquote {
    border-left: 3px solid var(--border-color); margin: 6px 0; padding: 4px 12px; color: var(--text-muted);
  }

  .bubble .msg-img {
    max-width: 100%; border-radius: 8px; margin: 8px 0; cursor: pointer;
  }

  /* TTS Button in Assistant-Bubbles */
  .tts-btn {
    background: none; border: none; color: var(--text-dim); cursor: pointer;
    font-size: 14px; padding: 2px 4px; margin-left: 4px; transition: color 0.15s;
  }
  .tts-btn:hover { color: var(--accent); }
  .tts-btn.playing { color: var(--color-success); }

  /* Typing Indicator */
  .typing { display: none; align-self: flex-start; padding: 0 4px; }
  .typing.visible { display: flex; }
  .typing-bubble {
    background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 12px;
    padding: 12px 18px; display: flex; gap: 5px; align-items: center;
    border-bottom-left-radius: 4px;
  }
  .typing-dot {
    width: 7px; height: 7px; background: var(--text-dim); border-radius: 50%;
    animation: typingPulse 1.4s ease-in-out infinite;
  }
  .typing-dot:nth-child(2) { animation-delay: 0.2s; }
  .typing-dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes typingPulse {
    0%, 60%, 100% { opacity: 0.3; transform: scale(0.8); }
    30% { opacity: 1; transform: scale(1); }
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* Input Area */
  .input-area {
    background: var(--bg-secondary); border-top: 1px solid var(--border-color);
    padding: 12px 16px; display: flex; gap: 10px; align-items: flex-end;
    flex-shrink: 0;
    padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px));
  }
  #voiceBtn {
    width: 40px; height: 40px; border-radius: 50%; border: 1px solid var(--border-color);
    background: var(--bg-tertiary); color: var(--text-muted); cursor: pointer; font-size: 18px;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.15s; flex-shrink: 0;
  }
  #voiceBtn:hover { border-color: var(--accent); color: var(--text-primary); }
  #voiceBtn.recording { background: color-mix(in srgb, var(--color-error) 20%, transparent); border-color: var(--color-error); color: var(--color-error); animation: pulse 1.5s infinite; }
  @keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-error) 27%, transparent); } 50% { box-shadow: 0 0 0 8px transparent; } }

  #msgInput {
    flex: 1; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 10px;
    color: var(--text-primary); padding: 10px 14px; font-family: inherit; font-size: 14px;
    resize: none; outline: none; max-height: 150px; min-height: 40px;
    line-height: 1.4; transition: border-color 0.15s;
  }
  #msgInput:focus { border-color: var(--accent); }
  #msgInput::placeholder { color: var(--text-dim); }

  #sendBtn {
    width: 40px; height: 40px; border-radius: 50%; border: none;
    background: var(--accent); color: #fff; cursor: pointer; font-size: 18px;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.15s; flex-shrink: 0;
  }
  #sendBtn:hover { background: color-mix(in srgb, var(--accent) 80%, white); }
  #sendBtn:disabled { background: var(--bg-tertiary); color: var(--text-dim); cursor: not-allowed; }

  .empty-state {
    flex: 1; display: flex; align-items: center; justify-content: center;
    color: var(--border-color); font-size: 48px; font-weight: 700; user-select: none;
  }

  @media (max-width: 600px) {
    .msg { max-width: 92%; }
    header { padding: 8px 12px; }
    .input-area { padding: 10px 12px; padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px)); }
  }
</style>
</head>
<body>
<header>
  <a href="/" style="color:var(--accent);text-decoration:none;font-size:16px;font-weight:600;border:none;padding:0;">${BOT_NAME} Chat</a>
  <div class="header-actions">
    <button class="header-btn" id="ttsToggle" title="Antworten vorlesen">TTS</button>
    <button class="header-btn" id="clearBtn" title="Chat leeren">Leeren</button>
  </div>
</header>

<div id="messages">
  <div class="empty-state">${BOT_NAME}</div>
</div>
<div class="typing" id="typing">
  <div class="typing-bubble">
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
  </div>
</div>

<div class="input-area">
  <button id="voiceBtn" title="Sprachnachricht (halten)">&#x1F3A4;</button>
  <textarea id="msgInput" placeholder="Nachricht eingeben..." rows="1"></textarea>
  <button id="sendBtn" title="Senden">&#x27A4;</button>
</div>

<script>
const messagesEl = document.getElementById("messages");
const typingEl = document.getElementById("typing");
const input = document.getElementById("msgInput");
const sendBtn = document.getElementById("sendBtn");
const voiceBtn = document.getElementById("voiceBtn");
const clearBtn = document.getElementById("clearBtn");
const ttsToggle = document.getElementById("ttsToggle");

let ttsEnabled = localStorage.getItem("jarvis-tts") === "true";
let sending = false;
let currentAudio = null;

if (ttsEnabled) ttsToggle.classList.add("active");

// --- Markdown Rendering ---
function renderMarkdown(text) {
  let html = text
    // Code Blocks
    .replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, (_, code) => '<pre><code>' + escapeHtml(code.trim()) + '</code></pre>')
    // Inline Code
    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
    // Bold
    .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    // Italic
    .replace(/\\*(.+?)\\*/g, '<em>$1</em>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    // Links
    .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    // Blockquotes
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    // Headings
    .replace(/^### (.+)$/gm, '<strong>$1</strong>')
    .replace(/^## (.+)$/gm, '<strong>$1</strong>')
    .replace(/^# (.+)$/gm, '<strong>$1</strong>');

  // Lists — unordered
  html = html.replace(/(^[-*] .+$\\n?)+/gm, (block) => {
    const items = block.trim().split('\\n').map(l => '<li>' + l.replace(/^[-*] /, '') + '</li>').join('');
    return '<ul>' + items + '</ul>';
  });
  // Lists — ordered
  html = html.replace(/(^\\d+\\. .+$\\n?)+/gm, (block) => {
    const items = block.trim().split('\\n').map(l => '<li>' + l.replace(/^\\d+\\. /, '') + '</li>').join('');
    return '<ol>' + items + '</ol>';
  });

  // Paragraphs
  html = html.replace(/\\n\\n/g, '</p><p>');
  html = html.replace(/\\n/g, '<br>');
  html = '<p>' + html + '</p>';
  html = html.replace(/<p><\\/p>/g, '');
  html = html.replace(/<p>(<pre>)/g, '$1').replace(/(<\\/pre>)<\\/p>/g, '$1');
  html = html.replace(/<p>(<ul>)/g, '$1').replace(/(<\\/ul>)<\\/p>/g, '$1');
  html = html.replace(/<p>(<ol>)/g, '$1').replace(/(<\\/ol>)<\\/p>/g, '$1');
  html = html.replace(/<p>(<blockquote>)/g, '$1').replace(/(<\\/blockquote>)<\\/p>/g, '$1');

  return html;
}

function escapeHtml(s) {
  const d = document.createElement("div"); d.textContent = s; return d.innerHTML;
}

function formatTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function clearEmpty() {
  const empty = messagesEl.querySelector(".empty-state");
  if (empty) empty.remove();
}

function addMessage(role, text, ts, images) {
  clearEmpty();
  const div = document.createElement("div");
  div.className = "msg " + role;

  let content = "";
  if (role === "assistant") {
    content = renderMarkdown(text);
  } else {
    content = escapeHtml(text);
  }

  let imgHtml = "";
  if (images && images.length > 0) {
    for (const img of images) {
      const src = img.startsWith("http") ? img : "/api/chat/images/" + img.split("/").pop();
      imgHtml += '<img class="msg-img" src="' + src + '" alt="Bild" onclick="window.open(this.src)">';
    }
  }

  const tsStr = ts ? formatTime(ts) : formatTime(new Date().toISOString());
  const ttsBtn = role === "assistant" ? ' <button class="tts-btn" onclick="playTTS(this)" title="Vorlesen">&#x1F50A;</button>' : "";

  div.innerHTML = '<div class="bubble">' + content + imgHtml + '</div>' +
    '<div class="ts">' + tsStr + ttsBtn + '</div>';
  div.dataset.text = text;

  messagesEl.appendChild(div);
  scrollBottom();
  return div;
}

// --- Send Message ---
async function sendMessage() {
  const text = input.value.trim();
  if (!text || sending) return;

  sending = true;
  sendBtn.disabled = true;
  input.value = "";
  autoResize();

  addMessage("user", text);
  typingEl.classList.add("visible");
  scrollBottom();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    const resp = await fetch("/api/chat/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    typingEl.classList.remove("visible");
    const msgEl = addMessage("assistant", data.text, null, data.images);

    if (ttsEnabled && data.text) playTTS(msgEl.querySelector(".tts-btn"));
  } catch (err) {
    typingEl.classList.remove("visible");
    if (err.name === "AbortError") {
      addMessage("assistant", "Timeout — keine Antwort innerhalb von 2 Minuten.");
    } else {
      addMessage("assistant", "Fehler: " + err.message);
    }
  } finally {
    sending = false;
    sendBtn.disabled = false;
    input.focus();
  }
}

// --- TTS ---
async function playTTS(btn) {
  if (!btn) return;
  const msgEl = btn.closest(".msg");
  const text = msgEl ? msgEl.dataset.text : "";
  if (!text) return;

  if (currentAudio) { currentAudio.pause(); currentAudio = null; }

  const prevPlaying = document.querySelector(".tts-btn.playing");
  if (prevPlaying) prevPlaying.classList.remove("playing");

  if (prevPlaying === btn) return; // Toggle off

  btn.classList.add("playing");
  try {
    const resp = await fetch("/api/chat/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!resp.ok) throw new Error("TTS-Fehler");
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    currentAudio = new Audio(url);
    currentAudio.onended = () => { btn.classList.remove("playing"); currentAudio = null; URL.revokeObjectURL(url); };
    currentAudio.onerror = () => { btn.classList.remove("playing"); currentAudio = null; };
    currentAudio.play();
  } catch {
    btn.classList.remove("playing");
  }
}

ttsToggle.addEventListener("click", () => {
  ttsEnabled = !ttsEnabled;
  localStorage.setItem("jarvis-tts", ttsEnabled);
  ttsToggle.classList.toggle("active", ttsEnabled);
});

// --- Voice Recording ---
let mediaRecorder = null;
let audioChunks = [];

voiceBtn.addEventListener("mousedown", startRecording);
voiceBtn.addEventListener("touchstart", (e) => { e.preventDefault(); startRecording(); });
voiceBtn.addEventListener("mouseup", stopRecording);
voiceBtn.addEventListener("mouseleave", stopRecording);
voiceBtn.addEventListener("touchend", stopRecording);
voiceBtn.addEventListener("touchcancel", stopRecording);

async function startRecording() {
  if (sending) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = sendVoice;
    mediaRecorder.start();
    voiceBtn.classList.add("recording");
  } catch (err) {
    console.error("Mikrofon-Fehler:", err);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(t => t.stop());
    voiceBtn.classList.remove("recording");
  }
}

async function sendVoice() {
  if (audioChunks.length === 0) return;
  const blob = new Blob(audioChunks, { type: "audio/webm" });
  audioChunks = [];

  sending = true;
  sendBtn.disabled = true;
  typingEl.classList.add("visible");
  scrollBottom();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    const resp = await fetch("/api/chat/voice", {
      method: "POST",
      headers: { "Content-Type": "audio/webm" },
      body: blob,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    typingEl.classList.remove("visible");
    addMessage("user", data.transcript);
    const msgEl = addMessage("assistant", data.text, null, data.images);

    if (ttsEnabled && data.text) playTTS(msgEl.querySelector(".tts-btn"));
  } catch (err) {
    typingEl.classList.remove("visible");
    if (err.name === "AbortError") {
      addMessage("assistant", "Timeout — keine Antwort innerhalb von 2 Minuten.");
    } else {
      addMessage("assistant", "Fehler: " + err.message);
    }
  } finally {
    sending = false;
    sendBtn.disabled = false;
  }
}

// --- Clear Chat ---
clearBtn.addEventListener("click", async () => {
  if (!confirm("Chat-Verlauf leeren?")) return;
  try {
    await fetch("/api/chat/clear", { method: "POST" });
    messagesEl.innerHTML = '<div class="empty-state">${BOT_NAME}</div>';
  } catch {}
});

// --- Input Handling ---
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
sendBtn.addEventListener("click", sendMessage);

function autoResize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 150) + "px";
}
input.addEventListener("input", autoResize);

// --- Load History ---
async function loadHistory() {
  try {
    const resp = await fetch("/api/chat/history");
    const data = await resp.json();
    if (data.messages && data.messages.length > 0) {
      clearEmpty();
      for (const msg of data.messages) {
        addMessage(msg.role, msg.text, msg.ts);
      }
    }
  } catch {}
}
loadHistory();

// --- Service Worker ---
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
</script>
</body>
</html>`;
}

// --- Theme Editor HTML ---

function getThemeEditorHTML() {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon/favicon.svg">
<link rel="icon" type="image/png" sizes="96x96" href="/favicon/favicon-96x96.png">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="apple-touch-icon" sizes="180x180" href="/favicon/apple-touch-icon.png">
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;600;700&family=Rajdhani:wght@400;500;600;700&display=swap" rel="stylesheet">
<title>${BOT_NAME} - Theme Editor</title>
${getThemeCSS()}
<style>
  .container { max-width: 1100px; margin: 20px auto; padding: 0 16px; }

  .editor-layout { display: flex; gap: 20px; }

  /* Sidebar: Theme-Liste */
  .theme-sidebar {
    width: 240px; flex-shrink: 0; display: flex; flex-direction: column; gap: 8px;
  }
  .theme-item {
    background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px;
    padding: 10px 14px; cursor: pointer; transition: all 0.15s;
  }
  .theme-item:hover { border-color: var(--accent); }
  .theme-item.active { border-color: var(--accent); box-shadow: 0 0 10px rgba(0,240,255,0.1); }
  .theme-item-name { font-weight: 600; color: var(--text-bright); font-size: 13px; }
  .theme-item-meta { font-size: 10px; color: var(--text-dim); margin-top: 2px; }
  .theme-item-actions { display: flex; gap: 6px; margin-top: 6px; }
  .theme-item-actions button {
    background: none; border: 1px solid var(--border-color); color: var(--text-muted);
    padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 10px;
    font-family: inherit; transition: all 0.15s;
  }
  .theme-item-actions button:hover { border-color: var(--accent); color: var(--text-primary); }
  .theme-item-actions .del-btn:hover { border-color: var(--color-error); color: var(--color-error); }

  .new-theme-btn {
    background: none; border: 1px dashed var(--border-color); color: var(--text-muted);
    padding: 10px; border-radius: 8px; cursor: pointer; font-family: inherit;
    font-size: 12px; transition: all 0.15s; text-align: center;
  }
  .new-theme-btn:hover { border-color: var(--accent); color: var(--accent); }

  /* Editor: Variablen */
  .theme-editor { flex: 1; min-width: 0; }
  .editor-header {
    display: flex; align-items: center; gap: 12px; margin-bottom: 16px;
  }
  .editor-title { font-family: var(--font-heading); font-size: 18px; color: var(--accent); }
  .editor-badge {
    font-size: 10px; padding: 2px 8px; border-radius: 10px;
    background: var(--bg-tertiary); color: var(--text-muted); border: 1px solid var(--border-color);
  }

  .var-group {
    background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px;
    padding: 14px 16px; margin-bottom: 12px;
  }
  .var-group h3 {
    font-size: 11px; color: var(--text-muted); text-transform: uppercase;
    letter-spacing: 1px; margin-bottom: 10px; font-weight: 600;
  }
  .var-row {
    display: flex; align-items: center; gap: 10px; padding: 4px 0;
    border-bottom: 1px solid var(--bg-tertiary);
  }
  .var-row:last-child { border-bottom: none; }
  .var-label { font-size: 12px; color: var(--text-primary); min-width: 140px; }
  .var-input {
    flex: 1; background: var(--bg-primary); border: 1px solid var(--border-color);
    color: var(--text-primary); padding: 4px 8px; border-radius: 4px;
    font-family: inherit; font-size: 12px;
  }
  .var-input:focus { outline: none; border-color: var(--accent); }
  .var-color {
    width: 32px; height: 26px; border: 1px solid var(--border-color);
    border-radius: 4px; cursor: pointer; padding: 0; background: none;
  }
  .var-color::-webkit-color-swatch-wrapper { padding: 2px; }
  .var-color::-webkit-color-swatch { border: none; border-radius: 2px; }

  .editor-actions {
    display: flex; gap: 8px; margin-top: 16px; justify-content: flex-end;
  }

  /* Preview */
  .preview-section {
    margin-top: 20px; background: var(--bg-secondary); border: 1px solid var(--border-color);
    border-radius: 8px; padding: 16px; overflow: hidden;
  }
  .preview-section h3 {
    font-size: 11px; color: var(--text-muted); text-transform: uppercase;
    letter-spacing: 1px; margin-bottom: 12px;
  }
  .preview-frame {
    border: 1px solid var(--border-color); border-radius: 6px; overflow: hidden;
    height: 200px;
  }
  .preview-frame iframe {
    width: 100%; height: 100%; border: none; transform-origin: top left;
  }

  /* New Theme Dialog */
  .dialog-overlay {
    display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.7); z-index: 10000; align-items: center; justify-content: center;
  }
  .dialog-overlay.show { display: flex; }
  .dialog {
    background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 12px;
    padding: 24px; min-width: 350px; box-shadow: 0 0 40px rgba(0,0,0,0.5);
  }
  .dialog h2 { font-family: var(--font-heading); color: var(--accent); margin-bottom: 16px; font-size: 16px; }
  .dialog input, .dialog select {
    width: 100%; background: var(--bg-primary); border: 1px solid var(--border-color);
    color: var(--text-primary); padding: 8px 12px; border-radius: 6px;
    font-family: inherit; font-size: 13px; margin-bottom: 12px;
  }
  .dialog input:focus, .dialog select:focus { outline: none; border-color: var(--accent); }
  .dialog-actions { display: flex; gap: 8px; justify-content: flex-end; }

  @media (max-width: 768px) {
    .editor-layout { flex-direction: column; }
    .theme-sidebar { width: 100%; flex-direction: row; overflow-x: auto; }
    .theme-item { min-width: 160px; }
  }
</style>
</head>
<body>
<header>
  <h1>Theme Editor</h1>
  <a href="/">Monitor</a>
  <a href="/chat">Chat</a>
  <a href="/settings">Einstellungen</a>
  <a href="/roadmap">Roadmap</a>
</header>

<div class="container">
  <div class="editor-layout">
    <div class="theme-sidebar" id="themeSidebar"></div>
    <div class="theme-editor" id="themeEditor">
      <div class="empty-state" style="font-size:14px;padding:40px">Theme auswählen oder neues erstellen</div>
    </div>
  </div>
</div>

<!-- New Theme Dialog -->
<div class="dialog-overlay" id="newDialog">
  <div class="dialog">
    <h2>Neues Theme</h2>
    <input type="text" id="newThemeName" placeholder="Name (z.B. Midnight Blue)">
    <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Basierend auf:</label>
    <select id="newThemeBase"></select>
    <div class="dialog-actions">
      <button class="btn" onclick="closeNewDialog()">Abbrechen</button>
      <button class="btn btn-primary" onclick="createTheme()">Erstellen</button>
    </div>
  </div>
</div>

<script>
let allThemes = {};
let varDefs = [];
let activeTheme = '';
let selectedTheme = null;
let editedVars = {};

function escapeHtml(s) {
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
}

async function loadThemes() {
  const res = await fetch('/api/themes');
  const data = await res.json();
  allThemes = data.themes;
  varDefs = data.varDefs;
  activeTheme = data.active;
  renderSidebar();
  if (selectedTheme && allThemes[selectedTheme]) {
    renderEditor(selectedTheme);
  }
}

function renderSidebar() {
  const sb = document.getElementById('themeSidebar');
  let html = '';
  for (const [name, info] of Object.entries(allThemes)) {
    const isActive = name === activeTheme;
    const isBuiltin = info.builtin;
    html += '<div class="theme-item' + (name === selectedTheme ? ' active' : '') + '" onclick="selectTheme(\\'' + name + '\\')">' +
      '<div class="theme-item-name">' + escapeHtml(name) + (isActive ? ' ✓' : '') + '</div>' +
      '<div class="theme-item-meta">' + (isBuiltin ? 'Eingebaut' : 'Custom') + '</div>' +
      '<div class="theme-item-actions">' +
        (isActive ? '' : '<button onclick="event.stopPropagation();activateTheme(\\'' + name + '\\')">Aktivieren</button>') +
        (!isBuiltin ? '<button class="del-btn" onclick="event.stopPropagation();deleteTheme(\\'' + name + '\\')">Löschen</button>' : '') +
      '</div>' +
    '</div>';
  }
  html += '<button class="new-theme-btn" onclick="openNewDialog()">+ Neues Theme</button>';
  sb.innerHTML = html;
}

function selectTheme(name) {
  selectedTheme = name;
  editedVars = { ...allThemes[name].vars };
  renderSidebar();
  renderEditor(name);
}

function renderEditor(name) {
  const info = allThemes[name];
  const isBuiltin = info.builtin;
  const vars = editedVars;
  const editor = document.getElementById('themeEditor');

  // Variablen nach Gruppen sortieren
  const groups = {};
  for (const def of varDefs) {
    if (!groups[def.group]) groups[def.group] = [];
    groups[def.group].push(def);
  }

  let html = '<div class="editor-header">' +
    '<span class="editor-title">' + escapeHtml(name) + '</span>' +
    '<span class="editor-badge">' + (isBuiltin ? 'Eingebaut' : 'Custom') + '</span>' +
    (name === activeTheme ? '<span class="editor-badge" style="color:var(--color-success);border-color:var(--color-success)">Aktiv</span>' : '') +
  '</div>';

  for (const [group, defs] of Object.entries(groups)) {
    html += '<div class="var-group"><h3>' + escapeHtml(group) + '</h3>';
    for (const def of defs) {
      const val = vars[def.key] || '';
      const isColor = def.type === 'color' && /^#[0-9a-fA-F]{3,8}$/.test(val);
      html += '<div class="var-row">' +
        '<span class="var-label">' + escapeHtml(def.label) + '</span>';
      if (isColor) {
        html += '<input type="color" class="var-color" value="' + val + '" data-key="' + def.key + '"' +
          ' onchange="updateVar(this)">';
      }
      html += '<input type="text" class="var-input" value="' + escapeHtml(val) + '" data-key="' + def.key + '"' +
        ' oninput="updateVarText(this)">' +
      '</div>';
    }
    html += '</div>';
  }

  html += '<div class="editor-actions">' +
    '<button class="btn" onclick="resetEdits()">Zurücksetzen</button>' +
    '<button class="btn btn-primary" onclick="saveTheme()">' + (isBuiltin ? 'Als Custom speichern' : 'Speichern') + '</button>' +
  '</div>';

  editor.innerHTML = html;
}

function updateVar(input) {
  const key = input.dataset.key;
  editedVars[key] = input.value;
  // Sync text input
  const textInput = document.querySelector('.var-input[data-key="' + key + '"]');
  if (textInput) textInput.value = input.value;
  applyPreview();
}

function updateVarText(input) {
  const key = input.dataset.key;
  editedVars[key] = input.value;
  // Sync color picker if hex
  const colorInput = document.querySelector('.var-color[data-key="' + key + '"]');
  if (colorInput && /^#[0-9a-fA-F]{6}$/.test(input.value)) {
    colorInput.value = input.value;
  }
  applyPreview();
}

function applyPreview() {
  // Live-Preview: CSS-Variablen direkt auf :root setzen
  for (const [key, val] of Object.entries(editedVars)) {
    document.documentElement.style.setProperty('--' + key, val);
  }
}

function resetEdits() {
  if (!selectedTheme) return;
  editedVars = { ...allThemes[selectedTheme].vars };
  renderEditor(selectedTheme);
  // Reset live preview
  for (const [key, val] of Object.entries(editedVars)) {
    document.documentElement.style.setProperty('--' + key, val);
  }
}

async function saveTheme() {
  if (!selectedTheme) return;
  let saveName = selectedTheme;
  // Bei eingebauten Themes: als Custom-Kopie speichern
  if (allThemes[selectedTheme].builtin) {
    const input = prompt('Neuer Name für die Kopie:', selectedTheme + ' Custom');
    if (!input) return;
    saveName = input.trim();
    if (!saveName) return;
  }
  try {
    const res = await fetch('/api/themes/' + encodeURIComponent(saveName), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vars: editedVars })
    });
    const data = await res.json();
    if (data.error) { alert(data.error); return; }
    // Aktivieren und neu laden
    await fetch('/api/theme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: saveName })
    });
    location.reload();
  } catch (err) { alert('Fehler: ' + err.message); }
}

async function activateTheme(name) {
  try {
    await fetch('/api/theme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: name })
    });
    location.reload();
  } catch (err) { alert('Fehler: ' + err.message); }
}

async function deleteTheme(name) {
  if (!confirm('Theme "' + name + '" löschen?')) return;
  try {
    await fetch('/api/themes/' + name, { method: 'DELETE' });
    if (selectedTheme === name) selectedTheme = null;
    loadThemes();
  } catch (err) { alert('Fehler: ' + err.message); }
}

function openNewDialog() {
  const select = document.getElementById('newThemeBase');
  select.innerHTML = Object.keys(allThemes).map(n => '<option value="' + n + '">' + n + '</option>').join('');
  document.getElementById('newThemeName').value = '';
  document.getElementById('newDialog').classList.add('show');
}

function closeNewDialog() {
  document.getElementById('newDialog').classList.remove('show');
}

async function createTheme() {
  const name = document.getElementById('newThemeName').value.trim();
  const base = document.getElementById('newThemeBase').value;
  if (!name) { alert('Name erforderlich'); return; }
  try {
    const vars = { ...allThemes[base].vars };
    const res = await fetch('/api/themes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, vars })
    });
    const data = await res.json();
    if (data.error) { alert(data.error); return; }
    closeNewDialog();
    await loadThemes();
    selectTheme(data.name);
  } catch (err) { alert('Fehler: ' + err.message); }
}

loadThemes();
</script>
</body>
</html>`;
}

// --- Tools HTML ---

function getToolsHTML() {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon/favicon.svg">
<link rel="icon" type="image/png" sizes="96x96" href="/favicon/favicon-96x96.png">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="apple-touch-icon" sizes="180x180" href="/favicon/apple-touch-icon.png">
<title>${BOT_NAME} - Tool Manager</title>
${getGoogleFontsLink(getActiveTheme())}
${getThemeCSS()}
<style>
  body { height: 100vh; display: flex; flex-direction: column; }
  .toolbar {
    background: var(--bg-secondary); border-bottom: 1px solid var(--border-color); padding: 8px 16px;
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  }
  .spacer { flex: 1; }
  .save-status { font-size: 12px; color: var(--color-success); }
  .main {
    flex: 1; display: flex; overflow: hidden;
  }
  /* Sidebar */
  .sidebar {
    width: 260px; min-width: 200px; background: var(--bg-primary);
    border-right: 1px solid var(--border-color); overflow-y: auto; display: flex;
    flex-direction: column;
  }
  .sidebar-header {
    padding: 8px 12px; font-size: 11px; color: var(--text-muted); border-bottom: 1px solid var(--bg-tertiary);
    font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
  }
  .tool-item {
    padding: 10px 12px; cursor: pointer; border-bottom: 1px solid var(--bg-tertiary);
    transition: background 0.15s; display: flex; align-items: center; gap: 8px;
  }
  .tool-item:hover { background: var(--bg-secondary); }
  .tool-item.active { background: color-mix(in srgb, var(--accent) 13%, transparent); border-left: 3px solid var(--accent); }
  .tool-item .status-dot {
    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  }
  .tool-item .status-dot.enabled { background: var(--color-success); }
  .tool-item .status-dot.disabled { background: var(--text-dim); }
  .tool-item .tool-info { flex: 1; min-width: 0; }
  .tool-item .tool-name {
    font-size: 12px; font-weight: 600; color: var(--text-bright);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .tool-item .tool-meta {
    font-size: 10px; color: var(--text-muted); margin-top: 3px;
  }
  .sidebar-empty {
    padding: 20px 12px; color: var(--text-dim); text-align: center; font-size: 12px;
  }
  /* Editor */
  .editor-pane {
    flex: 1; display: flex; flex-direction: column; min-width: 0;
    border-right: 1px solid var(--border-color);
  }
  .editor-pane .pane-header {
    background: var(--bg-secondary); padding: 6px 16px; font-size: 11px; color: var(--text-muted);
    border-bottom: 1px solid var(--border-color); display: flex; align-items: center; gap: 8px;
  }
  .editor-pane .pane-header .line-count { margin-left: auto; }
  #editor {
    flex: 1; width: 100%; background: var(--bg-primary); color: var(--text-primary); border: none;
    padding: 12px 16px; font-family: 'Fira Mono', 'Consolas', 'Monaco', monospace; font-size: 13px; line-height: 1.6;
    resize: none; outline: none; tab-size: 2;
  }
  /* Info Panel */
  .info-pane {
    width: 280px; min-width: 220px; background: var(--bg-primary);
    border-left: 0; overflow-y: auto; display: flex; flex-direction: column;
    padding: 16px;
  }
  .info-pane h3 {
    font-size: 11px; color: var(--text-muted); text-transform: uppercase;
    letter-spacing: 0.5px; margin: 0 0 8px 0; font-weight: 600;
  }
  .info-pane .info-section { margin-bottom: 16px; }
  .info-pane .info-row {
    font-size: 12px; color: var(--text-primary); margin: 4px 0;
    display: flex; justify-content: space-between;
  }
  .info-pane .info-row .label { color: var(--text-muted); }
  .def-item {
    background: var(--bg-secondary); border: 1px solid var(--border-color);
    border-radius: 6px; padding: 8px 10px; margin-bottom: 6px;
  }
  .def-item .def-name {
    font-size: 12px; font-weight: 600; color: var(--accent); font-family: 'Fira Mono', monospace;
  }
  .def-item .def-desc {
    font-size: 11px; color: var(--text-muted); margin-top: 3px; line-height: 1.4;
  }
  .btn-toggle {
    width: 100%; padding: 8px; border-radius: 6px; cursor: pointer; font-size: 12px;
    font-weight: 600; border: 1px solid var(--border-color); margin-bottom: 8px;
    background: var(--bg-secondary); color: var(--text-primary); transition: all 0.15s;
  }
  .btn-toggle:hover { border-color: var(--accent); }
  .btn-toggle.enabled { border-color: var(--color-success); color: var(--color-success); }
  .btn-toggle.disabled { border-color: var(--color-error); color: var(--color-error); }
  .btn-delete-tool {
    width: 100%; padding: 8px; border-radius: 6px; cursor: pointer; font-size: 12px;
    font-weight: 600; border: 1px solid var(--color-error); margin-top: 4px;
    background: var(--bg-secondary); color: var(--color-error); transition: all 0.15s;
  }
  .btn-delete-tool:hover { background: color-mix(in srgb, var(--color-error) 13%, transparent); }
  .welcome-msg {
    display: flex; align-items: center; justify-content: center;
    height: 100%; color: var(--text-dim); font-size: 14px; text-align: center;
    padding: 20px; line-height: 1.8;
  }
  @media (max-width: 900px) {
    .main { flex-direction: column; }
    .sidebar { width: 100%; max-height: 200px; border-right: none; border-bottom: 1px solid var(--border-color); }
    .editor-pane { border-right: none; border-bottom: 1px solid var(--border-color); }
    .info-pane { width: 100%; }
  }
</style>
</head>
<body>
<header>
  <h1>Tool Manager</h1>
  <a href="/">Monitor</a>
  <a href="/chat">Chat</a>
  <a href="/system">System</a>
  <a href="/ha-editor">Smart Home Editor</a>
  <a href="/notes">Wissensbasis</a>
  <a href="/reminders">Erinnerungen</a>
  <a href="/terminal">Terminal</a>
  <a href="/settings">Einstellungen</a>
  <a href="/community">Community</a>
  <a href="/delegations">Delegationen</a>
  <a href="/roadmap">Roadmap</a>
  <a href="/tools">Tools</a>
  <a href="/workflows">Workflows</a>
</header>

<div class="toolbar">
  <button class="btn btn-primary" id="newBtn">Neues Tool</button>
  <button class="btn" id="aiBtn" style="background:var(--accent-bg);border-color:var(--accent);color:var(--accent)">Mit KI erstellen</button>
  <label class="btn" style="cursor:pointer"><input type="file" id="uploadZip" accept=".zip" style="display:none" onchange="uploadTool(this)">ZIP importieren</label>
  <span class="spacer"></span>
  <span class="save-status" id="saveStatus"></span>
  <button class="btn btn-primary" id="saveBtn" disabled>Speichern (Ctrl+S)</button>
</div>

<!-- KI Tool Generator Dialog -->
<div id="aiDialog" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:100;align-items:center;justify-content:center">
  <div style="background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:10px;padding:20px;width:90%;max-width:500px">
    <h2 style="margin:0 0 12px;font-size:16px;color:var(--text-bright)">Tool mit KI erstellen</h2>
    <p style="font-size:12px;color:var(--text-muted);margin:0 0 12px">Beschreibe was das Tool können soll. Die KI generiert den kompletten Code.</p>
    <textarea id="aiPrompt" rows="5" style="width:100%;background:var(--bg-primary);border:1px solid var(--border-color);color:var(--text-primary);padding:10px;border-radius:6px;font-family:inherit;font-size:13px;resize:vertical" placeholder="z.B.: Ein Tool das den aktuellen Bitcoin-Kurs abruft und in EUR und USD anzeigt"></textarea>
    <div style="margin-top:8px">
      <input type="text" id="aiFilename" placeholder="Dateiname (z.B. bitcoin.js)" style="width:100%;background:var(--bg-primary);border:1px solid var(--border-color);color:var(--text-primary);padding:8px 10px;border-radius:6px;font-family:inherit;font-size:13px">
    </div>
    <div id="aiStatus" style="font-size:12px;color:var(--text-muted);margin-top:8px;min-height:18px"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
      <button class="btn" onclick="closeAiDialog()">Abbrechen</button>
      <button class="btn btn-primary" id="aiGenerateBtn" onclick="generateWithAI()">Generieren</button>
    </div>
  </div>
</div>

<div class="main">
  <div class="sidebar" id="sidebar">
    <div class="sidebar-header">Tools <span id="toolCount">0</span></div>
    <div id="toolList"></div>
  </div>
  <div class="editor-pane">
    <div class="pane-header">
      <span id="fileName">-</span>
      <span class="line-count" id="lineCount">0 Zeilen</span>
    </div>
    <textarea id="editor" spellcheck="false" placeholder="Tool auswählen oder neues Tool erstellen..."></textarea>
  </div>
  <div class="info-pane" id="infoPane">
    <div class="welcome-msg" id="welcomeMsg">Tool auswählen um Details zu sehen</div>
    <div id="infoContent" style="display:none">
      <div class="info-section">
        <h3>Tool-Definitionen</h3>
        <div id="defList"></div>
      </div>
      <div class="info-section">
        <h3>Datei-Info</h3>
        <div class="info-row"><span class="label">Größe</span><span id="infoSize">-</span></div>
        <div class="info-row"><span class="label">Geändert</span><span id="infoModified">-</span></div>
      </div>
      <div class="info-section">
        <h3>Sichtbarkeit</h3>
        <div style="display:flex;gap:6px;margin-bottom:8px">
          <button class="btn-toggle" id="visPrivate" onclick="setVisibility('private')" style="font-size:11px">Privat</button>
          <button class="btn-toggle" id="visPublic" onclick="setVisibility('public')" style="font-size:11px">Öffentlich</button>
        </div>
        <div style="font-size:10px;color:var(--text-dim)" id="visHint">Privat = nur lokal, Öffentlich = wird mit Git geteilt</div>
      </div>
      <div class="info-section">
        <h3>Aktionen</h3>
        <button class="btn-toggle" id="toggleBtn">-</button>
        <button class="btn-toggle" id="downloadBtn" onclick="downloadTool()" style="margin-top:4px">Als ZIP herunterladen</button>
        <button class="btn-delete-tool" id="deleteBtn">Tool löschen</button>
      </div>
    </div>
  </div>
</div>

<script>
const editorEl = document.getElementById('editor');
const saveBtn = document.getElementById('saveBtn');
const newBtn = document.getElementById('newBtn');
const saveStatus = document.getElementById('saveStatus');
const fileNameEl = document.getElementById('fileName');
const lineCountEl = document.getElementById('lineCount');
const toolListEl = document.getElementById('toolList');
const toolCountEl = document.getElementById('toolCount');
const infoPane = document.getElementById('infoPane');
const infoContent = document.getElementById('infoContent');
const welcomeMsg = document.getElementById('welcomeMsg');
const defList = document.getElementById('defList');
const toggleBtn = document.getElementById('toggleBtn');
const deleteBtn = document.getElementById('deleteBtn');

let currentFile = null;
let currentToolData = null;
let originalContent = '';
let dirty = false;
let allTools = [];

function showStatus(msg, color) {
  saveStatus.textContent = msg;
  saveStatus.style.color = color || 'var(--color-success)';
  setTimeout(() => { saveStatus.textContent = ''; }, 3000);
}

function setDirty(d) {
  dirty = d;
  saveBtn.disabled = !d;
  if (d) {
    fileNameEl.textContent = currentFile ? currentFile + ' *' : '-';
  } else {
    fileNameEl.textContent = currentFile || '-';
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function loadTools() {
  try {
    const res = await fetch('/api/tools');
    allTools = await res.json();
    renderToolList();
  } catch (e) {
    showStatus('Fehler beim Laden: ' + e.message, 'var(--color-error)');
  }
}

function renderToolList() {
  toolCountEl.textContent = allTools.length;
  if (!allTools.length) {
    toolListEl.innerHTML = '<div class="sidebar-empty">Keine Tools gefunden</div>';
    return;
  }
  toolListEl.innerHTML = allTools.map(t => {
    const active = currentFile === t.filename ? ' active' : '';
    const dotClass = t.enabled ? 'enabled' : 'disabled';
    const subCount = t.definitions ? t.definitions.length : 0;
    const errorHint = t.error ? ' (Fehler)' : '';
    return '<div class="tool-item' + active + '" data-file="' + t.filename + '">'
      + '<div class="status-dot ' + dotClass + '"></div>'
      + '<div class="tool-info">'
      + '<div class="tool-name">' + t.filename + '</div>'
      + '<div class="tool-meta">' + subCount + ' Sub-Tools' + errorHint + '</div>'
      + '</div></div>';
  }).join('');

  toolListEl.querySelectorAll('.tool-item').forEach(el => {
    el.addEventListener('click', () => selectTool(el.dataset.file));
  });
}

async function selectTool(filename) {
  if (dirty && !confirm('Ungespeicherte Änderungen verwerfen?')) return;
  try {
    const res = await fetch('/api/tools/' + encodeURIComponent(filename));
    const data = await res.json();
    currentFile = filename;
    currentToolData = allTools.find(t => t.filename === filename);
    editorEl.value = data.content;
    originalContent = data.content;
    setDirty(false);
    updateLineCount();
    updateInfoPanel();
    renderToolList();
  } catch (e) {
    showStatus('Fehler: ' + e.message, 'var(--color-error)');
  }
}

function updateLineCount() {
  const lines = editorEl.value.split('\\n').length;
  lineCountEl.textContent = lines + ' Zeilen';
}

function updateInfoPanel() {
  if (!currentFile || !currentToolData) {
    welcomeMsg.style.display = '';
    infoContent.style.display = 'none';
    return;
  }
  welcomeMsg.style.display = 'none';
  infoContent.style.display = '';

  // Definitions
  if (currentToolData.definitions && currentToolData.definitions.length) {
    defList.innerHTML = currentToolData.definitions.map(d =>
      '<div class="def-item"><div class="def-name">' + d.name + '</div>'
      + '<div class="def-desc">' + (d.description || '-') + '</div></div>'
    ).join('');
  } else if (currentToolData.error) {
    defList.innerHTML = '<div class="def-item"><div class="def-name" style="color:var(--color-error)">Fehler</div>'
      + '<div class="def-desc">' + currentToolData.error + '</div></div>';
  } else {
    defList.innerHTML = '<div class="sidebar-empty">Keine Definitionen</div>';
  }

  // File info
  document.getElementById('infoSize').textContent = formatSize(currentToolData.size);
  document.getElementById('infoModified').textContent = new Date(currentToolData.modified).toLocaleString('de-DE');

  // Toggle button
  toggleBtn.textContent = currentToolData.enabled ? 'Deaktivieren' : 'Aktivieren';
  toggleBtn.className = 'btn-toggle ' + (currentToolData.enabled ? 'enabled' : 'disabled');

  // Visibility
  const vis = currentToolData.visibility || 'private';
  document.getElementById('visPrivate').className = 'btn-toggle ' + (vis === 'private' ? 'enabled' : '');
  document.getElementById('visPublic').className = 'btn-toggle ' + (vis === 'public' ? 'enabled' : '');
}

async function saveTool() {
  if (!currentFile) return;
  try {
    const res = await fetch('/api/tools/' + encodeURIComponent(currentFile), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: editorEl.value }),
    });
    const data = await res.json();
    if (data.ok) {
      originalContent = editorEl.value;
      setDirty(false);
      showStatus('Gespeichert', 'var(--color-success)');
      loadTools();
    } else {
      showStatus('Fehler: ' + (data.error || 'Unbekannt'), 'var(--color-error)');
    }
  } catch (e) {
    showStatus('Fehler: ' + e.message, 'var(--color-error)');
  }
}

async function createTool() {
  const filename = prompt('Dateiname für neues Tool (z.B. mein_tool.js):');
  if (!filename) return;
  try {
    const res = await fetch('/api/tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename }),
    });
    const data = await res.json();
    if (data.ok) {
      showStatus('Tool erstellt: ' + data.filename, 'var(--color-success)');
      await loadTools();
      selectTool(data.filename);
    } else {
      showStatus('Fehler: ' + (data.error || 'Unbekannt'), 'var(--color-error)');
    }
  } catch (e) {
    showStatus('Fehler: ' + e.message, 'var(--color-error)');
  }
}

async function toggleTool() {
  if (!currentFile) return;
  try {
    const res = await fetch('/api/tools/' + encodeURIComponent(currentFile) + '/toggle', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      showStatus(data.enabled ? 'Aktiviert' : 'Deaktiviert', 'var(--color-success)');
      await loadTools();
      currentToolData = allTools.find(t => t.filename === currentFile);
      updateInfoPanel();
    }
  } catch (e) {
    showStatus('Fehler: ' + e.message, 'var(--color-error)');
  }
}

async function deleteTool() {
  if (!currentFile) return;
  if (!confirm('Tool "' + currentFile + '" wirklich löschen?')) return;
  try {
    const res = await fetch('/api/tools/' + encodeURIComponent(currentFile), { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) {
      showStatus('Gelöscht', 'var(--color-success)');
      currentFile = null;
      currentToolData = null;
      editorEl.value = '';
      setDirty(false);
      welcomeMsg.style.display = '';
      infoContent.style.display = 'none';
      loadTools();
    }
  } catch (e) {
    showStatus('Fehler: ' + e.message, 'var(--color-error)');
  }
}

// Event listeners
editorEl.addEventListener('input', () => {
  setDirty(editorEl.value !== originalContent);
  updateLineCount();
});

saveBtn.addEventListener('click', saveTool);
newBtn.addEventListener('click', createTool);
document.getElementById('aiBtn').addEventListener('click', () => {
  document.getElementById('aiDialog').style.display = 'flex';
  document.getElementById('aiPrompt').focus();
});
toggleBtn.addEventListener('click', toggleTool);
deleteBtn.addEventListener('click', deleteTool);

async function setVisibility(vis) {
  if (!currentFile) return;
  try {
    const res = await fetch('/api/tools/' + encodeURIComponent(currentFile) + '/visibility', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: vis }),
    });
    const data = await res.json();
    if (data.ok) {
      showStatus(vis === 'public' ? 'Öffentlich — wird mit Git geteilt' : 'Privat — nur lokal', 'var(--color-success)');
      currentToolData.visibility = vis;
      updateInfoPanel();
    }
  } catch (e) { showStatus('Fehler: ' + e.message, 'var(--color-error)'); }
}

function downloadTool() {
  if (!currentFile) return;
  window.location.href = '/api/tools/' + encodeURIComponent(currentFile) + '/download';
}

async function uploadTool(input) {
  const file = input.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch('/api/tools/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.ok) {
      showStatus('Tool importiert: ' + data.filename, 'var(--color-success)');
      await loadTools();
      selectTool(data.filename);
    } else {
      showStatus('Fehler: ' + (data.error || 'Unbekannt'), 'var(--color-error)');
    }
  } catch (e) { showStatus('Fehler: ' + e.message, 'var(--color-error)'); }
  input.value = '';
}

function closeAiDialog() {
  document.getElementById('aiDialog').style.display = 'none';
  document.getElementById('aiPrompt').value = '';
  document.getElementById('aiFilename').value = '';
  document.getElementById('aiStatus').textContent = '';
}

async function generateWithAI() {
  const description = document.getElementById('aiPrompt').value.trim();
  let filename = document.getElementById('aiFilename').value.trim();
  if (!description) return;
  if (!filename) {
    // Dateiname aus Beschreibung ableiten
    filename = description.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 30) + '.js';
  }
  if (!filename.endsWith('.js')) filename += '.js';

  const status = document.getElementById('aiStatus');
  const btn = document.getElementById('aiGenerateBtn');
  status.textContent = 'KI generiert Tool-Code... (kann etwas dauern)';
  status.style.color = 'var(--color-warning)';
  btn.disabled = true;

  try {
    const res = await fetch('/api/tools/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description, filename }),
    });
    const data = await res.json();
    if (data.error) {
      status.textContent = 'Fehler: ' + data.error;
      status.style.color = 'var(--color-error)';
      btn.disabled = false;
      return;
    }
    // Code im Editor anzeigen
    closeAiDialog();
    currentFile = data.filename;
    editorEl.value = data.code;
    originalContent = '';
    setDirty(true);
    updateLineCount();
    fileNameEl.textContent = data.filename;
    welcomeMsg.style.display = 'none';
    infoContent.style.display = 'none';
    showStatus('KI-Tool generiert — bitte prüfen und speichern', 'var(--color-success)');
  } catch (e) {
    status.textContent = 'Fehler: ' + e.message;
    status.style.color = 'var(--color-error)';
  }
  btn.disabled = false;
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (!saveBtn.disabled) saveTool();
  }
});

// Tab key support in editor
editorEl.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = editorEl.selectionStart;
    const end = editorEl.selectionEnd;
    editorEl.value = editorEl.value.substring(0, start) + '  ' + editorEl.value.substring(end);
    editorEl.selectionStart = editorEl.selectionEnd = start + 2;
    setDirty(editorEl.value !== originalContent);
  }
});

loadTools();
</script>
</body>
</html>`;
}

// --- Workflows HTML ---

function getWorkflowsHTML() {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon/favicon.svg">
<link rel="icon" type="image/png" sizes="96x96" href="/favicon/favicon-96x96.png">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="apple-touch-icon" sizes="180x180" href="/favicon/apple-touch-icon.png">
<title>${BOT_NAME} - Workflows</title>
${getGoogleFontsLink(getActiveTheme())}
${getThemeCSS()}
<style>
  .container { max-width: 900px; margin: 20px auto; padding: 0 16px; }

  .toolbar {
    display: flex; gap: 8px; align-items: center; margin-bottom: 16px; flex-wrap: wrap;
  }
  .filter-btn { padding: 4px 12px; font-size: 11px; }
  .filter-btn.active { background: color-mix(in srgb, var(--accent) 13%, transparent); border-color: var(--accent); color: var(--accent); }
  .spacer { flex: 1; }

  /* Workflow Cards */
  .wf-list { display: flex; flex-direction: column; gap: 12px; }
  .wf-card {
    background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px;
    border-left: 3px solid var(--border-color); overflow: hidden;
  }
  .wf-card.status-running { border-left-color: var(--color-warning); }
  .wf-card.status-completed { border-left-color: var(--color-success); }
  .wf-card.status-failed { border-left-color: var(--color-error); }
  .wf-card.status-cancelled { border-left-color: var(--text-muted); }
  .wf-card.status-paused { border-left-color: var(--accent); }

  .wf-header {
    padding: 12px 16px; display: flex; align-items: center; gap: 12px;
    cursor: pointer; user-select: none;
  }
  .wf-header:hover { background: var(--bg-tertiary); }
  .wf-toggle { color: var(--text-dim); font-size: 10px; transition: transform 0.2s; }
  .wf-toggle.open { transform: rotate(90deg); }
  .wf-name { font-size: 14px; font-weight: 600; color: var(--text-bright); flex: 1; }
  .wf-badge {
    font-size: 10px; padding: 2px 8px; border-radius: 10px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.3px;
  }
  .wf-badge-running { background: color-mix(in srgb, var(--color-warning) 13%, transparent); color: var(--color-warning); }
  .wf-badge-completed { background: color-mix(in srgb, var(--color-success) 13%, transparent); color: var(--color-success); }
  .wf-badge-failed { background: color-mix(in srgb, var(--color-error) 13%, transparent); color: var(--color-error); }
  .wf-badge-cancelled { background: color-mix(in srgb, var(--text-muted) 13%, transparent); color: var(--text-muted); }
  .wf-badge-paused { background: color-mix(in srgb, var(--accent) 13%, transparent); color: var(--accent); }
  .wf-progress { font-size: 11px; color: var(--text-muted); }
  .wf-date { font-size: 10px; color: var(--text-dim); }
  .wf-actions button {
    background: none; border: 1px solid var(--border-color); color: var(--text-muted);
    padding: 3px 8px; border-radius: 4px; cursor: pointer; font-size: 11px;
    font-family: inherit; transition: all 0.15s;
  }
  .wf-actions button:hover { border-color: var(--accent); color: var(--text-primary); }
  .wf-actions .del-btn:hover { border-color: var(--color-error); color: var(--color-error); }

  /* Progress Bar */
  .progress-bar {
    height: 4px; background: var(--bg-tertiary); border-radius: 2px; overflow: hidden;
    width: 80px; flex-shrink: 0;
  }
  .progress-fill {
    height: 100%; border-radius: 2px; transition: width 0.3s;
  }
  .progress-fill.running { background: var(--color-warning); }
  .progress-fill.completed { background: var(--color-success); }
  .progress-fill.failed { background: var(--color-error); }

  /* Steps Detail */
  .wf-detail {
    display: none; border-top: 1px solid var(--bg-tertiary); padding: 12px 16px;
    background: var(--bg-primary)66;
  }
  .wf-detail.open { display: block; }
  .step {
    display: flex; gap: 10px; align-items: flex-start; padding: 6px 0;
    border-bottom: 1px solid var(--bg-tertiary); font-size: 12px;
  }
  .step:last-child { border-bottom: none; }
  .step-icon { width: 20px; text-align: center; flex-shrink: 0; }
  .step-num { color: var(--text-dim); min-width: 30px; flex-shrink: 0; }
  .step-action { flex: 1; color: var(--text-primary); word-break: break-word; }
  .step-status { color: var(--text-muted); font-size: 11px; min-width: 70px; text-align: right; flex-shrink: 0; }
  .step-meta { font-size: 10px; color: var(--text-dim); margin-top: 2px; }
  .step-result {
    background: var(--bg-secondary); border: 1px solid var(--bg-tertiary); border-radius: 4px;
    padding: 6px 8px; margin-top: 4px; font-size: 11px; color: var(--text-muted);
    max-height: 100px; overflow-y: auto; word-break: break-word;
  }

  .wf-context {
    margin-top: 8px; padding: 8px; background: var(--bg-secondary); border: 1px solid var(--bg-tertiary);
    border-radius: 4px; font-size: 11px; color: var(--text-muted);
  }
  .wf-context-label { color: var(--accent); font-weight: 600; margin-bottom: 4px; }

  .empty-state { text-align: center; padding: 40px; color: var(--text-dim); font-size: 14px; }

  @media (max-width: 600px) {
    .wf-header { flex-wrap: wrap; }
    .progress-bar { width: 60px; }
  }
</style>
</head>
<body>
<header>
  <h1>Workflows</h1>
  <a href="/">Monitor</a>
  <a href="/chat">Chat</a>
  <a href="/system">System</a>
  <a href="/ha-editor">Smart Home Editor</a>
  <a href="/notes">Wissensbasis</a>
  <a href="/reminders">Erinnerungen</a>
  <a href="/terminal">Terminal</a>
  <a href="/roadmap">Roadmap</a>
  <a href="/settings">Einstellungen</a>
</header>

<div class="container">
  <div class="toolbar">
    <button class="btn filter-btn active" data-filter="all" onclick="setFilter('all')">Alle</button>
    <button class="btn filter-btn" data-filter="running" onclick="setFilter('running')">Laufend</button>
    <button class="btn filter-btn" data-filter="completed" onclick="setFilter('completed')">Abgeschlossen</button>
    <button class="btn filter-btn" data-filter="failed" onclick="setFilter('failed')">Fehlgeschlagen</button>
    <div class="spacer"></div>
    <span class="status-msg" id="statusMsg"></span>
  </div>

  <div class="wf-list" id="wfList">
    <div class="empty-state">Laden...</div>
  </div>
</div>

<script>
const statusLabels = { running: 'Laufend', completed: 'Abgeschlossen', failed: 'Fehlgeschlagen', cancelled: 'Abgebrochen', paused: 'Pausiert' };
const stepIcons = { pending: '\\u23f3', running: '\\ud83d\\udd04', completed: '\\u2705', failed: '\\u274c', skipped: '\\u23ed\\ufe0f' };
let allWorkflows = [];
let currentFilter = 'all';
let openCards = new Set();

function escapeHtml(s) {
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
}

function showStatus(msg, isError) {
  const el = document.getElementById('statusMsg');
  el.textContent = msg;
  el.className = 'status-msg show' + (isError ? ' error' : '');
  setTimeout(() => el.classList.remove('show'), 3000);
}

function setFilter(f) {
  currentFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === f));
  renderList();
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function toggleCard(id) {
  if (openCards.has(id)) openCards.delete(id); else openCards.add(id);
  renderList();
}

function renderList() {
  const list = document.getElementById('wfList');
  let filtered = allWorkflows;
  if (currentFilter !== 'all') filtered = allWorkflows.filter(w => w.status === currentFilter);

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state">' +
      (currentFilter === 'all' ? 'Keine Workflows vorhanden. Erstelle einen per Chat oder Telegram.' :
       'Keine Workflows mit Status "' + (statusLabels[currentFilter] || currentFilter) + '"') +
      '</div>';
    return;
  }

  list.innerHTML = filtered.map(w => {
    const steps = w.steps || [];
    const done = steps.filter(s => s.status === 'completed' || s.status === 'skipped').length;
    const total = steps.length;
    const pct = total > 0 ? Math.round(done / total * 100) : 0;
    const isOpen = openCards.has(w.id);
    const barClass = w.status === 'failed' ? 'failed' : w.status === 'completed' ? 'completed' : 'running';

    let ctx = {};
    try { ctx = JSON.parse(w.context || '{}'); } catch {}
    const ctxKeys = Object.keys(ctx);

    return '<div class="wf-card status-' + w.status + '">' +
      '<div class="wf-header" onclick="toggleCard(\\'' + w.id + '\\')">' +
        '<span class="wf-toggle ' + (isOpen ? 'open' : '') + '">\\u25b6</span>' +
        '<span class="wf-name">' + escapeHtml(w.name) + '</span>' +
        '<span class="wf-badge wf-badge-' + w.status + '">' + (statusLabels[w.status] || w.status) + '</span>' +
        '<div class="progress-bar"><div class="progress-fill ' + barClass + '" style="width:' + pct + '%"></div></div>' +
        '<span class="wf-progress">' + done + '/' + total + '</span>' +
        '<span class="wf-date">' + formatDate(w.created) + '</span>' +
        '<div class="wf-actions">' +
          (w.status === 'running' ? '<button onclick="event.stopPropagation();cancelWf(\\'' + w.id + '\\')">Stopp</button>' : '') +
          '<button class="del-btn" onclick="event.stopPropagation();deleteWf(\\'' + w.id + '\\')">Del</button>' +
        '</div>' +
      '</div>' +
      '<div class="wf-detail ' + (isOpen ? 'open' : '') + '">' +
        steps.map(s => {
          let resultText = '';
          if (s.result) {
            try {
              const r = JSON.parse(s.result);
              resultText = r.text || r.error || '';
            } catch { resultText = s.result; }
          }
          return '<div class="step">' +
            '<span class="step-icon">' + (stepIcons[s.status] || '?') + '</span>' +
            '<span class="step-num">#' + s.step_num + '</span>' +
            '<div class="step-action">' + escapeHtml(s.action) +
              (s.delay_minutes ? '<div class="step-meta">Verzögerung: ' + s.delay_minutes + ' Min</div>' : '') +
              (s.condition ? '<div class="step-meta">Bedingung: ' + escapeHtml(s.condition) + '</div>' : '') +
              (resultText ? '<div class="step-result">' + escapeHtml(resultText.substring(0, 500)) + '</div>' : '') +
            '</div>' +
            '<span class="step-status">' + (s.status === 'completed' ? formatDate(s.completed_at) : s.status) + '</span>' +
          '</div>';
        }).join('') +
        (ctxKeys.length > 0 ? '<div class="wf-context"><div class="wf-context-label">Context:</div>' + escapeHtml(JSON.stringify(ctx, null, 2)) + '</div>' : '') +
        (w.error ? '<div class="wf-context" style="border-color:color-mix(in srgb, var(--color-error) 27%, transparent)"><div class="wf-context-label" style="color:var(--color-error)">Fehler:</div>' + escapeHtml(w.error) + '</div>' : '') +
      '</div>' +
    '</div>';
  }).join('');
}

async function loadWorkflows() {
  try {
    const res = await fetch('/api/workflows');
    allWorkflows = await res.json();
    renderList();
  } catch (err) { showStatus('Fehler: ' + err.message, true); }
}

async function cancelWf(id) {
  if (!confirm('Workflow abbrechen?')) return;
  try {
    await fetch('/api/workflows/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' }) });
    showStatus('Abgebrochen', false);
    loadWorkflows();
  } catch (err) { showStatus('Fehler: ' + err.message, true); }
}

async function deleteWf(id) {
  if (!confirm('Workflow löschen?')) return;
  try {
    await fetch('/api/workflows/' + id, { method: 'DELETE' });
    showStatus('Gelöscht', false);
    loadWorkflows();
  } catch (err) { showStatus('Fehler: ' + err.message, true); }
}

loadWorkflows();
setInterval(loadWorkflows, 30000);
</script>
</body>
</html>`;
}

// --- Community Chat HTML ---

function getCommunityHTML() {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon/favicon.svg">
<title>${BOT_NAME} - Community Chat</title>
${getGoogleFontsLink(getActiveTheme())}
${getThemeCSS()}
<style>
  body { height: 100vh; display: flex; flex-direction: column; }
  .chat-container { flex: 1; display: flex; overflow: hidden; }
  .chat-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .chat-messages {
    flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px;
  }
  .msg {
    max-width: 85%; padding: 8px 12px; border-radius: 10px; font-size: 13px; line-height: 1.5;
    position: relative;
  }
  .msg.user { background: var(--accent-bg); border: 1px solid var(--accent); align-self: flex-start; }
  .msg.assistant { background: rgba(140,120,255,0.1); border: 1px solid rgba(140,120,255,0.3); align-self: flex-start; }
  .msg.self { align-self: flex-end; background: var(--bg-tertiary); border: 1px solid var(--border-color); }
  .msg-header { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .msg-icon { font-size: 14px; }
  .msg-name { font-size: 11px; font-weight: 600; color: var(--accent); }
  .msg.assistant .msg-name { color: #a78bfa; }
  .msg-time { font-size: 10px; color: var(--text-dim); margin-left: auto; }
  .msg-text { color: var(--text-primary); word-break: break-word; }
  .chat-input-bar {
    display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border-color);
    background: var(--bg-secondary);
  }
  .chat-input-bar input {
    flex: 1; background: var(--bg-primary); border: 1px solid var(--border-color); color: var(--text-primary);
    padding: 10px 14px; border-radius: 8px; font-family: inherit; font-size: 13px; outline: none;
  }
  .chat-input-bar input:focus { border-color: var(--accent); }
  .chat-input-bar button {
    background: var(--btn-primary-bg); color: #fff; border: 1px solid var(--btn-primary-hover);
    padding: 10px 20px; border-radius: 8px; cursor: pointer; font-family: inherit; font-size: 13px;
  }
  .chat-input-bar button:hover { background: var(--btn-primary-hover); }
  .chat-input-bar button:disabled { opacity: 0.5; cursor: not-allowed; }
  .chat-sidebar {
    width: 200px; border-left: 1px solid var(--border-color); padding: 12px;
    overflow-y: auto; background: var(--bg-secondary);
  }
  .sidebar-title { font-size: 11px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 8px; font-weight: 600; }
  .online-user { display: flex; align-items: center; gap: 6px; padding: 4px 0; font-size: 12px; color: var(--text-primary); }
  .online-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--color-success); flex-shrink: 0; }
  .online-type { font-size: 10px; color: var(--text-dim); }
  .setup-msg {
    flex: 1; display: flex; align-items: center; justify-content: center; text-align: center;
    color: var(--text-muted); padding: 40px; font-size: 14px; line-height: 1.8;
  }
  .register-box {
    background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 10px;
    padding: 20px; max-width: 400px; width: 90%;
  }
  .register-box h3 { margin: 0 0 12px; color: var(--text-bright); font-size: 16px; }
  .register-box input, .register-box select {
    width: 100%; background: var(--bg-primary); border: 1px solid var(--border-color); color: var(--text-primary);
    padding: 8px 12px; border-radius: 6px; font-family: inherit; font-size: 13px; margin-bottom: 8px; outline: none;
  }
  .register-box button {
    background: var(--btn-primary-bg); color: #fff; border: none; padding: 8px 20px;
    border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 13px; width: 100%;
  }
  .register-status { font-size: 12px; margin-top: 8px; min-height: 18px; }
  @media (max-width: 768px) { .chat-sidebar { display: none; } }
</style>
</head>
<body>
<header>
  <h1>${BOT_NAME} Community</h1>
  <a href="/">Monitor</a>
  <a href="/chat">Chat</a>
  <a href="/system">System</a>
  <a href="/notes">Wissensbasis</a>
  <a href="/settings">Einstellungen</a>
  <a href="/delegations">Delegationen</a>
  <a href="/terminal">Terminal</a>
</header>

<div class="chat-container">
  <div class="chat-main" id="chatMain"></div>
  <div class="chat-sidebar" id="chatSidebar">
    <div class="sidebar-title">Online</div>
    <div id="onlineList"></div>
  </div>
</div>

<script>
const API_BASE = 'https://kiasy.de/api/kiasyApi.php';
const POLL_INTERVAL = 5000;
let lastMsgId = 0;
let myUsername = '';
let myApiKey = '';
let pollTimer = null;

function escapeHtml(s) {
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
}

function init() {
  // Settings laden
  fetch('/api/settings').then(r => r.json()).then(settings => {
    const userEnabled = settings.COMMUNITY_USER_ENABLED === 'true';
    const assistantEnabled = settings.COMMUNITY_ASSISTANT_ENABLED === 'true';
    const userName = settings.COMMUNITY_USER_NAME || '';
    const userKey = settings.COMMUNITY_USER_APIKEY || '';
    const assistantName = settings.COMMUNITY_ASSISTANT_NAME || '';
    const assistantKey = settings.COMMUNITY_ASSISTANT_APIKEY || '';

    if (userEnabled && userName && userKey) {
      myUsername = userName;
      myApiKey = userKey;
      showChat();
    } else if (assistantEnabled && assistantName && assistantKey) {
      myUsername = assistantName;
      myApiKey = assistantKey;
      showChat();
    } else {
      showSetup(settings);
    }
  }).catch(() => showSetup({}));
}

function showSetup(settings) {
  const main = document.getElementById('chatMain');
  main.innerHTML = '<div class="setup-msg"><div class="register-box">' +
    '<h3>Community Chat einrichten</h3>' +
    '<p style="font-size:12px;color:var(--text-muted);margin:0 0 12px">Registriere einen Chat-Namen um teilzunehmen.</p>' +
    '<input type="text" id="regUsername" placeholder="Chat-Name (z.B. Michael oder JARVIS)">' +
    '<select id="regType"><option value="user">User</option><option value="assistant">Assistent</option></select>' +
    '<button onclick="registerName()">Registrieren & prüfen</button>' +
    '<div class="register-status" id="regStatus"></div>' +
    '</div></div>';
}

async function registerName() {
  const username = document.getElementById('regUsername').value.trim();
  const type = document.getElementById('regType').value;
  const status = document.getElementById('regStatus');
  if (!username) return;

  status.textContent = 'Prüfe...';
  status.style.color = 'var(--color-warning)';

  try {
    // Erst prüfen
    const check = await fetch(API_BASE + '?action=check&username=' + encodeURIComponent(username));
    const checkData = await check.json();

    if (!checkData.available) {
      status.textContent = 'Name "' + username + '" ist bereits vergeben!';
      status.style.color = 'var(--color-error)';
      return;
    }

    // Registrieren
    const botName = '${BOT_NAME}';
    const ownerName = '${process.env.OWNER_NAME || ""}';
    const reg = await fetch(API_BASE + '?action=register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, type, bot_name: botName, owner_name: ownerName }),
    });
    const regData = await reg.json();

    if (regData.ok) {
      // In Settings speichern
      const key = type === 'user' ? 'COMMUNITY_USER' : 'COMMUNITY_ASSISTANT';
      const settings = {};
      settings[key + '_ENABLED'] = 'true';
      settings[key + '_NAME'] = username;
      settings[key + '_APIKEY'] = regData.api_key;

      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });

      status.textContent = 'Registriert! Lade Chat...';
      status.style.color = 'var(--color-success)';

      myUsername = username;
      myApiKey = regData.api_key;
      setTimeout(() => showChat(), 1000);
    } else {
      status.textContent = regData.error || 'Fehler bei der Registrierung';
      status.style.color = 'var(--color-error)';
    }
  } catch (e) {
    status.textContent = 'Verbindungsfehler: ' + e.message;
    status.style.color = 'var(--color-error)';
  }
}

function showChat() {
  const main = document.getElementById('chatMain');
  main.innerHTML = '<div class="chat-messages" id="messages"></div>' +
    '<div class="chat-input-bar">' +
    '<input type="text" id="msgInput" placeholder="Nachricht schreiben..." onkeydown="if(event.key===\\'Enter\\')sendMsg()">' +
    '<button onclick="sendMsg()" id="sendBtn">Senden</button>' +
    '</div>';
  loadMessages();
  pollTimer = setInterval(loadMessages, POLL_INTERVAL);
}

async function loadMessages() {
  try {
    const res = await fetch(API_BASE + '?action=messages&since=' + lastMsgId, {
      headers: { 'X-API-Key': myApiKey },
    });
    const data = await res.json();

    if (data.messages && data.messages.length > 0) {
      const container = document.getElementById('messages');
      for (const msg of data.messages) {
        const isSelf = msg.username === myUsername;
        const isAssistant = msg.type === 'assistant';
        const icon = isAssistant ? '🤖' : '👤';
        const cls = isSelf ? 'self' : (isAssistant ? 'assistant' : 'user');
        const time = msg.created_at ? msg.created_at.substring(11, 16) : '';
        const displayName = isAssistant ? msg.username + ' (' + (msg.bot_name || '?') + ')' : msg.username;

        const el = document.createElement('div');
        el.className = 'msg ' + cls;
        el.innerHTML = '<div class="msg-header">' +
          '<span class="msg-icon">' + icon + '</span>' +
          '<span class="msg-name">' + escapeHtml(displayName) + '</span>' +
          '<span class="msg-time">' + time + '</span>' +
          '</div>' +
          '<div class="msg-text">' + escapeHtml(msg.message) + '</div>';
        container.appendChild(el);
        lastMsgId = msg.id;
      }
      container.scrollTop = container.scrollHeight;
    }

    // Online-Liste
    if (data.online) {
      const list = document.getElementById('onlineList');
      list.innerHTML = data.online.map(u => {
        const icon = u.type === 'assistant' ? '🤖' : '👤';
        return '<div class="online-user"><span class="online-dot"></span>' +
          icon + ' ' + escapeHtml(u.username) +
          '</div>';
      }).join('');
    }
  } catch (e) {
    console.error('Community-Fehler:', e);
  }
}

async function sendMsg() {
  const input = document.getElementById('msgInput');
  const message = input.value.trim();
  if (!message) return;
  input.value = '';

  try {
    await fetch(API_BASE + '?action=send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': myApiKey },
      body: JSON.stringify({ message }),
    });
    await loadMessages();
  } catch (e) {
    console.error('Sende-Fehler:', e);
  }
}

init();
</script>
</body>
</html>`;
}

// --- Delegations HTML ---

function getDelegationsHTML() {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon/favicon.svg">
<link rel="icon" type="image/png" sizes="96x96" href="/favicon/favicon-96x96.png">
<link rel="shortcut icon" href="/favicon.ico">
<title>${BOT_NAME} - Delegationen</title>
${getGoogleFontsLink(getActiveTheme())}
${getThemeCSS()}
<style>
  .content { max-width: 1000px; margin: 20px auto; padding: 0 16px; }
  .stats { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  .stat-card {
    background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px;
    padding: 12px 18px; text-align: center; min-width: 100px;
  }
  .stat-card .num { font-size: 24px; font-weight: 700; color: var(--text-bright); }
  .stat-card .label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; margin-top: 2px; }
  .filter-bar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .filter-btn {
    background: var(--bg-secondary); border: 1px solid var(--border-color); color: var(--text-muted);
    padding: 5px 14px; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 12px;
  }
  .filter-btn:hover { border-color: var(--accent); color: var(--text-primary); }
  .filter-btn.active { background: var(--accent-bg); border-color: var(--accent); color: var(--accent); }
  .delegation {
    background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px;
    margin-bottom: 12px; overflow: hidden;
  }
  .delegation.done { opacity: 0.6; }
  .delegation.cancelled { opacity: 0.4; }
  .del-header {
    display: flex; align-items: center; gap: 10px; padding: 12px 16px;
    border-bottom: 1px solid var(--bg-tertiary); cursor: pointer;
  }
  .del-header:hover { background: var(--bg-tertiary); }
  .del-status { font-size: 18px; }
  .del-info { flex: 1; }
  .del-assignee { font-size: 14px; font-weight: 600; color: var(--text-bright); }
  .del-subject { font-size: 12px; color: var(--text-muted); }
  .del-meta { font-size: 11px; color: var(--text-dim); text-align: right; }
  .del-progress { font-size: 12px; color: var(--color-success); }
  .del-body { padding: 0 16px 12px; }
  .task-row {
    display: flex; align-items: center; gap: 8px; padding: 6px 0;
    border-bottom: 1px solid var(--bg-tertiary);
  }
  .task-row:last-child { border-bottom: none; }
  .task-check {
    width: 22px; height: 22px; border: 2px solid var(--border-color); border-radius: 4px;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    font-size: 14px; transition: all 0.15s; flex-shrink: 0;
  }
  .task-check:hover { border-color: var(--color-success); }
  .task-check.done { background: var(--color-success); border-color: var(--color-success); color: #fff; }
  .task-check.in_progress { background: var(--color-warning); border-color: var(--color-warning); color: #fff; }
  .task-text { flex: 1; font-size: 13px; color: var(--text-primary); }
  .task-text.done { text-decoration: line-through; color: var(--text-dim); }
  .task-date { font-size: 10px; color: var(--text-dim); }
  .del-actions { display: flex; gap: 6px; padding: 8px 16px; border-top: 1px solid var(--bg-tertiary); }
  .del-actions button {
    font-size: 11px; padding: 4px 10px; border-radius: 4px; cursor: pointer;
    border: 1px solid var(--border-color); background: var(--bg-tertiary);
    color: var(--text-muted); font-family: inherit;
  }
  .del-actions button:hover { border-color: var(--accent); color: var(--accent); }
  .del-actions .cancel-btn:hover { border-color: var(--color-error); color: var(--color-error); }
  .empty { text-align: center; padding: 40px; color: var(--text-dim); font-size: 14px; }
</style>
</head>
<body>
<header>
  <h1>${BOT_NAME} Delegationen</h1>
  <a href="/">Monitor</a>
  <a href="/chat">Chat</a>
  <a href="/system">System</a>
  <a href="/notes">Wissensbasis</a>
  <a href="/reminders">Erinnerungen</a>
  <a href="/terminal">Terminal</a>
  <a href="/settings">Einstellungen</a>
  <a href="/community">Community</a>
  <a href="/delegations">Delegationen</a>
  <a href="/roadmap">Roadmap</a>
  <a href="/tools">Tools</a>
</header>

<div class="content">
  <div class="stats" id="stats"></div>
  <div class="filter-bar">
    <button class="filter-btn active" data-filter="open" onclick="setFilter('open')">Offen</button>
    <button class="filter-btn" data-filter="all" onclick="setFilter('all')">Alle</button>
    <button class="filter-btn" data-filter="done" onclick="setFilter('done')">Erledigt</button>
  </div>
  <div id="delegationList"></div>
</div>

<script>
let allDelegations = [];
let currentFilter = 'open';

function escapeHtml(s) {
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
}

async function loadDelegations() {
  const res = await fetch('/api/delegations');
  allDelegations = await res.json();
  renderStats();
  renderList();
}

function renderStats() {
  const open = allDelegations.filter(d => d.status === 'open' || d.status === 'in_progress');
  const done = allDelegations.filter(d => d.status === 'done');
  let totalTasks = 0, doneTasks = 0;
  allDelegations.forEach(d => {
    totalTasks += d.tasks.length;
    doneTasks += d.tasks.filter(t => t.status === 'done').length;
  });
  const assignees = new Set(open.map(d => d.assignee));
  document.getElementById('stats').innerHTML =
    '<div class="stat-card"><div class="num">' + open.length + '</div><div class="label">Offen</div></div>' +
    '<div class="stat-card"><div class="num">' + done.length + '</div><div class="label">Erledigt</div></div>' +
    '<div class="stat-card"><div class="num">' + doneTasks + '/' + totalTasks + '</div><div class="label">Aufgaben</div></div>' +
    '<div class="stat-card"><div class="num">' + assignees.size + '</div><div class="label">Personen</div></div>';
}

function setFilter(f) {
  currentFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === f));
  renderList();
}

function renderList() {
  const list = document.getElementById('delegationList');
  let filtered = allDelegations;
  if (currentFilter === 'open') filtered = allDelegations.filter(d => d.status === 'open' || d.status === 'in_progress');
  else if (currentFilter === 'done') filtered = allDelegations.filter(d => d.status === 'done');

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty">' + (currentFilter === 'open' ? 'Keine offenen Delegationen' : 'Keine Delegationen') + '</div>';
    return;
  }

  list.innerHTML = filtered.map(d => {
    const doneCount = d.tasks.filter(t => t.status === 'done').length;
    const icon = d.status === 'done' ? '\\u2705' : d.status === 'cancelled' ? '\\u274c' : '\\ud83d\\udccb';
    const deadline = d.deadline ? new Date(d.deadline).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }) : '';
    const created = new Date(d.created).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });

    let html = '<div class="delegation ' + d.status + '">';
    html += '<div class="del-header" onclick="toggleBody(' + d.id + ')">';
    html += '<span class="del-status">' + icon + '</span>';
    html += '<div class="del-info"><div class="del-assignee">' + escapeHtml(d.assignee) + '</div>';
    html += '<div class="del-subject">' + escapeHtml(d.subject) + '</div></div>';
    html += '<div class="del-meta">';
    html += '<div class="del-progress">' + doneCount + '/' + d.tasks.length + '</div>';
    if (deadline) html += '<div>' + deadline + '</div>';
    html += '<div>' + created + '</div>';
    html += '</div></div>';

    html += '<div class="del-body" id="body-' + d.id + '" style="display:none">';
    d.tasks.forEach(t => {
      const checkClass = t.status === 'done' ? 'done' : t.status === 'in_progress' ? 'in_progress' : '';
      const checkIcon = t.status === 'done' ? '\\u2713' : t.status === 'in_progress' ? '~' : '';
      const textClass = t.status === 'done' ? 'done' : '';
      const dateStr = t.completed_at ? t.completed_at.substring(0, 10) : '';
      html += '<div class="task-row">';
      html += '<div class="task-check ' + checkClass + '" onclick="cycleTask(' + d.id + ',' + t.id + ',\\'' + t.status + '\\')">' + checkIcon + '</div>';
      html += '<span class="task-text ' + textClass + '">' + escapeHtml(t.task) + '</span>';
      if (dateStr) html += '<span class="task-date">' + dateStr + '</span>';
      html += '</div>';
    });
    html += '</div>';

    if (d.status !== 'done' && d.status !== 'cancelled') {
      html += '<div class="del-actions">';
      html += '<button onclick="cancelDelegation(' + d.id + ')" class="cancel-btn">Stornieren</button>';
      html += '</div>';
    }
    html += '</div>';
    return html;
  }).join('');
}

function toggleBody(id) {
  const el = document.getElementById('body-' + id);
  el.style.display = el.style.display === 'none' ? '' : 'none';
}

async function cycleTask(delId, taskId, current) {
  const next = current === 'open' ? 'in_progress' : current === 'in_progress' ? 'done' : 'open';
  await fetch('/api/delegations/' + delId + '/tasks/' + taskId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: next })
  });
  loadDelegations();
}

async function cancelDelegation(id) {
  if (!confirm('Delegation stornieren?')) return;
  await fetch('/api/delegations/' + id, { method: 'DELETE' });
  loadDelegations();
}

loadDelegations();
setInterval(loadDelegations, 30000);
</script>
</body>
</html>`;
}

// --- Roadmap HTML ---

function getRoadmapHTML() {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon/favicon.svg">
<link rel="icon" type="image/png" sizes="96x96" href="/favicon/favicon-96x96.png">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="apple-touch-icon" sizes="180x180" href="/favicon/apple-touch-icon.png">
<title>${BOT_NAME} - Roadmap</title>
${getGoogleFontsLink(getActiveTheme())}
${getThemeCSS()}
<style>
  .container { max-width: 900px; margin: 20px auto; padding: 0 16px; }

  /* Toolbar */
  .toolbar {
    display: flex; gap: 8px; align-items: center; margin-bottom: 16px; flex-wrap: wrap;
  }
  .filter-btn { padding: 4px 12px; font-size: 11px; }
  .filter-btn.active { background: color-mix(in srgb, var(--accent) 13%, transparent); border-color: var(--accent); color: var(--accent); }
  .spacer { flex: 1; }
  .status-msg {
    font-size: 12px; color: var(--color-success); opacity: 0; transition: opacity 0.3s;
    white-space: nowrap;
  }
  .status-msg.show { opacity: 1; }
  .status-msg.error { color: var(--color-error); }

  /* Create Form */
  .create-form {
    background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px;
    padding: 16px; margin-bottom: 16px; display: none;
  }
  .create-form.show { display: block; }
  .form-row {
    display: flex; gap: 10px; margin-bottom: 10px; align-items: center; flex-wrap: wrap;
  }
  .form-row label { font-size: 12px; color: var(--text-muted); min-width: 70px; }
  .form-row input, .form-row textarea, .form-row select {
    background: var(--bg-primary); border: 1px solid var(--border-color); color: var(--text-primary);
    padding: 6px 10px; border-radius: 6px; font-family: inherit; font-size: 12px;
    flex: 1; min-width: 150px;
  }
  .form-row textarea { min-height: 60px; resize: vertical; }
  .form-row input:focus, .form-row textarea:focus, .form-row select:focus {
    outline: none; border-color: var(--accent);
  }
  .form-actions { display: flex; gap: 8px; justify-content: flex-end; }

  /* Cards */
  .card-list { display: flex; flex-direction: column; gap: 8px; }
  .card {
    background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px;
    padding: 12px 16px; display: flex; gap: 12px; align-items: flex-start;
    border-left: 3px solid var(--border-color); transition: border-color 0.15s;
  }
  .card:hover { border-color: var(--accent); }
  .card.priority-high { border-left-color: var(--color-error); }
  .card.priority-normal { border-left-color: var(--color-warning); }
  .card.priority-low { border-left-color: var(--text-muted); }
  .card.status-done { opacity: 0.6; }

  .card-body { flex: 1; min-width: 0; }
  .card-title {
    font-size: 14px; font-weight: 600; color: var(--text-bright); margin-bottom: 4px;
    word-break: break-word;
  }
  .card-desc {
    font-size: 12px; color: var(--text-muted); line-height: 1.5; margin-bottom: 6px;
    word-break: break-word;
  }
  .card-meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .badge {
    font-size: 10px; padding: 2px 8px; border-radius: 10px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.3px;
  }
  .badge-idea { background: color-mix(in srgb, var(--text-muted) 13%, transparent); color: var(--text-muted); }
  .badge-planned { background: color-mix(in srgb, var(--accent) 13%, transparent); color: var(--accent); }
  .badge-in_progress { background: color-mix(in srgb, var(--color-warning) 13%, transparent); color: var(--color-warning); }
  .badge-done { background: color-mix(in srgb, var(--color-success) 13%, transparent); color: var(--color-success); }
  .badge-category { background: var(--bg-tertiary); color: var(--text-muted); border: 1px solid var(--border-color); }
  .card-date { font-size: 10px; color: var(--text-dim); }

  .card-actions { display: flex; gap: 6px; align-items: center; flex-shrink: 0; }
  .card-actions select {
    background: var(--bg-tertiary); border: 1px solid var(--border-color); color: var(--text-primary);
    padding: 3px 6px; border-radius: 4px; font-size: 11px; font-family: inherit;
    cursor: pointer;
  }
  .card-actions button {
    background: none; border: 1px solid var(--border-color); color: var(--text-muted);
    padding: 3px 8px; border-radius: 4px; cursor: pointer; font-size: 11px;
    font-family: inherit; transition: all 0.15s;
  }
  .card-actions button:hover { border-color: var(--accent); color: var(--text-primary); }
  .card-actions .del-btn:hover { border-color: var(--color-error); color: var(--color-error); }

  /* Edit inline */
  .edit-form {
    background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px;
    padding: 10px; margin-top: 8px;
  }
  .edit-form input, .edit-form textarea, .edit-form select {
    background: var(--bg-secondary); border: 1px solid var(--border-color); color: var(--text-primary);
    padding: 4px 8px; border-radius: 4px; font-family: inherit; font-size: 12px;
    width: 100%; margin-bottom: 6px;
  }
  .edit-form textarea { min-height: 50px; resize: vertical; }
  .edit-form .edit-actions { display: flex; gap: 6px; justify-content: flex-end; }

  .empty-state {
    text-align: center; padding: 40px; color: var(--text-dim); font-size: 14px;
  }

  @media (max-width: 600px) {
    .card { flex-direction: column; }
    .card-actions { align-self: flex-end; }
  }

</style>
</head>
<body>
<header>
  <h1>Roadmap</h1>
  <a href="/">Monitor</a>
  <a href="/chat">Chat</a>
  <a href="/system">System</a>
  <a href="/ha-editor">Smart Home Editor</a>
  <a href="/notes">Wissensbasis</a>
  <a href="/reminders">Erinnerungen</a>
  <a href="/terminal">Terminal</a>
  <a href="/settings">Einstellungen</a>
  <a href="/community">Community</a>
  <a href="/delegations">Delegationen</a>
  <a href="/roadmap">Roadmap</a>
  <a href="/tools">Tools</a>
  <a href="/workflows">Workflows</a>
</header>

<div class="container">
  <div class="toolbar">
    <button class="btn btn-primary" onclick="toggleCreate()">+ Neuer Eintrag</button>
    <div class="spacer"></div>
    <button class="btn filter-btn active" data-filter="all" onclick="setFilter('all')">Alle</button>
    <button class="btn filter-btn" data-filter="idea" onclick="setFilter('idea')">Idee</button>
    <button class="btn filter-btn" data-filter="planned" onclick="setFilter('planned')">Geplant</button>
    <button class="btn filter-btn" data-filter="in_progress" onclick="setFilter('in_progress')">In Arbeit</button>
    <button class="btn filter-btn" data-filter="done" onclick="setFilter('done')">Erledigt</button>
    <span class="status-msg" id="statusMsg"></span>
  </div>

  <div class="create-form" id="createForm">
    <div class="form-row">
      <label>Titel</label>
      <input type="text" id="newTitle" placeholder="Feature / Idee / Task...">
    </div>
    <div class="form-row">
      <label>Beschreibung</label>
      <textarea id="newDesc" placeholder="Details (optional)"></textarea>
    </div>
    <div class="form-row">
      <label>Status</label>
      <select id="newStatus">
        <option value="idea">Idee</option>
        <option value="planned">Geplant</option>
        <option value="in_progress">In Arbeit</option>
        <option value="done">Erledigt</option>
      </select>
      <label>Priorität</label>
      <select id="newPriority">
        <option value="low">Niedrig</option>
        <option value="normal" selected>Normal</option>
        <option value="high">Hoch</option>
      </select>
      <label>Kategorie</label>
      <input type="text" id="newCategory" placeholder="z.B. Backend, Frontend..." style="max-width:150px">
    </div>
    <div class="form-actions">
      <button class="btn" onclick="toggleCreate()">Abbrechen</button>
      <button class="btn btn-primary" onclick="createItem()">Erstellen</button>
    </div>
  </div>

  <div class="card-list" id="cardList">
    <div class="empty-state">Laden...</div>
  </div>
</div>

<script>
const statusLabels = { idea: 'Idee', planned: 'Geplant', in_progress: 'In Arbeit', done: 'Erledigt' };
let allItems = [];
let currentFilter = 'all';
let editingId = null;

function escapeHtml(s) {
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
}

function showStatus(msg, isError) {
  const el = document.getElementById('statusMsg');
  el.textContent = msg;
  el.className = 'status-msg show' + (isError ? ' error' : '');
  setTimeout(() => el.classList.remove('show'), 3000);
}

function toggleCreate() {
  document.getElementById('createForm').classList.toggle('show');
}

function setFilter(f) {
  currentFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === f);
  });
  renderList();
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function renderList() {
  const list = document.getElementById('cardList');
  let filtered = allItems;
  if (currentFilter !== 'all') filtered = allItems.filter(i => i.status === currentFilter);

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state">' +
      (currentFilter === 'all' ? 'Noch keine Einträge. Erstelle den ersten!' : 'Keine Einträge mit Status "' + (statusLabels[currentFilter] || currentFilter) + '"') +
      '</div>';
    return;
  }

  list.innerHTML = filtered.map(item => {
    const isEditing = editingId === item.id;
    return '<div class="card priority-' + item.priority + ' status-' + item.status + '" data-id="' + item.id + '">' +
      '<div class="card-body">' +
        '<div class="card-title">' + escapeHtml(item.title) + '</div>' +
        (item.description ? '<div class="card-desc">' + escapeHtml(item.description) + '</div>' : '') +
        '<div class="card-meta">' +
          '<span class="badge badge-' + item.status + '">' + (statusLabels[item.status] || item.status) + '</span>' +
          (item.category ? '<span class="badge badge-category">' + escapeHtml(item.category) + '</span>' : '') +
          '<span class="card-date">' + formatDate(item.created) + '</span>' +
        '</div>' +
        (isEditing ? renderEditForm(item) : '') +
      '</div>' +
      '<div class="card-actions">' +
        '<select onchange="changeStatus(' + item.id + ', this.value)" title="Status ändern">' +
          Object.entries(statusLabels).map(([k,v]) => '<option value="' + k + '"' + (k === item.status ? ' selected' : '') + '>' + v + '</option>').join('') +
        '</select>' +
        '<button onclick="toggleEdit(' + item.id + ')" title="Bearbeiten">Edit</button>' +
        '<button class="del-btn" onclick="deleteItem(' + item.id + ')" title="Löschen">Del</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function renderEditForm(item) {
  return '<div class="edit-form">' +
    '<input type="text" id="editTitle" value="' + escapeHtml(item.title) + '">' +
    '<textarea id="editDesc">' + escapeHtml(item.description || '') + '</textarea>' +
    '<div style="display:flex;gap:6px;margin-bottom:6px">' +
      '<select id="editPriority">' +
        '<option value="low"' + (item.priority === 'low' ? ' selected' : '') + '>Niedrig</option>' +
        '<option value="normal"' + (item.priority === 'normal' ? ' selected' : '') + '>Normal</option>' +
        '<option value="high"' + (item.priority === 'high' ? ' selected' : '') + '>Hoch</option>' +
      '</select>' +
      '<input type="text" id="editCategory" value="' + escapeHtml(item.category || '') + '" placeholder="Kategorie">' +
    '</div>' +
    '<div class="edit-actions">' +
      '<button class="btn" onclick="toggleEdit(null)">Abbrechen</button>' +
      '<button class="btn btn-primary" onclick="saveEdit(' + item.id + ')">Speichern</button>' +
    '</div>' +
  '</div>';
}

// --- API ---
async function loadItems() {
  try {
    const res = await fetch('/api/roadmap');
    allItems = await res.json();
    renderList();
  } catch (err) { showStatus('Fehler: ' + err.message, true); }
}

async function createItem() {
  const title = document.getElementById('newTitle').value.trim();
  if (!title) { showStatus('Titel erforderlich', true); return; }
  try {
    await fetch('/api/roadmap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        description: document.getElementById('newDesc').value.trim(),
        status: document.getElementById('newStatus').value,
        priority: document.getElementById('newPriority').value,
        category: document.getElementById('newCategory').value.trim(),
      })
    });
    document.getElementById('newTitle').value = '';
    document.getElementById('newDesc').value = '';
    document.getElementById('newCategory').value = '';
    toggleCreate();
    showStatus('Erstellt!', false);
    loadItems();
  } catch (err) { showStatus('Fehler: ' + err.message, true); }
}

async function changeStatus(id, status) {
  try {
    await fetch('/api/roadmap/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    showStatus(statusLabels[status] || status, false);
    loadItems();
  } catch (err) { showStatus('Fehler: ' + err.message, true); }
}

function toggleEdit(id) {
  editingId = editingId === id ? null : id;
  renderList();
}

async function saveEdit(id) {
  try {
    await fetch('/api/roadmap/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: document.getElementById('editTitle').value.trim(),
        description: document.getElementById('editDesc').value.trim(),
        priority: document.getElementById('editPriority').value,
        category: document.getElementById('editCategory').value.trim(),
      })
    });
    editingId = null;
    showStatus('Gespeichert!', false);
    loadItems();
  } catch (err) { showStatus('Fehler: ' + err.message, true); }
}

async function deleteItem(id) {
  if (!confirm('Eintrag löschen?')) return;
  try {
    await fetch('/api/roadmap/' + id, { method: 'DELETE' });
    showStatus('Gelöscht', false);
    loadItems();
  } catch (err) { showStatus('Fehler: ' + err.message, true); }
}

loadItems();
</script>
</body>
</html>`;
}

// --- Terminal HTML ---

function getTerminalHTML() {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon/favicon.svg">
<link rel="icon" type="image/png" sizes="96x96" href="/favicon/favicon-96x96.png">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="apple-touch-icon" sizes="180x180" href="/favicon/apple-touch-icon.png">
<title>${BOT_NAME} - Terminal</title>
${getGoogleFontsLink(getActiveTheme())}
${getThemeCSS()}
<style>
  body { height: 100vh; display: flex; flex-direction: column; }

  .main { flex: 1; display: flex; overflow: hidden; }

  /* --- Quick Actions Sidebar --- */
  .sidebar {
    width: 280px; min-width: 240px; background: var(--bg-secondary);
    border-right: 1px solid var(--border-color); overflow-y: auto; padding: 12px;
  }
  .sidebar h2 {
    font-size: 11px; color: var(--text-muted); text-transform: uppercase;
    letter-spacing: 0.5px; margin-bottom: 10px; font-weight: 600;
  }
  .action-group { margin-bottom: 20px; }
  .action-btn {
    display: flex; align-items: center; gap: 10px; width: 100%;
    background: var(--bg-tertiary); border: 1px solid var(--border-color); color: var(--text-primary);
    padding: 10px 12px; border-radius: 6px; cursor: pointer;
    font-family: inherit; font-size: 12px; margin-bottom: 6px;
    transition: all 0.15s; text-align: left;
  }
  .action-btn:hover { border-color: var(--accent); color: var(--accent); }
  .action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .action-btn .icon { font-size: 16px; width: 24px; text-align: center; }
  .action-btn .label { flex: 1; }
  .action-btn .badge {
    font-size: 10px; padding: 2px 6px; border-radius: 8px;
    background: var(--bg-tertiary); color: var(--text-muted);
  }
  .action-btn.danger { border-color: color-mix(in srgb, var(--color-error) 27%, transparent); }
  .action-btn.danger:hover { border-color: var(--color-error); color: var(--color-error); background: color-mix(in srgb, var(--color-error) 7%, transparent); }
  .action-btn.warn { border-color: color-mix(in srgb, var(--color-warning) 27%, transparent); }
  .action-btn.warn:hover { border-color: var(--color-warning); color: var(--color-warning); background: color-mix(in srgb, var(--color-warning) 7%, transparent); }
  .action-btn.success { border-color: color-mix(in srgb, var(--color-success) 27%, transparent); }
  .action-btn.success:hover { border-color: var(--color-success); color: var(--color-success); background: color-mix(in srgb, var(--color-success) 7%, transparent); }

  .status-card {
    background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px;
    padding: 10px; margin-bottom: 6px;
  }
  .status-card .label { font-size: 10px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 4px; }
  .status-card .value { font-size: 13px; color: var(--text-bright); }
  .status-card .value.running { color: var(--color-success); }
  .status-card .value.stopped { color: var(--color-error); }

  /* --- Terminal Area --- */
  .terminal-wrap {
    flex: 1; display: flex; flex-direction: column; min-width: 0;
  }
  .terminal-header {
    background: var(--bg-secondary); padding: 8px 16px; font-size: 11px; color: var(--text-muted);
    border-bottom: 1px solid var(--border-color); display: flex; align-items: center; gap: 12px;
  }
  .terminal-header .cwd { color: var(--accent); }
  .terminal-header .clear-btn {
    margin-left: auto; background: none; border: 1px solid var(--border-color);
    color: var(--text-muted); padding: 2px 8px; border-radius: 4px; cursor: pointer;
    font-family: inherit; font-size: 11px;
  }
  .terminal-header .clear-btn:hover { border-color: var(--accent); color: var(--text-primary); }
  #terminal-output {
    flex: 1; overflow-y: auto; padding: 8px 16px; background: var(--bg-primary);
    white-space: pre-wrap; word-break: break-all; font-size: 12px;
    line-height: 1.5;
  }
  #terminal-output .cmd-line { color: var(--color-success); margin-top: 8px; }
  #terminal-output .cmd-line:first-child { margin-top: 0; }
  #terminal-output .cmd-output { color: var(--text-primary); }
  #terminal-output .cmd-error { color: var(--color-error); }
  #terminal-output .cmd-info { color: var(--text-muted); font-style: italic; }
  .terminal-input-wrap {
    background: var(--bg-secondary); border-top: 1px solid var(--border-color);
    padding: 8px 16px; display: flex; gap: 8px; align-items: center;
  }
  .prompt { color: var(--color-success); font-size: 13px; font-weight: 600; }
  #terminal-input {
    flex: 1; background: var(--bg-primary); border: 1px solid var(--border-color); color: var(--text-primary);
    padding: 8px 12px; border-radius: 6px; font-family: inherit; font-size: 13px;
    outline: none;
  }
  #terminal-input:focus { border-color: var(--accent); }
  #terminal-input:disabled { opacity: 0.5; }
  .run-btn {
    background: var(--btn-primary-bg); border: 1px solid var(--btn-primary-hover); color: #fff;
    padding: 8px 16px; border-radius: 6px; cursor: pointer;
    font-family: inherit; font-size: 12px; font-weight: 600;
  }
  .run-btn:hover { background: var(--btn-primary-hover); }
  .run-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  @media (max-width: 800px) {
    .main { flex-direction: column; }
    .sidebar { width: 100%; max-height: 220px; border-right: none; border-bottom: 1px solid var(--border-color); }
  }
</style>
</head>
<body>
<header>
  <h1>Terminal</h1>
  <a href="/">Monitor</a>
  <a href="/chat">Chat</a>
  <a href="/system">System</a>
  <a href="/ha-editor">Smart Home Editor</a>
  <a href="/notes">Wissensbasis</a>
  <a href="/reminders">Erinnerungen</a>
  <a href="/settings">Einstellungen</a>
  <a href="/community">Community</a>
  <a href="/delegations">Delegationen</a>
  <a href="/roadmap">Roadmap</a>
  <a href="/tools">Tools</a>
  <a href="/workflows">Workflows</a>
</header>

<div class="main">
  <div class="sidebar">
    <div class="action-group">
      <h2>${BOT_NAME} Service</h2>
      <div class="status-card">
        <div class="label">Status</div>
        <div class="value" id="serviceStatus">Laden...</div>
      </div>
      <button class="action-btn success" onclick="quickAction('service-restart', '${BOT_NAME} neustarten?')">
        <span class="icon">&#x21bb;</span><span class="label">${BOT_NAME} neustarten</span>
      </button>
      <button class="action-btn" onclick="quickAction('service-stop', '${BOT_NAME} stoppen?')">
        <span class="icon">&#x23f9;</span><span class="label">${BOT_NAME} stoppen</span>
      </button>
      <button class="action-btn" onclick="quickAction('service-logs', null)">
        <span class="icon">&#x1F4CB;</span><span class="label">Service-Logs (50 Zeilen)</span>
      </button>
      <button class="action-btn" onclick="quickAction('kiasy-update', 'KIASY auf die neueste Version aktualisieren?')">
        <span class="icon">&#x2B06;</span><span class="label">KIASY Update</span>
      </button>
    </div>

    <div class="action-group">
      <h2>${BOT_NAME} Agent</h2>
      <button class="action-btn" onclick="quickAction('agent-reset', 'Chat-History aller Nutzer löschen?')">
        <span class="icon">&#x1F5D1;</span><span class="label">Chat-History löschen</span>
      </button>
      <button class="action-btn" onclick="quickAction('git-backup', null)">
        <span class="icon">&#x2601;</span><span class="label">Git Backup pushen</span>
      </button>
    </div>

    <div class="action-group">
      <h2>System</h2>
      <div class="status-card">
        <div class="label">Uptime</div>
        <div class="value" id="sysUptime">-</div>
      </div>
      <button class="action-btn warn" onclick="quickAction('system-reboot', 'System wirklich NEUSTARTEN?')">
        <span class="icon">&#x1F504;</span><span class="label">System neustarten</span>
      </button>
      <button class="action-btn danger" onclick="quickAction('system-shutdown', 'System wirklich HERUNTERFAHREN?\\n${BOT_NAME} wird offline sein!')">
        <span class="icon">&#x23FB;</span><span class="label">System herunterfahren</span>
      </button>
    </div>

    <div class="action-group">
      <h2>Support</h2>
      <button class="action-btn" onclick="quickAction('diagnose', null)">
        <span class="icon">&#x1F50D;</span><span class="label">Diagnose-Report</span>
      </button>
      <button class="action-btn" onclick="quickAction('support-send', 'Diagnose-Report an Support senden?')">
        <span class="icon">&#x1F4E7;</span><span class="label">Support kontaktieren</span>
      </button>
    </div>

    <div class="action-group">
      <h2>Schnellbefehle</h2>
      <button class="action-btn" onclick="runCmd('df -h /')">
        <span class="icon">&#x1F4BE;</span><span class="label">Speicherplatz</span>
      </button>
      <button class="action-btn" onclick="runCmd('free -h')">
        <span class="icon">&#x1F4CA;</span><span class="label">RAM-Auslastung</span>
      </button>
      <button class="action-btn" onclick="runCmd('docker ps --format \\'table {{.Names}}\\\\t{{.Status}}\\\\t{{.Ports}}\\' 2>/dev/null || echo \\'Docker nicht installiert\\'')">
        <span class="icon">&#x1F40B;</span><span class="label">Docker Container</span>
      </button>
      <button class="action-btn" onclick="runCmd('ss -tlnp 2>/dev/null | head -20')">
        <span class="icon">&#x1F310;</span><span class="label">Offene Ports</span>
      </button>
      <button class="action-btn" onclick="runCmd('tail -20 /var/log/syslog 2>/dev/null || journalctl -n 20 --no-pager 2>/dev/null')">
        <span class="icon">&#x1F4DD;</span><span class="label">System-Log (letzte 20)</span>
      </button>
    </div>
  </div>

  <div class="terminal-wrap">
    <div class="terminal-header">
      <span>Verzeichnis: <span class="cwd" id="cwd">${__dirname}</span></span>
      <button class="clear-btn" onclick="clearTerminal()">Leeren</button>
    </div>
    <div id="terminal-output">
      <div class="cmd-info">${BOT_NAME} WebTerminal bereit. Befehle eingeben oder Quick Actions nutzen.</div>
    </div>
    <div class="terminal-input-wrap">
      <span class="prompt">$</span>
      <input type="text" id="terminal-input" placeholder="Befehl eingeben..." autofocus>
      <button class="run-btn" id="runBtn" onclick="submitCmd()">Ausführen</button>
    </div>
  </div>
</div>

<script>
const output = document.getElementById('terminal-output');
const input = document.getElementById('terminal-input');
const runBtn = document.getElementById('runBtn');
const cwdEl = document.getElementById('cwd');
let cmdHistory = [];
let historyIdx = -1;
let currentCwd = '${__dirname}';

function escapeHtml(s) {
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
}

function appendOutput(html) {
  output.insertAdjacentHTML('beforeend', html);
  output.scrollTop = output.scrollHeight;
}

function clearTerminal() {
  output.innerHTML = '<div class="cmd-info">Terminal geleert.</div>';
  fetch('/api/terminal/session', { method: 'DELETE' }).catch(() => {});
}

async function runCmd(cmd) {
  if (!cmd || !cmd.trim()) return;

  input.disabled = true;
  runBtn.disabled = true;
  appendOutput('<div class="cmd-line">$ ' + escapeHtml(cmd) + '</div>');

  try {
    const res = await fetch('/api/terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmd, cwd: currentCwd })
    });
    const data = await res.json();

    if (data.stdout) {
      appendOutput('<div class="cmd-output">' + escapeHtml(data.stdout) + '</div>');
    }
    if (data.stderr) {
      appendOutput('<div class="cmd-error">' + escapeHtml(data.stderr) + '</div>');
    }
    if (data.error) {
      appendOutput('<div class="cmd-error">' + escapeHtml(data.error) + '</div>');
    }
    if (data.cwd) {
      currentCwd = data.cwd;
      cwdEl.textContent = currentCwd;
    }
  } catch (err) {
    appendOutput('<div class="cmd-error">Verbindungsfehler: ' + escapeHtml(err.message) + '</div>');
  } finally {
    input.disabled = false;
    runBtn.disabled = false;
    input.focus();
  }
}

function submitCmd() {
  const cmd = input.value.trim();
  if (!cmd) return;
  cmdHistory.unshift(cmd);
  if (cmdHistory.length > 100) cmdHistory.pop();
  historyIdx = -1;
  input.value = '';
  runCmd(cmd);
  // History in DB speichern
  fetch('/api/terminal/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ history: cmdHistory }) }).catch(() => {});
}

async function quickAction(action, confirmMsg) {
  if (confirmMsg && !confirm(confirmMsg)) return;

  appendOutput('<div class="cmd-info">[Quick Action: ' + escapeHtml(action) + ']</div>');

  try {
    const res = await fetch('/api/terminal/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
    const data = await res.json();

    if (data.output) {
      appendOutput('<div class="cmd-output">' + escapeHtml(data.output) + '</div>');
    }
    if (data.error) {
      appendOutput('<div class="cmd-error">' + escapeHtml(data.error) + '</div>');
    }
    if (data.message) {
      appendOutput('<div class="cmd-info">' + escapeHtml(data.message) + '</div>');
    }

    // Refresh service status
    loadStatus();
  } catch (err) {
    appendOutput('<div class="cmd-error">Fehler: ' + escapeHtml(err.message) + '</div>');
  }
}

// Keyboard
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    submitCmd();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (historyIdx < cmdHistory.length - 1) {
      historyIdx++;
      input.value = cmdHistory[historyIdx];
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (historyIdx > 0) {
      historyIdx--;
      input.value = cmdHistory[historyIdx];
    } else {
      historyIdx = -1;
      input.value = '';
    }
  }
});

// Service Status
async function loadStatus() {
  try {
    const res = await fetch('/api/terminal/status');
    const data = await res.json();
    const el = document.getElementById('serviceStatus');
    el.textContent = data.serviceStatus || 'Unbekannt';
    el.className = 'value ' + (data.serviceRunning ? 'running' : 'stopped');
    document.getElementById('sysUptime').textContent = data.systemUptime || '-';
  } catch {}
}

loadStatus();
setInterval(loadStatus, 15000);

// Letzte Session aus DB laden
async function loadSession() {
  try {
    const res = await fetch('/api/terminal/session');
    const data = await res.json();
    if (data.cwd) { currentCwd = data.cwd; cwdEl.textContent = currentCwd; }
    if (data.history && data.history.length > 0) { cmdHistory = data.history; }
    if (data.log && data.log.length > 0) {
      output.innerHTML = '';
      for (const entry of data.log) {
        if (entry.type === 'cmd') appendOutput('<div class="cmd-line">$ ' + escapeHtml(entry.content) + '</div>');
        else if (entry.type === 'stdout') appendOutput('<div class="cmd-output">' + escapeHtml(entry.content) + '</div>');
        else if (entry.type === 'stderr') appendOutput('<div class="cmd-error">' + escapeHtml(entry.content) + '</div>');
        else if (entry.type === 'error') appendOutput('<div class="cmd-error">' + escapeHtml(entry.content) + '</div>');
        else if (entry.type === 'info') appendOutput('<div class="cmd-info">' + escapeHtml(entry.content) + '</div>');
      }
    }
  } catch {}
}
loadSession();
</script>
</body>
</html>`;
}

// --- Workflows API Handlers ---

function handleWorkflowsList(req, res) {
  const all = db.workflows.getAll();
  // Steps für jeden Workflow laden
  const result = all.map((w) => {
    w.steps = db.workflows.getSteps(w.id);
    return w;
  });
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(result));
}

function handleWorkflowGet(req, res, id) {
  const w = db.workflows.getById(id);
  if (!w) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Workflow nicht gefunden" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(w));
}

function handleWorkflowUpdate(req, res, id) {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const updated = db.workflows.update(id, body);
      if (!updated) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Workflow nicht gefunden" }));
        return;
      }
      originalLog("[Monitor] Workflow aktualisiert: " + id);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

function handleWorkflowDelete(req, res, id) {
  db.workflows.remove(id);
  originalLog("[Monitor] Workflow gelöscht: " + id);
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify({ ok: true }));
}

// --- Tool AI Generator ---

function handleToolGenerate(req, res) {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => {
    try {
      const { description, filename } = JSON.parse(Buffer.concat(chunks).toString());
      if (!description) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Beschreibung fehlt" }));
        return;
      }

      const prompt = `Du bist ein Node.js-Entwickler. Erstelle ein Tool-Modul für einen KI-Assistenten.

Das Modul muss EXAKT dieses Format haben:
\`\`\`javascript
const definitions = [
  {
    name: "tool_name",
    description: "Was das Tool tut",
    input_schema: {
      type: "object",
      properties: {
        param1: { type: "string", description: "Beschreibung" },
      },
      required: ["param1"],
    },
  },
];

async function execute(name, input) {
  switch (name) {
    case "tool_name": {
      // Implementierung
      return "Ergebnis als String";
    }
    default:
      return "Unbekanntes Tool: " + name;
  }
}

module.exports = { definitions, execute };
\`\`\`

REGELN:
- Nur \`module.exports = { definitions, execute }\` exportieren
- definitions ist ein Array mit Tool-Definitionen (name, description, input_schema)
- execute ist eine async function die (name, input) bekommt
- Rückgabe immer ein lesbarer String (kein JSON)
- Verfügbare npm-Pakete: axios, cheerio, fs, path
- Für HTTP-Requests: axios verwenden
- Fehler abfangen und als "❌ Fehler: ..." zurückgeben
- Keine console.log, kein process.exit
- Tool-Namen in snake_case
- Kommentare auf Deutsch

Erstelle das Tool für folgende Beschreibung:
${description}

Antworte NUR mit dem JavaScript-Code, keine Erklärungen davor oder danach.`;

      const { createProvider } = require("./providers");
      const providerConfig = require("./agent").getProviderConfig ? require("./agent").getProviderConfig() : (() => {
        const p = (process.env.LLM_PROVIDER || "anthropic").toLowerCase();
        switch (p) {
          case "ollama": return { provider: p, baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1", model: process.env.OLLAMA_MODEL || "llama3.1", maxTokens: 4096 };
          case "groq": return { provider: p, apiKey: process.env.GROQ_API_KEY, model: process.env.GROQ_MODEL || "llama-3.1-70b-versatile", maxTokens: 4096 };
          case "openai": return { provider: p, apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || "gpt-4o", maxTokens: 4096 };
          default: return { provider: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514", maxTokens: 4096 };
        }
      })();

      const provider = createProvider(providerConfig);

      provider.chat("Du bist ein erfahrener Node.js-Entwickler.", [{ role: "user", content: prompt }], [])
        .then(response => {
          let code = response.text || "";
          // Code-Block extrahieren falls vorhanden
          const codeMatch = code.match(/```(?:javascript|js)?\n([\s\S]*?)\n```/);
          if (codeMatch) code = codeMatch[1];
          // Cleanup
          code = code.trim();
          if (!code.includes("module.exports")) {
            code += "\n\nmodule.exports = { definitions, execute };";
          }

          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: true, code, filename: filename || "generated-tool.js" }));
        })
        .catch(err => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "KI-Fehler: " + err.message }));
        });
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

// --- Tools API Handlers ---

const TOOLS_DIR = path.join(__dirname, "tools");

function handleToolsList(req, res) {
  try {
    const files = fs.readdirSync(TOOLS_DIR).filter(f => f.endsWith(".js")).sort();
    const result = files.map(filename => {
      const fullPath = path.join(TOOLS_DIR, filename);
      const stats = fs.statSync(fullPath);
      const enabled = db.toolSettings.isEnabled(filename);
      let definitions = [];
      let error = null;
      try {
        delete require.cache[require.resolve(fullPath)];
        const mod = require(fullPath);
        if (mod.definitions) definitions = mod.definitions.map(d => ({ name: d.name, description: d.description || "" }));
      } catch (e) {
        error = e.message;
      }
      const visibility = db.toolSettings.getVisibility(filename);
      return { filename, size: stats.size, modified: stats.mtime.toISOString(), enabled, visibility, definitions, error };
    });
    result.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.filename.localeCompare(b.filename);
    });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function handleToolRead(req, res, filename) {
  if (!filename.endsWith(".js") || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Ungültiger Dateiname" }));
    return;
  }
  const fullPath = path.join(TOOLS_DIR, filename);
  if (!fs.existsSync(fullPath)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Datei nicht gefunden" }));
    return;
  }
  const content = fs.readFileSync(fullPath, "utf-8");
  const enabled = db.toolSettings.isEnabled(filename);
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify({ filename, content, enabled }));
}

function handleToolWrite(req, res, filename) {
  if (!filename.endsWith(".js") || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Ungültiger Dateiname" }));
    return;
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      fs.writeFileSync(path.join(TOOLS_DIR, filename), body.content, "utf-8");
      originalLog("[Monitor] Tool gespeichert: " + filename);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

function handleToolCreate(req, res) {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      let filename = body.filename || "";
      if (!filename.endsWith(".js")) filename += ".js";
      if (filename.includes("..") || filename.includes("/") || filename.includes("\\") || filename.length < 4) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Ungültiger Dateiname" }));
        return;
      }
      const fullPath = path.join(TOOLS_DIR, filename);
      if (fs.existsSync(fullPath)) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Datei existiert bereits" }));
        return;
      }
      const template = `// Neues Tool – Beschreibung anpassen
const definitions = [
  {
    name: "mein_tool",
    description: "Beschreibung was dieses Tool tut",
    input_schema: {
      type: "object",
      properties: {
        param1: { type: "string", description: "Parameter 1" },
      },
      required: ["param1"],
    },
  },
];

async function execute(name, input) {
  switch (name) {
    case "mein_tool": {
      return "Ergebnis";
    }
    default:
      return "Unbekanntes Tool: " + name;
  }
}

module.exports = { definitions, execute };
`;
      fs.writeFileSync(fullPath, template, "utf-8");
      db.toolSettings.register(filename);
      originalLog("[Monitor] Neues Tool erstellt: " + filename);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, filename }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

function handleToolToggle(req, res, filename) {
  if (!filename.endsWith(".js") || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Ungültiger Dateiname" }));
    return;
  }
  const newState = db.toolSettings.toggle(filename);
  originalLog("[Monitor] Tool " + (newState ? "aktiviert" : "deaktiviert") + ": " + filename);
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify({ ok: true, enabled: newState }));
}

function handleToolDelete(req, res, filename) {
  if (!filename.endsWith(".js") || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Ungültiger Dateiname" }));
    return;
  }
  const fullPath = path.join(TOOLS_DIR, filename);
  if (!fs.existsSync(fullPath)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Datei nicht gefunden" }));
    return;
  }
  fs.unlinkSync(fullPath);
  db.toolSettings.remove(filename);
  originalLog("[Monitor] Tool gelöscht: " + filename);
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify({ ok: true }));
}

// --- Roadmap API Handlers ---

function handleRoadmapList(req, res) {
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(db.roadmap.getAll()));
}

function handleRoadmapCreate(req, res) {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (!body.title) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Titel erforderlich" }));
        return;
      }
      const item = db.roadmap.create(body);
      originalLog("[Monitor] Roadmap-Item erstellt: " + body.title);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, item }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

function handleRoadmapUpdate(req, res, id) {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const updated = db.roadmap.update(id, body);
      if (!updated) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Item nicht gefunden" }));
        return;
      }
      originalLog("[Monitor] Roadmap-Item aktualisiert: " + updated.title);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, item: updated }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

function handleRoadmapDelete(req, res, id) {
  const existing = db.roadmap.getById(id);
  if (!existing) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Item nicht gefunden" }));
    return;
  }
  db.roadmap.remove(id);
  originalLog("[Monitor] Roadmap-Item gelöscht: " + existing.title);
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify({ ok: true }));
}

// --- Terminal API Handlers ---

function handleTerminalExec(req, res) {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const cmd = body.command;
      const cwd = body.cwd || __dirname;

      if (!cmd) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "command fehlt" }));
        return;
      }

      // cd handling: extract new cwd
      const cdMatch = cmd.match(/^cd\s+(.+)$/);
      if (cdMatch) {
        const target = cdMatch[1].trim().replace(/^~/, process.env.HOME || require("os").homedir());
        const newCwd = path.resolve(cwd, target);
        db.terminal.log("cmd", cmd);
        if (fs.existsSync(newCwd) && fs.statSync(newCwd).isDirectory()) {
          db.terminal.setCwd(newCwd);
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ stdout: "", stderr: "", cwd: newCwd }));
        } else {
          const errMsg = "cd: " + target + ": Kein solches Verzeichnis";
          db.terminal.log("stderr", errMsg);
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ stdout: "", stderr: errMsg, cwd }));
        }
        return;
      }

      db.terminal.log("cmd", cmd);
      const { exec } = require("child_process");
      exec(cmd, { cwd, timeout: 30000, maxBuffer: 1024 * 1024, env: { ...process.env, TERM: "dumb" } }, (err, stdout, stderr) => {
        if (stdout) db.terminal.log("stdout", stdout);
        if (stderr) db.terminal.log("stderr", stderr);
        if (err && !stderr) db.terminal.log("error", err.message);
        db.terminal.setCwd(cwd);
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({
          stdout: stdout || "",
          stderr: stderr || "",
          exitCode: err ? err.code : 0,
          error: err && !stderr ? err.message : undefined,
          cwd,
        }));
      });
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

function handleTerminalAction(req, res) {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const action = body.action;
      const { exec } = require("child_process");

      const respond = (data) => {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(data));
      };

      switch (action) {
        case "service-restart":
          respond({ message: BOT_NAME + " wird neu gestartet..." });
          // Kurz warten damit die Response rausgeht, dann mit exit(1) beenden
          // systemd startet den Prozess automatisch neu (Restart=on-failure)
          setTimeout(() => { try { db.close(); } catch {} process.exit(1); }, 500);
          break;

        case "service-stop":
          respond({ message: BOT_NAME + " wird gestoppt..." });
          setTimeout(() => { try { db.close(); } catch {} process.exit(0); }, 500);
          break;

        case "service-logs":
          exec("journalctl -u kiasy --no-pager -n 50 2>/dev/null || echo 'Journal nicht verfügbar'", { timeout: 10000 }, (err, out) => {
            respond({ output: out || (err ? err.message : "Keine Logs") });
          });
          break;

        case "kiasy-update":
          exec('cd "' + __dirname + '" && git stash -q 2>/dev/null; git pull --rebase 2>&1 && npm install --production 2>&1; git stash pop -q 2>/dev/null', { timeout: 60000 }, (err, out) => {
            const output = out || (err ? err.message : "");
            const hasChanges = !output.includes("Already up to date") && !output.includes("Bereits aktuell");
            if (hasChanges) {
              respond({ message: "Update installiert — " + BOT_NAME + " wird neu gestartet...", output });
              setTimeout(() => { try { db.close(); } catch {} process.exit(1); }, 1000);
            } else {
              respond({ message: "Bereits auf dem neuesten Stand", output });
            }
          });
          break;

        case "diagnose": {
          const diag = [];
          diag.push("=== KIASY Diagnose-Report ===");
          diag.push("Datum: " + new Date().toLocaleString("de-DE", { timeZone: process.env.TZ || "Europe/Berlin" }));
          diag.push("");
          // Version
          try {
            const ver = execSync('cd "' + __dirname + '" && git rev-parse --short HEAD 2>/dev/null', { encoding: "utf-8" }).trim();
            const branch = execSync('cd "' + __dirname + '" && git branch --show-current 2>/dev/null', { encoding: "utf-8" }).trim();
            diag.push("Version: " + ver + " (" + branch + ")");
          } catch { diag.push("Version: unbekannt"); }
          // System
          diag.push("Node.js: " + process.version);
          diag.push("OS: " + os.type() + " " + os.release() + " " + os.arch());
          diag.push("Uptime System: " + Math.floor(os.uptime() / 3600) + "h");
          diag.push("Uptime Prozess: " + Math.floor(process.uptime() / 60) + "m");
          diag.push("RAM: " + Math.round(os.freemem() / 1024 / 1024) + " MB frei / " + Math.round(os.totalmem() / 1024 / 1024) + " MB");
          // Config
          diag.push("");
          diag.push("Provider: " + (process.env.LLM_PROVIDER || "anthropic"));
          diag.push("Modell: " + (process.env.OLLAMA_MODEL || process.env.CLAUDE_MODEL || process.env.GROQ_MODEL || process.env.OPENAI_MODEL || "-"));
          if (process.env.OLLAMA_BASE_URL) diag.push("Ollama URL: " + process.env.OLLAMA_BASE_URL);
          diag.push("Bot: " + (process.env.BOT_NAME || "KIASY"));
          diag.push("TZ: " + (process.env.TZ || "Europe/Berlin"));
          // Tools
          try {
            const toolFiles = require("fs").readdirSync(path.join(__dirname, "tools")).filter(f => f.endsWith(".js"));
            const enabled = toolFiles.filter(f => { try { return db.toolSettings.isEnabled(f); } catch { return true; } });
            diag.push("Tools: " + enabled.length + "/" + toolFiles.length + " aktiv");
          } catch {}
          // DB Stats
          try {
            const stats = db.messages.getStats();
            diag.push("DB: " + stats.total + " Nachrichten, " + stats.chats + " Chats");
            diag.push("Erinnerungen: " + db.reminders.getActive().length + " aktiv");
            diag.push("Delegationen: " + db.delegations.count() + " offen");
          } catch {}
          // Logs
          diag.push("");
          diag.push("=== Letzte 20 Log-Zeilen ===");
          try {
            const logs = execSync("journalctl -u kiasy --no-pager -n 20 2>/dev/null || echo 'Journal nicht verfügbar'", { encoding: "utf-8", timeout: 5000 });
            diag.push(logs.trim());
          } catch { diag.push("(Logs nicht verfügbar)"); }

          const report = diag.join("\n");
          respond({ message: "Diagnose-Report erstellt", output: report });
          break;
        }

        case "support-send": {
          const supportEmail = process.env.SUPPORT_EMAIL;
          if (!supportEmail) {
            respond({ error: "SUPPORT_EMAIL nicht konfiguriert. Bitte in Einstellungen setzen." });
            break;
          }
          // Diagnose-Report generieren (gleicher Code wie oben)
          const lines = [];
          lines.push("KIASY Diagnose-Report");
          lines.push("Datum: " + new Date().toLocaleString("de-DE", { timeZone: process.env.TZ || "Europe/Berlin" }));
          lines.push("Bot: " + (process.env.BOT_NAME || "KIASY"));
          lines.push("Besitzer: " + (process.env.OWNER_NAME || "-"));
          lines.push("");
          try {
            const ver = execSync('cd "' + __dirname + '" && git rev-parse --short HEAD 2>/dev/null', { encoding: "utf-8" }).trim();
            lines.push("Version: " + ver);
          } catch {}
          lines.push("Node.js: " + process.version);
          lines.push("OS: " + os.type() + " " + os.release());
          lines.push("Provider: " + (process.env.LLM_PROVIDER || "anthropic"));
          lines.push("Modell: " + (process.env.OLLAMA_MODEL || process.env.CLAUDE_MODEL || process.env.GROQ_MODEL || process.env.OPENAI_MODEL || "-"));
          try {
            const toolFiles = require("fs").readdirSync(path.join(__dirname, "tools")).filter(f => f.endsWith(".js"));
            const enabled = toolFiles.filter(f => { try { return db.toolSettings.isEnabled(f); } catch { return true; } });
            lines.push("Tools: " + enabled.length + "/" + toolFiles.length);
          } catch {}
          lines.push("");
          lines.push("=== Letzte 30 Log-Zeilen ===");
          try {
            lines.push(execSync("journalctl -u kiasy --no-pager -n 30 2>/dev/null || echo '-'", { encoding: "utf-8", timeout: 5000 }).trim());
          } catch {}

          // Mail senden
          const nodemailer = require("nodemailer");
          let transporter;
          const mailSubject = "KIASY Support: " + (process.env.BOT_NAME || "KIASY") + " (" + (process.env.OWNER_NAME || "Nutzer") + ")";
          const mailBody = lines.join("\n");

          if (process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASSWORD) {
            const smtpHost = process.env.EMAIL_SMTP_HOST || process.env.EMAIL_HOST.replace(/^imap\./, "smtp.");
            transporter = nodemailer.createTransport({
              host: smtpHost, port: parseInt(process.env.EMAIL_SMTP_PORT) || 587,
              secure: (process.env.EMAIL_SMTP_PORT || "587") === "465",
              auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD },
              tls: { rejectUnauthorized: false },
            });
          } else if (process.env.KERIO_HOST && process.env.KERIO_USER && process.env.KERIO_PASSWORD) {
            transporter = nodemailer.createTransport({
              host: process.env.KERIO_HOST, port: 587, secure: false,
              auth: { user: process.env.KERIO_USER, pass: process.env.KERIO_PASSWORD },
              tls: { rejectUnauthorized: false },
            });
          } else {
            respond({ error: "Kein E-Mail-Provider konfiguriert." });
            break;
          }
          transporter.sendMail({
            from: process.env.EMAIL_FROM || process.env.EMAIL_USER || process.env.KERIO_FROM || process.env.KERIO_USER,
            to: supportEmail, subject: mailSubject, text: mailBody,
          }, (err) => {
            if (err) respond({ error: "Mail-Fehler: " + err.message });
            else respond({ message: "Support-Mail gesendet an " + supportEmail });
          });
          break;
        }

        case "agent-reset":
          try {
            const agentMod = require("./agent");
            agentMod.conversations.clear();
            try { agentMod.db.messages.clearAll(); } catch {}
            respond({ message: "Chat-History aller Nutzer gelöscht (Memory + DB)" });
          } catch (e) {
            respond({ error: e.message });
          }
          break;

        case "git-backup":
          exec('cd "' + __dirname + '" && git add -A && git diff --cached --quiet || (git commit -m "Auto-Backup $(date +%Y-%m-%d_%H:%M)" && git push) 2>&1', { timeout: 30000 }, (err, out) => {
            respond({ output: out || "Keine Änderungen", error: err ? err.message : undefined });
          });
          break;

        case "system-reboot":
          respond({ message: "System wird neugestartet..." });
          exec("sudo reboot", { timeout: 5000 }, () => {});
          break;

        case "system-shutdown":
          respond({ message: "System wird heruntergefahren..." });
          exec("sudo shutdown -h now", { timeout: 5000 }, () => {});
          break;

        default:
          respond({ error: "Unbekannte Aktion: " + action });
      }
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

function handleTerminalStatus(req, res) {
  const { exec } = require("child_process");

  let serviceStatus = "Unbekannt";
  let serviceRunning = false;

  exec("systemctl is-active kiasy 2>/dev/null", { timeout: 5000 }, (err, out) => {
    const status = (out || "").trim();
    serviceRunning = status === "active";
    serviceStatus = serviceRunning ? "Aktiv (running)" : (status || "Gestoppt");

    // System uptime
    const uptimeSec = os.uptime();
    const days = Math.floor(uptimeSec / 86400);
    const hours = Math.floor((uptimeSec % 86400) / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    const systemUptime = (days > 0 ? days + "d " : "") + hours + "h " + mins + "m";

    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ serviceStatus, serviceRunning, systemUptime }));
  });
}

// --- Reminders HTML ---

function getRemindersHTML() {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon/favicon.svg">
<link rel="icon" type="image/png" sizes="96x96" href="/favicon/favicon-96x96.png">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="apple-touch-icon" sizes="180x180" href="/favicon/apple-touch-icon.png">
<title>${BOT_NAME} - Erinnerungen</title>
${getGoogleFontsLink(getActiveTheme())}
${getThemeCSS()}
<style>
  .container { max-width: 900px; margin: 20px auto; padding: 0 16px; }

  /* Toolbar */
  .toolbar {
    display: flex; gap: 8px; align-items: center; margin-bottom: 16px; flex-wrap: wrap;
  }
  .btn-primary { background: var(--btn-primary-bg); border-color: var(--btn-primary-hover); color: #fff; }
  .btn-primary:hover { background: var(--btn-primary-hover); }
  .spacer { flex: 1; }
  .filter-btn {
    background: var(--bg-tertiary); border: 1px solid var(--border-color); color: var(--text-muted); padding: 4px 10px;
    border-radius: 12px; cursor: pointer; font-size: 11px; font-family: inherit;
  }
  .filter-btn:hover { border-color: var(--accent); color: var(--text-primary); }
  .filter-btn.active { background: var(--accent)33; border-color: var(--accent); color: var(--accent); }

  /* Create Form */
  .create-form {
    background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px;
    padding: 16px; margin-bottom: 16px; display: none;
  }
  .create-form.show { display: block; }
  .create-form h3 { font-size: 13px; color: var(--accent); margin-bottom: 12px; }
  .form-row { display: flex; gap: 12px; margin-bottom: 10px; align-items: center; flex-wrap: wrap; }
  .form-row label { font-size: 12px; color: var(--text-muted); min-width: 80px; }
  .form-row input, .form-row select {
    background: var(--bg-primary); border: 1px solid var(--border-color); color: var(--text-primary);
    padding: 6px 10px; border-radius: 6px; font-family: inherit; font-size: 12px;
    outline: none; flex: 1; min-width: 150px;
  }
  .form-row input:focus { border-color: var(--accent); }
  .form-actions { display: flex; gap: 8px; justify-content: flex-end; }

  /* Reminder List */
  .reminder-card {
    background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px;
    padding: 14px 16px; margin-bottom: 8px; display: flex; align-items: flex-start;
    gap: 12px; transition: all 0.15s;
  }
  .reminder-card:hover { border-color: var(--text-dim); }
  .reminder-card.done { opacity: 0.5; }
  .reminder-card.overdue { border-left: 3px solid var(--color-error); }
  .reminder-card.upcoming { border-left: 3px solid var(--color-success); }
  .reminder-card.future { border-left: 3px solid var(--accent); }
  .reminder-check {
    width: 20px; height: 20px; border: 2px solid var(--border-color); border-radius: 4px;
    cursor: pointer; flex-shrink: 0; margin-top: 2px; display: flex;
    align-items: center; justify-content: center; background: none;
    color: transparent; font-size: 14px; transition: all 0.15s;
  }
  .reminder-check:hover { border-color: var(--color-success); }
  .reminder-check.checked { border-color: var(--color-success); background: var(--color-success)33; color: var(--color-success); }
  .reminder-body { flex: 1; min-width: 0; }
  .reminder-text { font-size: 13px; color: var(--text-bright); margin-bottom: 4px; word-break: break-word; }
  .reminder-card.done .reminder-text { text-decoration: line-through; color: var(--text-muted); }
  .reminder-meta { font-size: 11px; color: var(--text-muted); display: flex; gap: 12px; flex-wrap: wrap; }
  .reminder-meta .due { font-weight: 600; }
  .reminder-meta .overdue { color: var(--color-error); }
  .reminder-meta .soon { color: var(--color-warning); }
  .reminder-actions { display: flex; gap: 6px; flex-shrink: 0; }
  .reminder-actions button {
    background: none; border: 1px solid var(--border-color); color: var(--text-muted);
    padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px;
    font-family: inherit; transition: all 0.15s;
  }
  .reminder-actions button:hover { border-color: var(--accent); color: var(--text-primary); }
  .reminder-actions .del-btn:hover { border-color: var(--color-error); color: var(--color-error); }
  .empty-state {
    text-align: center; padding: 40px; color: var(--text-dim); font-size: 14px;
  }

  /* Edit inline */
  .edit-row { display: flex; gap: 8px; margin-top: 8px; }
  .edit-row input {
    background: var(--bg-primary); border: 1px solid var(--border-color); color: var(--text-primary);
    padding: 4px 8px; border-radius: 4px; font-family: inherit; font-size: 12px;
    outline: none;
  }
  .edit-row input:focus { border-color: var(--accent); }

  @media (max-width: 600px) {
    .reminder-card { flex-direction: column; gap: 8px; }
    .reminder-actions { align-self: flex-end; }
  }
</style>
</head>
<body>
<header>
  <h1>Erinnerungen</h1>
  <a href="/">Monitor</a>
  <a href="/chat">Chat</a>
  <a href="/system">System</a>
  <a href="/ha-editor">Smart Home Editor</a>
  <a href="/notes">Wissensbasis</a>
  <a href="/terminal">Terminal</a>
  <a href="/settings">Einstellungen</a>
  <a href="/community">Community</a>
  <a href="/delegations">Delegationen</a>
  <a href="/roadmap">Roadmap</a>
  <a href="/tools">Tools</a>
  <a href="/workflows">Workflows</a>
</header>

<div class="container">
  <div class="toolbar">
    <button class="btn btn-primary" id="newBtn">Neue Erinnerung</button>
    <span class="status-msg" id="statusMsg"></span>
    <span class="spacer"></span>
    <button class="filter-btn active" data-filter="active">Aktiv</button>
    <button class="filter-btn" data-filter="done">Erledigt</button>
    <button class="filter-btn" data-filter="all">Alle</button>
  </div>

  <div class="create-form" id="createForm">
    <h3>Neue Erinnerung</h3>
    <div class="form-row">
      <label>Text</label>
      <input type="text" id="formText" placeholder="Woran soll erinnert werden?">
    </div>
    <div class="form-row">
      <label>Datum</label>
      <input type="date" id="formDate">
    </div>
    <div class="form-row">
      <label>Uhrzeit</label>
      <input type="time" id="formTime" value="09:00">
    </div>
    <div class="form-row">
      <label>Typ</label>
      <select id="formType">
        <option value="text">Text-Erinnerung</option>
        <option value="task">Aufgabe (Agent führt aus)</option>
      </select>
    </div>
    <div class="form-row">
      <label>Wiederholen</label>
      <select id="formRepeat">
        <option value="none">Einmalig</option>
        <option value="1">Stündlich</option>
        <option value="24">Täglich</option>
        <option value="168">Wöchentlich</option>
      </select>
    </div>
    <div class="form-actions">
      <button class="btn" id="cancelBtn">Abbrechen</button>
      <button class="btn btn-primary" id="submitBtn">Erstellen</button>
    </div>
  </div>

  <div id="reminderList"></div>
</div>

<script>
let allReminders = [];
let currentFilter = 'active';

const listEl = document.getElementById('reminderList');
const createForm = document.getElementById('createForm');
const statusMsg = document.getElementById('statusMsg');

function showStatus(msg, isError) {
  statusMsg.textContent = msg;
  statusMsg.className = 'status-msg show' + (isError ? ' error' : '');
  setTimeout(() => statusMsg.classList.remove('show'), 3000);
}

function escapeHtml(s) {
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })
      + ' ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

function getStatus(r) {
  if (r.done) return 'done';
  const now = new Date();
  const due = new Date(r.due);
  if (due <= now) return 'overdue';
  const diff = due - now;
  if (diff < 24 * 60 * 60 * 1000) return 'upcoming';
  return 'future';
}

async function loadReminders() {
  try {
    const res = await fetch('/api/reminders');
    allReminders = await res.json();
    renderList();
  } catch (err) { showStatus('Fehler: ' + err.message, true); }
}

function renderList() {
  let filtered = allReminders;
  if (currentFilter === 'active') filtered = allReminders.filter(r => !r.done);
  else if (currentFilter === 'done') filtered = allReminders.filter(r => r.done);

  // Sort: overdue first, then by due date asc
  filtered.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return new Date(a.due) - new Date(b.due);
  });

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="empty-state">' +
      (currentFilter === 'active' ? 'Keine aktiven Erinnerungen' :
       currentFilter === 'done' ? 'Keine erledigten Erinnerungen' : 'Keine Erinnerungen') + '</div>';
    return;
  }

  listEl.innerHTML = filtered.map(r => {
    const status = getStatus(r);
    const dueClass = status === 'overdue' ? ' overdue' : (status === 'upcoming' ? ' soon' : '');
    const statusLabel = status === 'overdue' ? ' (überfällig)' : (status === 'upcoming' ? ' (bald)' : '');
    const typeBadge = r.type === 'task' ? '<span style="background:var(--accent)33;color:var(--accent);padding:1px 6px;border-radius:4px;font-size:10px;margin-left:6px">Aufgabe</span>' : '';
    let intervalLabel = '';
    if (r.interval_hours) {
      const h = r.interval_hours;
      if (h % 24 === 0 && h >= 24) intervalLabel = '<span style="color:var(--color-warning);margin-left:6px;font-size:10px">\\u27F3 alle ' + (h/24) + 'd</span>';
      else intervalLabel = '<span style="color:var(--color-warning);margin-left:6px;font-size:10px">\\u27F3 alle ' + h + 'h</span>';
    }
    const pausedLabel = (r.failCount >= 3) ? '<span style="color:var(--color-error);margin-left:6px;font-size:10px">\\u26A0 pausiert</span>' : '';
    return '<div class="reminder-card ' + status + '" data-id="' + r.id + '">' +
      '<button class="reminder-check' + (r.done ? ' checked' : '') + '" onclick="toggleDone(' + r.id + ')">' +
      (r.done ? '\\u2713' : '') + '</button>' +
      '<div class="reminder-body">' +
      '<div class="reminder-text">' + escapeHtml(r.text) + typeBadge + intervalLabel + pausedLabel + '</div>' +
      '<div class="reminder-meta">' +
      '<span class="due' + dueClass + '">' + formatDate(r.due) + statusLabel + '</span>' +
      '<span>Erstellt: ' + formatDate(r.created) + '</span>' +
      '</div></div>' +
      '<div class="reminder-actions">' +
      '<button onclick="editReminder(' + r.id + ')">Bearbeiten</button>' +
      '<button class="del-btn" onclick="deleteReminder(' + r.id + ')">Löschen</button>' +
      '</div></div>';
  }).join('');
}

async function toggleDone(id) {
  const r = allReminders.find(x => x.id === id);
  if (!r) return;
  try {
    await fetch('/api/reminders/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: !r.done })
    });
    showStatus(r.done ? 'Reaktiviert' : 'Erledigt!', false);
    loadReminders();
  } catch (err) { showStatus('Fehler: ' + err.message, true); }
}

async function deleteReminder(id) {
  const r = allReminders.find(x => x.id === id);
  if (!confirm('Erinnerung "' + (r ? r.text : id) + '" löschen?')) return;
  try {
    await fetch('/api/reminders/' + id, { method: 'DELETE' });
    showStatus('Gelöscht', false);
    loadReminders();
  } catch (err) { showStatus('Fehler: ' + err.message, true); }
}

function editReminder(id) {
  const r = allReminders.find(x => x.id === id);
  if (!r) return;
  const card = document.querySelector('[data-id="' + id + '"]');
  if (!card || card.querySelector('.edit-row')) return;

  const due = new Date(r.due);
  const dateStr = due.toISOString().split('T')[0];
  const timeStr = due.toTimeString().substring(0, 5);

  const editHtml = '<div class="edit-row">' +
    '<input type="text" class="edit-text" value="' + escapeHtml(r.text) + '" style="flex:2">' +
    '<input type="date" class="edit-date" value="' + dateStr + '">' +
    '<input type="time" class="edit-time" value="' + timeStr + '">' +
    '<button class="btn btn-primary" onclick="saveEdit(' + id + ')">OK</button>' +
    '<button class="btn" onclick="loadReminders()">X</button>' +
    '</div>';
  card.querySelector('.reminder-body').insertAdjacentHTML('beforeend', editHtml);
}

async function saveEdit(id) {
  const card = document.querySelector('[data-id="' + id + '"]');
  const text = card.querySelector('.edit-text').value;
  const date = card.querySelector('.edit-date').value;
  const time = card.querySelector('.edit-time').value;
  if (!text || !date || !time) return;
  try {
    await fetch('/api/reminders/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, due: date + 'T' + time + ':00' })
    });
    showStatus('Gespeichert!', false);
    loadReminders();
  } catch (err) { showStatus('Fehler: ' + err.message, true); }
}

async function createReminder() {
  const text = document.getElementById('formText').value.trim();
  const date = document.getElementById('formDate').value;
  const time = document.getElementById('formTime').value;
  const type = document.getElementById('formType').value;
  const repeat = document.getElementById('formRepeat').value;
  if (!text || !date || !time) { showStatus('Text, Datum und Uhrzeit erforderlich', true); return; }

  const entry = { text, due: date + 'T' + time + ':00', type };
  if (repeat !== 'none') entry.interval_hours = parseInt(repeat);

  try {
    await fetch('/api/reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry)
    });
    showStatus('Erinnerung erstellt', false);
    createForm.classList.remove('show');
    document.getElementById('formText').value = '';
    loadReminders();
  } catch (err) { showStatus('Fehler: ' + err.message, true); }
}

// Events
document.getElementById('newBtn').addEventListener('click', () => {
  createForm.classList.toggle('show');
  if (createForm.classList.contains('show')) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    document.getElementById('formDate').value = tomorrow.toISOString().split('T')[0];
    document.getElementById('formText').focus();
  }
});
document.getElementById('cancelBtn').addEventListener('click', () => createForm.classList.remove('show'));
document.getElementById('submitBtn').addEventListener('click', createReminder);

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    renderList();
  });
});

loadReminders();
</script>
</body>
</html>`;
}

// --- Reminders API Handlers (nutzt db.reminders statt JSON-Datei) ---

// const REMINDERS_FILE = path.join(__dirname, "reminders.json");
// function loadReminders() { try { return JSON.parse(fs.readFileSync(REMINDERS_FILE, "utf-8")); } catch { return []; } }
// function saveReminders(reminders) { fs.writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2), "utf-8"); }

function handleRemindersList(req, res) {
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(db.reminders.getAll()));
}

function handleReminderCreate(req, res) {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (!body.text || !body.due) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "text und due erforderlich" }));
        return;
      }
      const reminder = db.reminders.create(body);
      originalLog("[Monitor] Erinnerung erstellt: " + body.text);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, reminder }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

function handleReminderUpdate(req, res, id) {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const updated = db.reminders.update(id, body);
      if (!updated) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Erinnerung nicht gefunden" }));
        return;
      }
      originalLog("[Monitor] Erinnerung aktualisiert: " + updated.text);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, reminder: updated }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

function handleReminderDelete(req, res, id) {
  const existing = db.reminders.getById(id);
  if (!existing) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Erinnerung nicht gefunden" }));
    return;
  }
  db.reminders.remove(id);
  originalLog("[Monitor] Erinnerung gelöscht: " + existing.text);
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify({ ok: true }));
}

// --- HA File API Handlers ---

const HA_EDITABLE_FILES = ['ha-devices-compact.md', 'ha-devices.md'];

function handleHaFileRead(req, res, filename) {
  if (!HA_EDITABLE_FILES.includes(filename)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Datei nicht erlaubt" }));
    return;
  }
  const filePath = path.join(__dirname, filename);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ file: filename, content }));
  } catch (err) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Datei nicht gefunden: " + filename }));
  }
}

function handleHaFileWrite(req, res, filename) {
  if (!HA_EDITABLE_FILES.includes(filename)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Datei nicht erlaubt" }));
    return;
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (!body.content && body.content !== "") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "content fehlt" }));
        return;
      }
      const filePath = path.join(__dirname, filename);
      fs.writeFileSync(filePath, body.content, "utf-8");
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, file: filename }));
      originalLog(`[Monitor] HA-Datei gespeichert: ${filename}`);
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Ungültiger Body: " + err.message }));
    }
  });
}

function handleHaRegenerate(req, res) {
  const { execFile } = require("child_process");
  const scriptPath = path.join(__dirname, "scripts", "generate-ha-devices.js");

  execFile("node", [scriptPath], { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Regenerierung fehlgeschlagen: " + (stderr || err.message) }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true, message: stdout.trim() }));
    originalLog("[Monitor] HA-Geräteliste regeneriert");
  });
}

// --- Settings API Handlers ---

function handleSettingsRead(req, res) {
  try {
    const envPath = path.join(__dirname, ".env");
    const content = fs.readFileSync(envPath, "utf-8");
    const settings = {};
    content.split("\n").forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) return;
      const key = trimmed.substring(0, eqIdx).trim();
      const value = trimmed.substring(eqIdx + 1).trim();
      settings[key] = value;
    });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(settings));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Fehler beim Lesen: " + err.message }));
  }
}

function handleSettingsWrite(req, res) {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    try {
      const newValues = JSON.parse(Buffer.concat(chunks).toString());
      const envPath = path.join(__dirname, ".env");
      const content = fs.readFileSync(envPath, "utf-8");
      const lines = content.split("\n");
      const updatedKeys = new Set();
      const changedKeys = [];

      // Map over existing lines, replacing values for matching keys
      const newLines = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) return line;
        const key = trimmed.substring(0, eqIdx).trim();
        if (key in newValues) {
          updatedKeys.add(key);
          const oldVal = trimmed.substring(eqIdx + 1).trim();
          if (oldVal !== newValues[key]) {
            changedKeys.push(key);
          }
          return key + "=" + newValues[key];
        }
        return line;
      });

      // Append new keys that weren't in the file
      Object.keys(newValues).forEach(key => {
        if (!updatedKeys.has(key) && newValues[key]) {
          newLines.push(key + "=" + newValues[key]);
          changedKeys.push(key);
        }
      });

      fs.writeFileSync(envPath, newLines.join("\n"), "utf-8");

      if (changedKeys.length > 0) {
        originalLog("[Monitor] Settings geändert: " + changedKeys.join(", "));
      }

      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, changed: changedKeys }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });
}

function handleRestart(req, res) {
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify({ ok: true }));
  originalLog("[Monitor] Neustart angefordert...");
  setTimeout(() => { try { db.close(); } catch {} process.exit(0); }, 500);
}

// --- PWA Manifest + Service Worker ---

function getManifestJSON() {
  const theme = getActiveTheme();
  const bgColor = theme === "tron" ? "#05070A" : "#0d1117";
  return JSON.stringify({
    name: "${BOT_NAME} Chat",
    short_name: "${BOT_NAME}",
    start_url: "/chat",
    display: "standalone",
    background_color: bgColor,
    theme_color: bgColor,
    icons: [
      {
        src: "/favicon/web-app-manifest-192x192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/favicon/web-app-manifest-512x512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  });
}

function getServiceWorkerJS() {
  return `const CACHE = "jarvis-chat-v1";
const SHELL = ["/chat"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.url.includes("/api/")) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});`;
}

// --- Chat API ---

function handleChatSend(req, res) {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const msg = (body.message || "").trim();
      if (!msg) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Nachricht fehlt" }));
        return;
      }
      const result = await agent.handleMessage("web-chat", msg);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ text: result.text, images: result.images || [] }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

function handleChatHistory(req, res) {
  try {
    const history = agent.getHistory("web-chat");
    const messages = [];
    for (const msg of history) {
      if (msg.role === "user" && typeof msg.content === "string") {
        messages.push({ role: "user", text: msg.content, ts: msg.ts || null });
      } else if (msg.role === "assistant") {
        let text = "";
        if (typeof msg.content === "string") {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = msg.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");
        }
        if (text) messages.push({ role: "assistant", text, ts: msg.ts || null });
      }
    }
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ messages }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}

function handleChatClear(req, res) {
  try {
    agent.clearHistory("web-chat");
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}

function handleChatVoice(req, res) {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    try {
      const audioFile = path.join(TEMP_DIR, `chat_voice_${Date.now()}.webm`);
      fs.writeFileSync(audioFile, Buffer.concat(chunks));
      const transcript = voice.transcribe(audioFile);
      try { fs.unlinkSync(audioFile); } catch {}
      if (!transcript) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Transkription fehlgeschlagen" }));
        return;
      }
      const result = await agent.handleMessage("web-chat", `[Sprachnachricht]: ${transcript}`);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ transcript, text: result.text, images: result.images || [] }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

function handleChatTTS(req, res) {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const text = (body.text || "").trim();
      if (!text) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Text fehlt" }));
        return;
      }
      const oggFile = voice.textToSpeech(text);
      if (!oggFile || !fs.existsSync(oggFile)) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "TTS fehlgeschlagen" }));
        return;
      }
      const audio = fs.readFileSync(oggFile);
      try { fs.unlinkSync(oggFile); } catch {}
      res.writeHead(200, {
        "Content-Type": "audio/ogg",
        "Content-Length": audio.length,
        "Access-Control-Allow-Origin": "*",
      });
      res.end(audio);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

function handleChatImage(req, res, filename) {
  const safeName = path.basename(filename);
  const filePath = path.join(TEMP_DIR, safeName);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(safeName).toLowerCase();
  const mimeTypes = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
  const contentType = mimeTypes[ext] || "application/octet-stream";
  const data = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": contentType, "Content-Length": data.length, "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" });
  res.end(data);
}

// --- Uptime Formatierung ---

function formatUptime() {
  const diff = Math.floor((Date.now() - startTime) / 1000);
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// --- System Info ---

function getSystemInfo() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = Math.round((usedMem / totalMem) * 100);

  // Disk usage via df
  let disk = { total: "-", used: "-", free: "-", percent: 0 };
  try {
    const dfOut = execSync("df -h / | tail -1", { encoding: "utf-8" }).trim();
    const parts = dfOut.split(/\s+/);
    disk = { total: parts[1], used: parts[2], free: parts[3], percent: parseInt(parts[4]) || 0 };
  } catch {}

  // System uptime
  const uptimeSec = os.uptime();
  const days = Math.floor(uptimeSec / 86400);
  const hours = Math.floor((uptimeSec % 86400) / 3600);
  const mins = Math.floor((uptimeSec % 3600) / 60);
  const sysUptime = (days > 0 ? days + "d " : "") + hours + "h " + mins + "m";

  // Process uptime
  const procSec = Math.floor(process.uptime());
  const pH = Math.floor(procSec / 3600);
  const pM = Math.floor((procSec % 3600) / 60);
  const procUptime = (pH > 0 ? pH + "h " : "") + pM + "m";

  const mem = process.memoryUsage();
  const formatMB = (bytes) => (bytes / 1024 / 1024).toFixed(1) + " MB";
  const formatGB = (bytes) => (bytes / 1024 / 1024 / 1024).toFixed(1) + " GB";

  // Temperatures & fans via lm-sensors
  let sensors = { temps: [], fans: [] };
  try {
    const sData = JSON.parse(execSync("sensors -j 2>/dev/null", { encoding: "utf-8", timeout: 3000 }));
    for (const [chip, data] of Object.entries(sData)) {
      const adapter = data.Adapter || "";
      for (const [label, values] of Object.entries(data)) {
        if (label === "Adapter") continue;
        for (const [key, val] of Object.entries(values)) {
          if (key.includes("_input") && key.startsWith("temp")) {
            const max = values[key.replace("_input", "_max")] || null;
            const crit = values[key.replace("_input", "_crit")] || null;
            sensors.temps.push({ chip, label, value: val, max, crit });
          } else if (key.includes("_input") && key.startsWith("fan") && val > 0) {
            sensors.fans.push({ chip, label, value: val });
          }
        }
      }
    }
  } catch {}

  return {
    cpu: { model: cpus[0]?.model || "-", cores: cpus.length, loadAvg: os.loadavg().map(v => +v.toFixed(2)) },
    memory: { total: formatGB(totalMem), used: formatGB(usedMem), free: formatGB(freeMem), percent: memPercent },
    disk,
    uptime: { system: sysUptime, process: procUptime },
    node: { heapUsed: formatMB(mem.heapUsed), heapTotal: formatMB(mem.heapTotal), rss: formatMB(mem.rss) },
    sensors,
  };
}

// --- HTTP Basic Auth ---

function checkAuth(req, res) {
  const user = process.env.MONITOR_USER;
  const pass = process.env.MONITOR_PASS;
  if (!user && !pass) return true; // Auth deaktiviert wenn nicht konfiguriert

  const header = req.headers.authorization;
  if (header && header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString();
    const [u, p] = decoded.split(":");
    if (u === user && p === pass) return true;
  }

  res.writeHead(401, {
    "WWW-Authenticate": `Basic realm="${BOT_NAME} Monitor"`,
    "Content-Type": "text/plain",
  });
  res.end("401 Unauthorized");
  return false;
}

// --- HTTP Server ---

function startMonitor(port) {
  port = parseInt(port) || 3333;

  const sslOptions = {
    key: fs.readFileSync(path.join(__dirname, "certs", "key.pem")),
    cert: fs.readFileSync(path.join(__dirname, "certs", "cert.pem")),
  };

  const server = https.createServer(sslOptions, (req, res) => {
    // CORS Preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    // Favicon-Dateien aus public/favicon/ servieren (kein Auth)
    if (req.url.startsWith("/favicon/") || req.url === "/favicon.ico" || req.url === "/site.webmanifest") {
      const faviconMap = {
        "/favicon.ico": "public/favicon/favicon.ico",
        "/site.webmanifest": "public/favicon/site.webmanifest",
      };
      const filePath = faviconMap[req.url] || path.join("public", req.url);
      const fullPath = path.join(__dirname, filePath);
      if (fs.existsSync(fullPath)) {
        const ext = path.extname(fullPath).toLowerCase();
        const mimeTypes = {
          ".ico": "image/x-icon", ".svg": "image/svg+xml", ".png": "image/png",
          ".webmanifest": "application/manifest+json", ".json": "application/json",
        };
        const data = fs.readFileSync(fullPath);
        res.writeHead(200, {
          "Content-Type": mimeTypes[ext] || "application/octet-stream",
          "Content-Length": data.length,
          "Cache-Control": "public, max-age=604800",
        });
        res.end(data);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
      return;
    }

    // Öffentliche Downloads — kein Auth nötig
    const publicFiles = {
      "/install.sh": { file: "scripts/install.sh", type: "text/plain; charset=utf-8" },
      "/HOWTO.md": { file: "HOWTO.md", type: "text/markdown; charset=utf-8" },
    };
    if (publicFiles[req.url]) {
      const { file, type } = publicFiles[req.url];
      const filePath = path.join(__dirname, file);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const filename = path.basename(file);
        res.writeHead(200, {
          "Content-Type": type,
          "Content-Disposition": `attachment; filename="${filename}"`,
        });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end(`${path.basename(file)} not found`);
      }
      return;
    }

    // Auth-Check für alle Routen außer CORS Preflight
    if (!checkAuth(req, res)) return;

    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getDashboardHTML());
    } else if (req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write(":\n\n"); // SSE comment to keep alive
      clients.add(res);
      req.on("close", () => clients.delete(res));
    } else if (req.url === "/api/history") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({
        events,
        uptime: formatUptime(),
        model: ((p) => { switch(p) { case "ollama": return process.env.OLLAMA_MODEL; case "groq": return process.env.GROQ_MODEL; case "openai": return process.env.OPENAI_MODEL; default: return process.env.CLAUDE_MODEL; } })((process.env.LLM_PROVIDER || "").toLowerCase()) || "unbekannt",
        clients: clients.size,
      }));
    } else if (req.url === "/api/system") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(getSystemInfo()));
    // --- Cleanup ---
    } else if (req.url === "/api/cleanup" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(getCleanupInfo()));
    } else if (req.url === "/api/cleanup" && req.method === "POST") {
      handleCleanup(req, res);

    // --- HA Editor ---
    } else if (req.url === "/system") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getSystemHTML());
    } else if (req.url === "/ha-editor") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getEditorHTML());
    } else if (req.url.startsWith("/api/ha-files/") && req.method === "GET") {
      const filename = decodeURIComponent(req.url.replace("/api/ha-files/", ""));
      handleHaFileRead(req, res, filename);
    } else if (req.url.startsWith("/api/ha-files/") && req.method === "PUT") {
      const filename = decodeURIComponent(req.url.replace("/api/ha-files/", ""));
      handleHaFileWrite(req, res, filename);
    } else if (req.url === "/api/ha-regenerate" && req.method === "POST") {
      handleHaRegenerate(req, res);

    // --- Workflows ---
    } else if (req.url === "/workflows") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getWorkflowsHTML());
    } else if (req.url === "/api/workflows" && req.method === "GET") {
      handleWorkflowsList(req, res);
    } else if (req.url.startsWith("/api/workflows/") && req.method === "GET") {
      const id = decodeURIComponent(req.url.replace("/api/workflows/", ""));
      handleWorkflowGet(req, res, id);
    } else if (req.url.startsWith("/api/workflows/") && req.method === "PUT") {
      const id = decodeURIComponent(req.url.replace("/api/workflows/", ""));
      handleWorkflowUpdate(req, res, id);
    } else if (req.url.startsWith("/api/workflows/") && req.method === "DELETE") {
      const id = decodeURIComponent(req.url.replace("/api/workflows/", ""));
      handleWorkflowDelete(req, res, id);

    // --- Tools ---
    } else if (req.url === "/tools") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getToolsHTML());
    } else if (req.url === "/api/tools" && req.method === "GET") {
      handleToolsList(req, res);
    } else if (req.url === "/api/tools/generate" && req.method === "POST") {
      handleToolGenerate(req, res);
    } else if (req.url === "/api/tools" && req.method === "POST") {
      handleToolCreate(req, res);
    } else if (req.url.match(/^\/api\/tools\/[^/]+\/toggle$/) && req.method === "POST") {
      const filename = decodeURIComponent(req.url.replace("/api/tools/", "").replace("/toggle", ""));
      handleToolToggle(req, res, filename);
    } else if (req.url.match(/^\/api\/tools\/[^/]+\/visibility$/) && req.method === "PUT") {
      const filename = decodeURIComponent(req.url.replace("/api/tools/", "").replace("/visibility", ""));
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => {
        try {
          const { visibility } = JSON.parse(Buffer.concat(chunks).toString());
          db.toolSettings.setVisibility(filename, visibility);
          // .gitignore aktualisieren: private Tools ausschließen
          try {
            const gitignorePath = path.join(__dirname, ".gitignore");
            let gitignore = fs.readFileSync(gitignorePath, "utf-8");
            const entry = "tools/" + filename;
            if (visibility === "private" && !gitignore.includes(entry)) {
              gitignore = gitignore.trimEnd() + "\n" + entry + "\n";
              fs.writeFileSync(gitignorePath, gitignore);
            } else if (visibility === "public" && gitignore.includes(entry)) {
              gitignore = gitignore.split("\n").filter(l => l.trim() !== entry).join("\n");
              fs.writeFileSync(gitignorePath, gitignore);
            }
          } catch {}
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: true, visibility }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    } else if (req.url.match(/^\/api\/tools\/[^/]+\/download$/) && req.method === "GET") {
      const filename = decodeURIComponent(req.url.replace("/api/tools/", "").replace("/download", ""));
      const filePath = path.join(TOOLS_DIR, filename);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Tool nicht gefunden" }));
        return;
      }
      // ZIP erstellen mit archiver-ähnlichem Ansatz (manuelles ZIP)
      const { execSync } = require("child_process");
      const zipPath = path.join(__dirname, "temp", filename.replace(".js", ".zip"));
      try {
        execSync(`cd "${TOOLS_DIR}" && zip -j "${zipPath}" "${filename}" 2>/dev/null`);
        const zipData = fs.readFileSync(zipPath);
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${filename.replace(".js", ".zip")}"`,
        });
        res.end(zipData);
        try { fs.unlinkSync(zipPath); } catch {}
      } catch (e) {
        // Fallback: direkt als .js senden
        const content = fs.readFileSync(filePath);
        res.writeHead(200, {
          "Content-Type": "application/javascript",
          "Content-Disposition": `attachment; filename="${filename}"`,
        });
        res.end(content);
      }
    } else if (req.url === "/api/tools/upload" && req.method === "POST") {
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => {
        try {
          const body = Buffer.concat(chunks);
          const contentType = req.headers["content-type"] || "";
          const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
          if (!boundaryMatch) throw new Error("Kein multipart boundary");
          const boundary = boundaryMatch[1] || boundaryMatch[2];
          const delimBuf = Buffer.from("--" + boundary);
          let fileData = null;
          let uploadFilename = null;
          let start = 0;
          while (start < body.length) {
            const idx = body.indexOf(delimBuf, start);
            if (idx === -1) break;
            const nextIdx = body.indexOf(delimBuf, idx + delimBuf.length);
            if (nextIdx === -1) break;
            const part = body.slice(idx + delimBuf.length, nextIdx);
            const headerEnd = part.indexOf("\r\n\r\n");
            if (headerEnd === -1) { start = nextIdx; continue; }
            const headers = part.slice(0, headerEnd).toString();
            const fnMatch = headers.match(/filename="([^"]+)"/);
            if (fnMatch) {
              uploadFilename = fnMatch[1];
              fileData = part.slice(headerEnd + 4);
              if (fileData.length > 2 && fileData[fileData.length - 2] === 0x0d && fileData[fileData.length - 1] === 0x0a) {
                fileData = fileData.slice(0, -2);
              }
              break;
            }
            start = nextIdx;
          }
          if (!fileData || !uploadFilename) throw new Error("Keine Datei gefunden");

          // ZIP oder .js?
          if (uploadFilename.endsWith(".zip")) {
            const zipPath = path.join(__dirname, "temp", "upload_" + Date.now() + ".zip");
            fs.writeFileSync(zipPath, fileData);
            const { execSync } = require("child_process");
            execSync(`cd "${TOOLS_DIR}" && unzip -o "${zipPath}" "*.js" 2>/dev/null`);
            const extracted = execSync(`unzip -l "${zipPath}" 2>/dev/null`, { encoding: "utf-8" });
            const jsMatch = extracted.match(/(\S+\.js)/);
            try { fs.unlinkSync(zipPath); } catch {}
            const extractedName = jsMatch ? jsMatch[1] : "uploaded-tool.js";
            db.toolSettings.register(extractedName);
            res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ ok: true, filename: extractedName }));
          } else if (uploadFilename.endsWith(".js")) {
            const targetPath = path.join(TOOLS_DIR, uploadFilename);
            fs.writeFileSync(targetPath, fileData);
            db.toolSettings.register(uploadFilename);
            res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ ok: true, filename: uploadFilename }));
          } else {
            throw new Error("Nur .zip oder .js Dateien erlaubt");
          }
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    } else if (req.url.startsWith("/api/tools/") && req.method === "GET") {
      const filename = decodeURIComponent(req.url.replace("/api/tools/", ""));
      handleToolRead(req, res, filename);
    } else if (req.url.startsWith("/api/tools/") && req.method === "PUT") {
      const filename = decodeURIComponent(req.url.replace("/api/tools/", ""));
      handleToolWrite(req, res, filename);
    } else if (req.url.startsWith("/api/tools/") && req.method === "DELETE") {
      const filename = decodeURIComponent(req.url.replace("/api/tools/", ""));
      handleToolDelete(req, res, filename);

    // --- Ollama Model Manager ---
    } else if (req.url.startsWith("/api/ollama/models") && req.method === "GET") {
      const params = new URL(req.url, "http://localhost").searchParams;
      const base = params.get("base") || "http://localhost:11434";
      const axios = require("axios");
      axios.get(`${base}/api/tags`, { timeout: 5000 }).then(resp => {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(resp.data));
      }).catch(e => {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Ollama nicht erreichbar: " + e.message }));
      });
    } else if (req.url.startsWith("/api/ollama/models") && req.method === "POST") {
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => {
        const { base, name } = JSON.parse(Buffer.concat(chunks).toString());
        const baseUrl = base || "http://localhost:11434";
        const axios = require("axios");
        axios.post(`${baseUrl}/api/pull`, { name, stream: false }, { timeout: 300000 }).then(() => {
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: true }));
        }).catch(e => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.response?.data?.error || e.message }));
        });
      });
    } else if (req.url.startsWith("/api/ollama/models") && req.method === "DELETE") {
      const params = new URL(req.url, "http://localhost").searchParams;
      const base = params.get("base") || "http://localhost:11434";
      const name = params.get("name");
      const axios = require("axios");
      axios.delete(`${base}/api/delete`, { data: { name }, timeout: 10000 }).then(() => {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: true }));
      }).catch(e => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.response?.data?.error || e.message }));
      });

    // --- Community Chat ---
    } else if (req.url === "/community") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getCommunityHTML());

    // --- Delegations ---
    } else if (req.url === "/delegations") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getDelegationsHTML());
    } else if (req.url === "/api/delegations" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(db.delegations.getAll()));
    } else if (req.url.match(/^\/api\/delegations\/\d+\/tasks\/\d+$/) && req.method === "PUT") {
      const parts = req.url.match(/\/api\/delegations\/(\d+)\/tasks\/(\d+)/);
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          db.delegations.updateTaskStatus(parseInt(parts[2]), body.status);
          if (body.status === "done") db.delegations.checkAutoComplete(parseInt(parts[1]));
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    } else if (req.url.match(/^\/api\/delegations\/\d+$/) && req.method === "DELETE") {
      const id = parseInt(req.url.replace("/api/delegations/", ""));
      db.delegations.remove(id);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true }));

    // --- Roadmap ---
    } else if (req.url === "/roadmap") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getRoadmapHTML());
    } else if (req.url === "/api/roadmap" && req.method === "GET") {
      handleRoadmapList(req, res);
    } else if (req.url === "/api/roadmap" && req.method === "POST") {
      handleRoadmapCreate(req, res);
    } else if (req.url.startsWith("/api/roadmap/") && req.method === "PUT") {
      const id = parseInt(req.url.replace("/api/roadmap/", ""));
      handleRoadmapUpdate(req, res, id);
    } else if (req.url.startsWith("/api/roadmap/") && req.method === "DELETE") {
      const id = parseInt(req.url.replace("/api/roadmap/", ""));
      handleRoadmapDelete(req, res, id);

    // --- Terminal ---
    } else if (req.url === "/terminal") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getTerminalHTML());
    } else if (req.url === "/api/terminal" && req.method === "POST") {
      handleTerminalExec(req, res);
    } else if (req.url === "/api/terminal/action" && req.method === "POST") {
      handleTerminalAction(req, res);
    } else if (req.url === "/api/terminal/status" && req.method === "GET") {
      handleTerminalStatus(req, res);
    } else if (req.url === "/api/terminal/session" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ log: db.terminal.getLog(), cwd: db.terminal.getCwd(), history: db.terminal.getHistory() }));
    } else if (req.url === "/api/terminal/session" && req.method === "POST") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          if (body.history) db.terminal.setHistory(body.history);
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    } else if (req.url === "/api/terminal/session" && req.method === "DELETE") {
      db.terminal.clear();
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true }));

    // --- Reminders / Erinnerungen ---
    } else if (req.url === "/reminders") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getRemindersHTML());
    } else if (req.url === "/api/reminders" && req.method === "GET") {
      handleRemindersList(req, res);
    } else if (req.url === "/api/reminders" && req.method === "POST") {
      handleReminderCreate(req, res);
    } else if (req.url.startsWith("/api/reminders/") && req.method === "PUT") {
      const id = parseInt(req.url.replace("/api/reminders/", ""));
      handleReminderUpdate(req, res, id);
    } else if (req.url.startsWith("/api/reminders/") && req.method === "DELETE") {
      const id = parseInt(req.url.replace("/api/reminders/", ""));
      handleReminderDelete(req, res, id);

    // --- Notes / Wissensbasis ---
    } else if (req.url === "/notes") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getNotesHTML());
    } else if (req.url === "/api/notes" && req.method === "GET") {
      handleNotesList(req, res);
    } else if (req.url === "/api/notes" && req.method === "POST") {
      handleNoteCreate(req, res);
    } else if (req.url === "/api/notes/upload" && req.method === "POST") {
      handleNoteUpload(req, res);
    } else if (req.url === "/api/notes/sync" && req.method === "POST") {
      handleNoteSync(req, res);
    } else if (req.url.startsWith("/api/notes/") && req.method === "GET") {
      const filename = decodeURIComponent(req.url.replace("/api/notes/", ""));
      handleNoteRead(req, res, filename);
    } else if (req.url.startsWith("/api/notes/") && req.method === "PUT") {
      const filename = decodeURIComponent(req.url.replace("/api/notes/", ""));
      handleNoteWrite(req, res, filename);
    } else if (req.url.startsWith("/api/notes/") && req.method === "DELETE") {
      const filename = decodeURIComponent(req.url.replace("/api/notes/", ""));
      handleNoteDelete(req, res, filename);

    // --- Chat ---
    } else if (req.url === "/chat") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getChatHTML());
    } else if (req.url === "/manifest.json") {
      res.writeHead(200, { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=86400" });
      res.end(getManifestJSON());
    } else if (req.url === "/sw.js") {
      res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-cache" });
      res.end(getServiceWorkerJS());
    } else if (req.url === "/api/chat/send" && req.method === "POST") {
      handleChatSend(req, res);
    } else if (req.url === "/api/chat/history" && req.method === "GET") {
      handleChatHistory(req, res);
    } else if (req.url === "/api/chat/clear" && req.method === "POST") {
      handleChatClear(req, res);
    } else if (req.url === "/api/chat/voice" && req.method === "POST") {
      handleChatVoice(req, res);
    } else if (req.url === "/api/chat/tts" && req.method === "POST") {
      handleChatTTS(req, res);
    } else if (req.url.startsWith("/api/chat/images/") && req.method === "GET") {
      const filename = decodeURIComponent(req.url.replace("/api/chat/images/", ""));
      handleChatImage(req, res, filename);

    // --- Theme API ---
    } else if (req.url === "/api/theme" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ theme: getActiveTheme(), vars: THEME_VARS }));
    } else if (req.url === "/api/theme" && req.method === "PUT") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          const all = getAllThemes();
          if (!all[body.theme]) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Unbekanntes Theme" }));
            return;
          }
          db.db.prepare("INSERT OR REPLACE INTO terminal_state (key, value) VALUES (?, ?)").run("theme", body.theme);
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: true, theme: body.theme }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
    } else if (req.url === "/api/themes" && req.method === "GET") {
      const all = getAllThemes();
      const builtinNames = Object.keys(BUILTIN_THEMES);
      const result = {};
      for (const [name, vars] of Object.entries(all)) {
        result[name] = { vars, builtin: builtinNames.includes(name) };
      }
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ themes: result, active: getActiveTheme(), varDefs: THEME_VARS }));
    } else if (req.url === "/api/themes" && req.method === "POST") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          if (!body.name || !body.vars) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "name und vars erforderlich" }));
            return;
          }
          const slug = body.name.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").substring(0, 30);
          if (BUILTIN_THEMES[slug]) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Name kollidiert mit eingebautem Theme" }));
            return;
          }
          const custom = getCustomThemes();
          custom[slug] = body.vars;
          saveCustomThemes(custom);
          originalLog("[Monitor] Custom Theme erstellt: " + slug);
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: true, name: slug }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    } else if (req.url.startsWith("/api/themes/") && req.method === "PUT") {
      const name = decodeURIComponent(req.url.replace("/api/themes/", ""));
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          if (BUILTIN_THEMES[name]) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Eingebaute Themes können nicht bearbeitet werden" }));
            return;
          }
          const custom = getCustomThemes();
          if (!custom[name]) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Theme nicht gefunden" }));
            return;
          }
          custom[name] = body.vars || custom[name];
          saveCustomThemes(custom);
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    } else if (req.url.startsWith("/api/themes/") && req.method === "DELETE") {
      const name = decodeURIComponent(req.url.replace("/api/themes/", ""));
      if (BUILTIN_THEMES[name]) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Eingebaute Themes können nicht gelöscht werden" }));
        return;
      }
      const custom = getCustomThemes();
      if (!custom[name]) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Theme nicht gefunden" }));
        return;
      }
      delete custom[name];
      saveCustomThemes(custom);
      if (getActiveTheme() === name) {
        db.db.prepare("INSERT OR REPLACE INTO terminal_state (key, value) VALUES (?, ?)").run("theme", "tron");
      }
      originalLog("[Monitor] Custom Theme gelöscht: " + name);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true }));
    } else if (req.url === "/theme-editor") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getThemeEditorHTML());

    // --- Avatar ---
    } else if (req.url === "/api/avatar" && req.method === "GET") {
      const avatarPath = path.join(__dirname, "avatar.png");
      if (fs.existsSync(avatarPath)) {
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-cache" });
        res.end(fs.readFileSync(avatarPath));
      } else {
        res.writeHead(404);
        res.end("No avatar");
      }
    } else if (req.url === "/api/avatar" && req.method === "POST") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", async () => {
        try {
          const body = Buffer.concat(chunks);
          const contentType = req.headers["content-type"] || "";
          const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
          if (!boundaryMatch) throw new Error("Kein multipart boundary");
          const boundary = boundaryMatch[1] || boundaryMatch[2];

          // Binäres Splitting am Boundary
          const delimBuf = Buffer.from("--" + boundary);
          let imageData = null;
          let start = 0;
          while (start < body.length) {
            const idx = body.indexOf(delimBuf, start);
            if (idx === -1) break;
            const nextIdx = body.indexOf(delimBuf, idx + delimBuf.length);
            if (nextIdx === -1) break;
            const part = body.slice(idx + delimBuf.length, nextIdx);
            const headerEnd = part.indexOf("\r\n\r\n");
            if (headerEnd === -1) { start = nextIdx; continue; }
            const headers = part.slice(0, headerEnd).toString();
            if (headers.includes("filename=")) {
              imageData = part.slice(headerEnd + 4);
              // Trailing \r\n entfernen
              if (imageData.length > 2 && imageData[imageData.length - 2] === 0x0d && imageData[imageData.length - 1] === 0x0a) {
                imageData = imageData.slice(0, -2);
              }
              break;
            }
            start = nextIdx;
          }
          if (!imageData || imageData.length < 100) throw new Error("Kein gültiges Bild");

          const avatarPath = path.join(__dirname, "avatar.png");
          fs.writeFileSync(avatarPath, imageData);

          // Telegram Bot-Profilbild setzen
          let telegramOk = false;
          const token = process.env.TELEGRAM_TOKEN;
          if (token) {
            try {
              const fileContent = fs.readFileSync(avatarPath);
              const tgBoundary = "----TgAvatar" + Date.now();
              const photoJson = JSON.stringify({ type: "static", photo: "attach://file" });
              const tgBody = Buffer.concat([
                Buffer.from([
                  "--" + tgBoundary,
                  'Content-Disposition: form-data; name="photo"',
                  "",
                  photoJson,
                  "--" + tgBoundary,
                  'Content-Disposition: form-data; name="file"; filename="avatar.png"',
                  "Content-Type: image/png",
                  "",
                  ""
                ].join("\r\n")),
                fileContent,
                Buffer.from("\r\n--" + tgBoundary + "--\r\n")
              ]);
              const axios = require("axios");
              await axios.post(`https://api.telegram.org/bot${token}/setMyProfilePhoto`, tgBody, {
                headers: { "Content-Type": `multipart/form-data; boundary=${tgBoundary}` },
                timeout: 10000
              });
              telegramOk = true;
            } catch (e) { console.error("Telegram Avatar-Fehler:", e.message); }
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, telegram: telegramOk }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    } else if (req.url === "/api/avatar" && req.method === "DELETE") {
      const avatarPath = path.join(__dirname, "avatar.png");
      let telegramOk = false;
      try { fs.unlinkSync(avatarPath); } catch {}
      // Telegram-Foto kann nicht per API gelöscht werden, nur ersetzt
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, telegram: telegramOk }));

    // --- Settings ---
    } else if (req.url === "/settings") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getSettingsHTML());
    } else if (req.url === "/api/settings" && req.method === "GET") {
      handleSettingsRead(req, res);
    } else if (req.url === "/api/settings" && req.method === "PUT") {
      handleSettingsWrite(req, res);
    } else if (req.url === "/api/restart" && req.method === "POST") {
      handleRestart(req, res);

    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(port, () => {
    originalLog(`Monitor-Dashboard: https://0.0.0.0:${port}`);
  });

  server.on("error", (err) => {
    originalError("Monitor-Fehler:", err.message);
  });
}

module.exports = { startMonitor, logEvent };
