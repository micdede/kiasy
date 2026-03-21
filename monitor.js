// JARVIS Monitoring Dashboard – SSE-basiertes Live-Monitoring im Browser
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const agent = require("./agent");
const voice = require("./voice");
const db = require("./lib/db");

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

  // wwebjs session backup
  const wwebBackup = path.join(__dirname, ".wwebjs_auth", "session_backup");
  const wwebBytes = getDirSize(wwebBackup);
  categories.push({ id: "wwebjs-backup", label: "WA Session Backup", size: formatBytes(wwebBytes), bytes: wwebBytes, cleanable: true });

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
      } else if (id === "wwebjs-backup") {
        const dir = path.join(__dirname, ".wwebjs_auth", "session_backup");
        freed = cleanDir(dir, null);
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
<title>JARVIS Monitor</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0d1117; color: #c9d1d9; font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
    font-size: 13px; height: 100vh; display: flex; flex-direction: column;
  }
  header {
    background: #161b22; border-bottom: 1px solid #30363d; padding: 12px 16px;
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  }
  header h1 { font-size: 16px; color: #58a6ff; font-weight: 600; }
  .status-bar {
    display: flex; gap: 16px; font-size: 11px; color: #8b949e; flex-wrap: wrap;
  }
  .status-bar span { display: flex; align-items: center; gap: 4px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; display: inline-block; }
  .filters {
    background: #161b22; border-bottom: 1px solid #30363d; padding: 8px 16px;
    display: flex; gap: 6px; flex-wrap: wrap;
  }
  .filter-btn {
    background: #21262d; border: 1px solid #30363d; color: #8b949e; padding: 4px 10px;
    border-radius: 12px; cursor: pointer; font-size: 11px; font-family: inherit;
    transition: all 0.15s;
  }
  .filter-btn:hover { border-color: #58a6ff; color: #c9d1d9; }
  .filter-btn.active { background: #1f6feb33; border-color: #58a6ff; color: #58a6ff; }
  .filter-btn .count { margin-left: 4px; opacity: 0.6; }
  #feed {
    flex: 1; overflow-y: auto; padding: 8px 0; scroll-behavior: smooth;
  }
  .event {
    padding: 3px 16px; display: flex; gap: 10px; line-height: 1.5;
    border-left: 3px solid transparent;
  }
  .event:hover { background: #161b22; }
  .event .time { color: #484f58; white-space: nowrap; min-width: 75px; }
  .event .tag {
    font-size: 10px; font-weight: 600; text-transform: uppercase; padding: 1px 6px;
    border-radius: 3px; white-space: nowrap; min-width: 65px; text-align: center;
    line-height: 1.7;
  }
  .event .msg { word-break: break-word; flex: 1; }
  .type-telegram { border-left-color: #58a6ff; }
  .type-telegram .tag { background: #58a6ff22; color: #58a6ff; }
  .type-mail { border-left-color: #3fb950; }
  .type-mail .tag { background: #3fb95022; color: #3fb950; }
  .type-tool { border-left-color: #d29922; }
  .type-tool .tag { background: #d2992222; color: #d29922; }
  .type-error { border-left-color: #f85149; }
  .type-error .tag { background: #f8514922; color: #f85149; }
  .type-system { border-left-color: #484f58; }
  .type-system .tag { background: #484f5822; color: #8b949e; }
  #feed::-webkit-scrollbar { width: 6px; }
  #feed::-webkit-scrollbar-track { background: transparent; }
  #feed::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
  .empty {
    display: flex; align-items: center; justify-content: center;
    height: 100%; color: #484f58; font-size: 14px;
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
  <h1><span class="dot"></span> JARVIS Monitor</h1>
  <a href="/chat" style="color:#8b949e;text-decoration:none;font-size:12px;padding:4px 10px;border:1px solid #30363d;border-radius:6px;">Chat</a>
  <a href="/system" style="color:#8b949e;text-decoration:none;font-size:12px;padding:4px 10px;border:1px solid #30363d;border-radius:6px;">System</a>
  <a href="/ha-editor" style="color:#8b949e;text-decoration:none;font-size:12px;padding:4px 10px;border:1px solid #30363d;border-radius:6px;">Smart Home Editor</a>
  <a href="/notes" style="color:#8b949e;text-decoration:none;font-size:12px;padding:4px 10px;border:1px solid #30363d;border-radius:6px;">Wissensbasis</a>
  <a href="/reminders" style="color:#8b949e;text-decoration:none;font-size:12px;padding:4px 10px;border:1px solid #30363d;border-radius:6px;">Erinnerungen</a>
  <a href="/terminal" style="color:#8b949e;text-decoration:none;font-size:12px;padding:4px 10px;border:1px solid #30363d;border-radius:6px;">Terminal</a>
  <a href="/settings" style="color:#8b949e;text-decoration:none;font-size:12px;padding:4px 10px;border:1px solid #30363d;border-radius:6px;">Einstellungen</a>
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
  document.querySelector("header .dot").style.background = "#f85149";
};
sse.onopen = () => {
  document.querySelector("header .dot").style.background = "#3fb950";
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
<title>JARVIS - System</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0d1117; color: #c9d1d9;
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
    font-size: 13px;
  }
  header {
    background: #161b22; border-bottom: 1px solid #30363d; padding: 12px 16px;
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  }
  header h1 { font-size: 16px; color: #58a6ff; font-weight: 600; }
  header a {
    color: #8b949e; text-decoration: none; font-size: 12px;
    padding: 4px 10px; border: 1px solid #30363d; border-radius: 6px;
  }
  header a:hover { color: #c9d1d9; border-color: #58a6ff; }

  .content { max-width: 1000px; margin: 20px auto; padding: 0 16px; }

  .sys-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 10px; margin-bottom: 24px;
  }
  .sys-card {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 10px 14px;
  }
  .sys-card h3 {
    font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px;
    margin-bottom: 6px; font-weight: 600;
  }
  .sys-card .sys-value { font-size: 18px; font-weight: 700; color: #e6edf3; margin-bottom: 4px; }
  .sys-card .sys-detail { font-size: 11px; color: #8b949e; line-height: 1.5; }
  .sys-bar {
    height: 6px; background: #21262d; border-radius: 3px; margin-top: 6px; overflow: hidden;
  }
  .sys-bar-fill {
    height: 100%; border-radius: 3px; transition: width 0.5s ease, background 0.3s ease;
  }
  .sys-bar-fill.green { background: #3fb950; }
  .sys-bar-fill.yellow { background: #d29922; }
  .sys-bar-fill.red { background: #f85149; }

  .cleanup-section {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    padding: 14px 16px;
  }
  .cleanup-header {
    display: flex; align-items: center; gap: 10px; margin-bottom: 10px;
  }
  .cleanup-title {
    font-size: 12px; font-weight: 600; color: #8b949e; text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .cleanup-total {
    font-size: 11px; color: #3fb950; margin-left: auto;
  }
  .cleanup-refresh-btn {
    background: none; border: 1px solid #30363d; color: #8b949e; width: 28px; height: 28px;
    border-radius: 6px; cursor: pointer; font-size: 16px; display: flex;
    align-items: center; justify-content: center; transition: all 0.15s;
  }
  .cleanup-refresh-btn:hover { border-color: #58a6ff; color: #c9d1d9; }
  .cleanup-refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .cleanup-row {
    display: flex; align-items: center; gap: 8px; padding: 6px 0;
    border-bottom: 1px solid #21262d;
  }
  .cleanup-row:last-child { border-bottom: none; }
  .cleanup-icon { font-size: 14px; width: 22px; text-align: center; }
  .cleanup-label { font-size: 12px; color: #c9d1d9; flex: 1; }
  .cleanup-size { font-size: 12px; color: #8b949e; min-width: 60px; text-align: right; }
  .cleanup-btn {
    font-size: 11px; padding: 3px 10px; border-radius: 4px; border: 1px solid #238636;
    background: #23863622; color: #3fb950; cursor: pointer; font-family: inherit;
    transition: all 0.15s;
  }
  .cleanup-btn:hover { background: #238636; color: #fff; }
  .cleanup-btn.disabled {
    border-color: #30363d; background: none; color: #484f58; cursor: default;
  }
  .cleanup-btn.disabled:hover { background: none; color: #484f58; }
  .cleanup-btn:disabled { opacity: 0.7; cursor: not-allowed; }

  @media (max-width: 600px) {
    .sys-grid { grid-template-columns: 1fr; }
  }

  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
</style>
</head>
<body>
<header>
  <h1>JARVIS System</h1>
  <a href="/">Monitor</a>
  <a href="/chat">Chat</a>
  <a href="/ha-editor">Smart Home Editor</a>
  <a href="/notes">Wissensbasis</a>
  <a href="/reminders">Erinnerungen</a>
  <a href="/terminal">Terminal</a>
  <a href="/settings">Einstellungen</a>
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
  document.getElementById("sys-cpu-detail").textContent = d.cpu.cores + " Cores \\u2014 " + d.cpu.model;

  document.getElementById("sys-mem-value").textContent = d.memory.used + " / " + d.memory.total;
  const memBar = document.getElementById("sys-mem-bar");
  memBar.style.width = d.memory.percent + "%";
  memBar.className = "sys-bar-fill " + barColor(d.memory.percent);
  document.getElementById("sys-mem-detail").textContent = d.memory.percent + "% belegt \\u2014 " + d.memory.free + " frei";

  document.getElementById("sys-disk-value").textContent = d.disk.used + " / " + d.disk.total;
  const diskBar = document.getElementById("sys-disk-bar");
  diskBar.style.width = d.disk.percent + "%";
  diskBar.className = "sys-bar-fill " + barColor(d.disk.percent);
  document.getElementById("sys-disk-detail").textContent = d.disk.percent + "% belegt \\u2014 " + d.disk.free + " frei";

  document.getElementById("sys-uptime-value").textContent = "System: " + d.uptime.system + " \\u2014 Prozess: " + d.uptime.process;
  document.getElementById("sys-node-detail").textContent = "Heap: " + d.node.heapUsed + " / " + d.node.heapTotal + " \\u2014 RSS: " + d.node.rss;
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
    listEl.innerHTML = '<div style="color:#484f58;padding:8px 0">Scanne...</div>';
    try {
      const res = await fetch("/api/cleanup");
      const data = await res.json();
      renderCleanup(data);
    } catch (err) {
      listEl.innerHTML = '<div style="color:#f85149;padding:8px 0">Fehler beim Laden</div>';
    } finally {
      refreshBtn.disabled = false;
    }
  }

  function renderCleanup(data) {
    const icons = { temp: "\\ud83d\\udcc1", logs: "\\ud83d\\udcdd", "npm-cache": "\\ud83d\\udce6", "wwebjs-backup": "\\ud83d\\udcac", "apt-cache": "\\ud83d\\udee0", journal: "\\ud83d\\udcd3" };
    let html = "";
    data.categories.forEach(cat => {
      const icon = icons[cat.id] || "\\ud83d\\udcc2";
      const btnClass = cat.cleanable ? "cleanup-btn" : "cleanup-btn disabled";
      const btnText = cat.cleanable ? "Aufr\\u00e4umen" : "sudo";
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
        if (!confirm(cat.label + " (" + cat.size + ") aufr\\u00e4umen?")) return;
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
            btn.style.color = "#3fb950";
            setTimeout(() => loadCleanup(), 2000);
          } else {
            btn.textContent = "Fehler";
            btn.style.color = "#f85149";
            setTimeout(() => loadCleanup(), 2000);
          }
        } catch {
          btn.textContent = "Fehler";
          btn.style.color = "#f85149";
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
<title>JARVIS - Smart Home Editor</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0d1117; color: #c9d1d9;
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
    font-size: 13px; height: 100vh; display: flex; flex-direction: column;
  }
  header {
    background: #161b22; border-bottom: 1px solid #30363d; padding: 12px 16px;
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  }
  header h1 { font-size: 16px; color: #58a6ff; font-weight: 600; }
  header a {
    color: #8b949e; text-decoration: none; font-size: 12px;
    padding: 4px 10px; border: 1px solid #30363d; border-radius: 6px;
  }
  header a:hover { color: #c9d1d9; border-color: #58a6ff; }
  .toolbar {
    background: #161b22; border-bottom: 1px solid #30363d; padding: 8px 16px;
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  }
  .file-tab {
    background: #21262d; border: 1px solid #30363d; color: #8b949e; padding: 6px 14px;
    border-radius: 6px; cursor: pointer; font-size: 12px; font-family: inherit;
    transition: all 0.15s;
  }
  .file-tab:hover { border-color: #58a6ff; color: #c9d1d9; }
  .file-tab.active { background: #1f6feb33; border-color: #58a6ff; color: #58a6ff; }
  .file-tab .badge {
    font-size: 10px; background: #484f58; color: #c9d1d9; padding: 1px 5px;
    border-radius: 8px; margin-left: 6px;
  }
  .file-tab.active .badge { background: #58a6ff; color: #0d1117; }
  .spacer { flex: 1; }
  .btn {
    padding: 6px 14px; border-radius: 6px; border: 1px solid #30363d;
    font-size: 12px; font-family: inherit; cursor: pointer; transition: all 0.15s;
  }
  .btn-save { background: #238636; border-color: #2ea043; color: #fff; }
  .btn-save:hover { background: #2ea043; }
  .btn-save:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-regen { background: #21262d; border-color: #30363d; color: #d29922; }
  .btn-regen:hover { background: #30363d; }
  .btn-regen:disabled { opacity: 0.5; cursor: not-allowed; }
  .save-status {
    font-size: 11px; color: #3fb950; opacity: 0; transition: opacity 0.3s;
  }
  .save-status.show { opacity: 1; }
  .save-status.error { color: #f85149; }
  .main {
    flex: 1; display: flex; overflow: hidden;
  }
  .editor-pane {
    flex: 1; display: flex; flex-direction: column; min-width: 0;
    border-right: 1px solid #30363d;
  }
  .editor-pane .pane-header {
    background: #161b22; padding: 6px 16px; font-size: 11px; color: #8b949e;
    border-bottom: 1px solid #30363d; display: flex; align-items: center; gap: 8px;
  }
  .editor-pane .pane-header .line-count { margin-left: auto; }
  #editor {
    flex: 1; width: 100%; background: #0d1117; color: #c9d1d9; border: none;
    padding: 12px 16px; font-family: inherit; font-size: 13px; line-height: 1.6;
    resize: none; outline: none; tab-size: 2;
  }
  #editor:focus { background: #0d1117; }
  .preview-pane {
    flex: 1; display: flex; flex-direction: column; min-width: 0; overflow: hidden;
  }
  .preview-pane .pane-header {
    background: #161b22; padding: 6px 16px; font-size: 11px; color: #8b949e;
    border-bottom: 1px solid #30363d;
  }
  #preview {
    flex: 1; overflow-y: auto; padding: 16px; line-height: 1.6;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px;
  }
  #preview h1 { font-size: 20px; color: #58a6ff; margin: 16px 0 8px; border-bottom: 1px solid #30363d; padding-bottom: 6px; }
  #preview h2 { font-size: 17px; color: #d2a8ff; margin: 14px 0 6px; }
  #preview h3 { font-size: 14px; color: #d29922; margin: 10px 0 4px; }
  #preview ul, #preview ol { padding-left: 20px; margin: 4px 0; }
  #preview li { margin: 2px 0; }
  #preview code {
    background: #161b22; padding: 2px 6px; border-radius: 4px;
    font-family: 'SF Mono', monospace; font-size: 12px; color: #79c0ff;
  }
  #preview table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 12px; }
  #preview th {
    background: #161b22; border: 1px solid #30363d; padding: 6px 10px;
    text-align: left; color: #8b949e; font-weight: 600;
  }
  #preview td { border: 1px solid #30363d; padding: 4px 10px; }
  #preview tr:hover td { background: #161b22; }
  #preview blockquote {
    border-left: 3px solid #484f58; padding: 4px 12px; margin: 8px 0;
    color: #8b949e; font-style: italic;
  }
  #preview strong { color: #e6edf3; }
  #preview em { color: #8b949e; }
  .loading-overlay {
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(13,17,23,0.8); display: none; align-items: center;
    justify-content: center; z-index: 100; font-size: 16px; color: #d29922;
  }
  .loading-overlay.show { display: flex; }

  /* Mobile: stack vertically */
  @media (max-width: 900px) {
    .main { flex-direction: column; }
    .editor-pane { border-right: none; border-bottom: 1px solid #30363d; flex: none; height: 50%; }
    .preview-pane { flex: none; height: 50%; }
  }

  /* scrollbar */
  #editor::-webkit-scrollbar, #preview::-webkit-scrollbar { width: 6px; }
  #editor::-webkit-scrollbar-track, #preview::-webkit-scrollbar-track { background: transparent; }
  #editor::-webkit-scrollbar-thumb, #preview::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
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
<title>JARVIS - Einstellungen</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0d1117; color: #c9d1d9;
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
    font-size: 13px;
  }
  header {
    background: #161b22; border-bottom: 1px solid #30363d; padding: 12px 16px;
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  }
  header h1 { font-size: 16px; color: #58a6ff; font-weight: 600; }
  header a {
    color: #8b949e; text-decoration: none; font-size: 12px;
    padding: 4px 10px; border: 1px solid #30363d; border-radius: 6px;
  }
  header a:hover { color: #c9d1d9; border-color: #58a6ff; }

  .banner {
    background: #238636; color: #fff; padding: 10px 16px; display: none;
    align-items: center; gap: 12px; font-size: 13px;
  }
  .banner.show { display: flex; }
  .banner .restart-btn {
    background: #fff; color: #238636; border: none; padding: 4px 14px;
    border-radius: 4px; cursor: pointer; font-family: inherit; font-size: 12px;
    font-weight: 600;
  }
  .banner .restart-btn:hover { background: #e6edf3; }
  .banner .restart-btn:disabled { opacity: 0.6; cursor: not-allowed; }

  .settings-container {
    max-width: 800px; margin: 20px auto; padding: 0 16px;
  }
  .settings-group {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    margin-bottom: 16px; overflow: hidden;
  }
  .settings-group h2 {
    font-size: 13px; color: #58a6ff; padding: 12px 16px;
    background: #0d1117; border-bottom: 1px solid #30363d;
    font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
  }
  .settings-group .fields { padding: 12px 16px; }
  .field-row {
    display: flex; align-items: center; gap: 12px; padding: 8px 0;
    border-bottom: 1px solid #21262d;
  }
  .field-row:last-child { border-bottom: none; }
  .field-label {
    min-width: 200px; font-size: 12px; color: #8b949e; font-weight: 600;
  }
  .field-input-wrap {
    flex: 1; position: relative; display: flex; align-items: center;
  }
  .field-input-wrap input, .field-input-wrap select {
    width: 100%; background: #0d1117; border: 1px solid #30363d; color: #c9d1d9;
    padding: 8px 12px; border-radius: 6px; font-family: inherit; font-size: 13px;
    outline: none; transition: border-color 0.15s;
  }
  .field-input-wrap input:focus, .field-input-wrap select:focus {
    border-color: #58a6ff;
  }
  .field-input-wrap select {
    appearance: none; cursor: pointer;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%238b949e'%3E%3Cpath d='M6 8L1 3h10z'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 10px center;
    padding-right: 30px;
  }
  .eye-toggle {
    position: absolute; right: 8px; background: none; border: none;
    color: #484f58; cursor: pointer; font-size: 16px; padding: 4px;
    line-height: 1;
  }
  .eye-toggle:hover { color: #8b949e; }
  .field-input-wrap input[type="password"] { padding-right: 36px; }
  .field-input-wrap input[type="text"].has-eye { padding-right: 36px; }

  .save-bar {
    position: sticky; bottom: 0; background: #161b22;
    border-top: 1px solid #30363d; padding: 12px 16px;
    display: flex; align-items: center; justify-content: center; gap: 12px;
  }
  .save-btn {
    background: #238636; border: 1px solid #2ea043; color: #fff;
    padding: 8px 24px; border-radius: 6px; cursor: pointer;
    font-family: inherit; font-size: 13px; font-weight: 600;
    transition: all 0.15s;
  }
  .save-btn:hover { background: #2ea043; }
  .save-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .save-status {
    font-size: 12px; color: #3fb950; opacity: 0; transition: opacity 0.3s;
  }
  .save-status.show { opacity: 1; }
  .save-status.error { color: #f85149; }

  @media (max-width: 600px) {
    .field-row { flex-direction: column; align-items: flex-start; gap: 4px; }
    .field-label { min-width: unset; }
  }

  /* scrollbar */
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
</style>
</head>
<body>
<header>
  <h1>JARVIS Einstellungen</h1>
  <a href="/">Monitor</a>
  <a href="/chat">Chat</a>
  <a href="/system">System</a>
  <a href="/ha-editor">Smart Home Editor</a>
  <a href="/notes">Wissensbasis</a>
  <a href="/reminders">Erinnerungen</a>
  <a href="/terminal">Terminal</a>
</header>

<div class="banner" id="banner">
  <span>Gespeichert. Neustart erforderlich f&uuml;r &Auml;nderungen.</span>
  <button class="restart-btn" id="restartBtn" onclick="doRestart()">Neustart</button>
</div>

<div class="settings-container" id="settingsContainer"></div>

<div class="save-bar">
  <span class="save-status" id="saveStatus"></span>
  <button class="save-btn" id="saveBtn" onclick="saveSettings()">Speichern (Ctrl+S)</button>
</div>

<script>
const SETTINGS_GROUPS = [
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
      { key: "OLLAMA_MODEL", label: "Ollama Modell", type: "text", provider: "ollama" },
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
    title: "Home Assistant",
    fields: [
      { key: "HOMEASSISTANT_URL", label: "URL", type: "text" },
      { key: "HOMEASSISTANT_TOKEN", label: "Token", type: "password" }
    ]
  },
  {
    title: "E-Mail (Kerio)",
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
  const container = document.getElementById("settingsContainer");
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

// Load settings
fetch("/api/settings")
  .then(r => r.json())
  .then(renderSettings)
  .catch(err => {
    document.getElementById("settingsContainer").innerHTML =
      '<div style="color:#f85149;padding:20px;text-align:center">Fehler beim Laden: ' + err.message + '</div>';
  });
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
<title>JARVIS - Wissensbasis</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0d1117; color: #c9d1d9;
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
    font-size: 13px; height: 100vh; display: flex; flex-direction: column;
  }
  header {
    background: #161b22; border-bottom: 1px solid #30363d; padding: 12px 16px;
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  }
  header h1 { font-size: 16px; color: #58a6ff; font-weight: 600; }
  header a {
    color: #8b949e; text-decoration: none; font-size: 12px;
    padding: 4px 10px; border: 1px solid #30363d; border-radius: 6px;
  }
  header a:hover { color: #c9d1d9; border-color: #58a6ff; }
  .toolbar {
    background: #161b22; border-bottom: 1px solid #30363d; padding: 8px 16px;
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  }
  .btn {
    padding: 6px 14px; border-radius: 6px; border: 1px solid #30363d;
    font-size: 12px; font-family: inherit; cursor: pointer; transition: all 0.15s;
    background: #21262d; color: #c9d1d9;
  }
  .btn:hover { border-color: #58a6ff; color: #58a6ff; }
  .btn-primary { background: #238636; border-color: #2ea043; color: #fff; }
  .btn-primary:hover { background: #2ea043; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-danger { background: #21262d; border-color: #f85149; color: #f85149; }
  .btn-danger:hover { background: #f8514922; }
  .btn-sync { background: #21262d; border-color: #d29922; color: #d29922; }
  .btn-sync:hover { background: #d2992222; }
  .spacer { flex: 1; }
  .search-input {
    background: #0d1117; border: 1px solid #30363d; color: #c9d1d9;
    padding: 6px 12px; border-radius: 6px; font-family: inherit; font-size: 12px;
    outline: none; width: 200px;
  }
  .search-input:focus { border-color: #58a6ff; }
  .save-status {
    font-size: 11px; color: #3fb950; opacity: 0; transition: opacity 0.3s;
  }
  .save-status.show { opacity: 1; }
  .save-status.error { color: #f85149; }
  .main {
    flex: 1; display: flex; overflow: hidden;
  }
  /* Sidebar */
  .sidebar {
    width: 260px; min-width: 200px; background: #0d1117;
    border-right: 1px solid #30363d; overflow-y: auto; display: flex;
    flex-direction: column;
  }
  .sidebar-header {
    padding: 8px 12px; font-size: 11px; color: #8b949e; border-bottom: 1px solid #21262d;
    font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
  }
  .note-item {
    padding: 10px 12px; cursor: pointer; border-bottom: 1px solid #21262d;
    transition: background 0.15s;
  }
  .note-item:hover { background: #161b22; }
  .note-item.active { background: #1f6feb22; border-left: 3px solid #58a6ff; }
  .note-item .note-title {
    font-size: 12px; font-weight: 600; color: #e6edf3;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .note-item .note-meta {
    font-size: 10px; color: #8b949e; margin-top: 3px;
    display: flex; gap: 8px; align-items: center;
  }
  .note-item .note-tags {
    font-size: 10px; color: #d2a8ff; margin-top: 2px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .sidebar-empty {
    padding: 20px 12px; color: #484f58; text-align: center; font-size: 12px;
  }
  /* Editor + Preview */
  .editor-pane {
    flex: 1; display: flex; flex-direction: column; min-width: 0;
    border-right: 1px solid #30363d;
  }
  .editor-pane .pane-header {
    background: #161b22; padding: 6px 16px; font-size: 11px; color: #8b949e;
    border-bottom: 1px solid #30363d; display: flex; align-items: center; gap: 8px;
  }
  .editor-pane .pane-header .line-count { margin-left: auto; }
  #editor {
    flex: 1; width: 100%; background: #0d1117; color: #c9d1d9; border: none;
    padding: 12px 16px; font-family: inherit; font-size: 13px; line-height: 1.6;
    resize: none; outline: none; tab-size: 2;
  }
  .preview-pane {
    flex: 1; display: flex; flex-direction: column; min-width: 0; overflow: hidden;
  }
  .preview-pane .pane-header {
    background: #161b22; padding: 6px 16px; font-size: 11px; color: #8b949e;
    border-bottom: 1px solid #30363d;
  }
  #preview {
    flex: 1; overflow-y: auto; padding: 16px; line-height: 1.6;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px;
  }
  #preview h1 { font-size: 20px; color: #58a6ff; margin: 16px 0 8px; border-bottom: 1px solid #30363d; padding-bottom: 6px; }
  #preview h2 { font-size: 17px; color: #d2a8ff; margin: 14px 0 6px; }
  #preview h3 { font-size: 14px; color: #d29922; margin: 10px 0 4px; }
  #preview ul, #preview ol { padding-left: 20px; margin: 4px 0; }
  #preview li { margin: 2px 0; }
  #preview code {
    background: #161b22; padding: 2px 6px; border-radius: 4px;
    font-family: 'SF Mono', monospace; font-size: 12px; color: #79c0ff;
  }
  #preview table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 12px; }
  #preview th {
    background: #161b22; border: 1px solid #30363d; padding: 6px 10px;
    text-align: left; color: #8b949e; font-weight: 600;
  }
  #preview td { border: 1px solid #30363d; padding: 4px 10px; }
  #preview tr:hover td { background: #161b22; }
  #preview blockquote {
    border-left: 3px solid #484f58; padding: 4px 12px; margin: 8px 0;
    color: #8b949e; font-style: italic;
  }
  #preview strong { color: #e6edf3; }
  #preview em { color: #8b949e; }
  .welcome-msg {
    display: flex; align-items: center; justify-content: center;
    height: 100%; color: #484f58; font-size: 14px; text-align: center;
    padding: 20px; line-height: 1.8;
  }
  /* Upload overlay */
  .upload-input { display: none; }
  @media (max-width: 900px) {
    .main { flex-direction: column; }
    .sidebar { width: 100%; max-height: 200px; border-right: none; border-bottom: 1px solid #30363d; }
    .editor-pane { border-right: none; border-bottom: 1px solid #30363d; }
  }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
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
<title>JARVIS Chat</title>
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#0d1117">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0d1117; color: #c9d1d9;
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
    font-size: 14px; height: 100vh; height: 100dvh;
    display: flex; flex-direction: column;
  }
  header {
    background: #161b22; border-bottom: 1px solid #30363d; padding: 10px 16px;
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    flex-shrink: 0;
  }
  header h1 { font-size: 16px; color: #58a6ff; font-weight: 600; white-space: nowrap; }
  .header-actions { margin-left: auto; display: flex; gap: 8px; align-items: center; }
  .header-btn {
    background: none; border: 1px solid #30363d; color: #8b949e;
    padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 12px;
    font-family: inherit; transition: all 0.15s;
  }
  .header-btn:hover { color: #c9d1d9; border-color: #58a6ff; }
  .header-btn.active { color: #58a6ff; border-color: #58a6ff; background: #58a6ff15; }

  #messages {
    flex: 1; overflow-y: auto; padding: 16px; display: flex;
    flex-direction: column; gap: 12px; scroll-behavior: smooth;
  }
  #messages::-webkit-scrollbar { width: 6px; }
  #messages::-webkit-scrollbar-track { background: transparent; }
  #messages::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }

  .msg { display: flex; flex-direction: column; max-width: 85%; animation: fadeIn 0.2s ease; }
  .msg.user { align-self: flex-end; align-items: flex-end; }
  .msg.assistant { align-self: flex-start; align-items: flex-start; }

  .bubble {
    padding: 10px 14px; border-radius: 12px; line-height: 1.55;
    word-wrap: break-word; overflow-wrap: break-word;
  }
  .msg.user .bubble {
    background: #1f6feb; color: #fff; border-bottom-right-radius: 4px;
  }
  .msg.assistant .bubble {
    background: #161b22; border: 1px solid #30363d; color: #c9d1d9;
    border-bottom-left-radius: 4px;
  }
  .msg .ts {
    font-size: 10px; color: #484f58; margin-top: 4px; padding: 0 4px;
  }

  /* Markdown in Assistant-Bubbles */
  .bubble p { margin: 0 0 8px 0; }
  .bubble p:last-child { margin-bottom: 0; }
  .bubble strong, .bubble b { color: #e6edf3; }
  .bubble code {
    background: #0d111788; padding: 1px 5px; border-radius: 3px;
    font-size: 0.9em; color: #f0883e;
  }
  .bubble pre {
    background: #0d1117; border: 1px solid #30363d; border-radius: 6px;
    padding: 10px; margin: 8px 0; overflow-x: auto; font-size: 12px;
    line-height: 1.5;
  }
  .bubble pre code { background: none; padding: 0; color: #c9d1d9; }
  .bubble ul, .bubble ol { margin: 6px 0 6px 20px; }
  .bubble li { margin: 2px 0; }
  .bubble a { color: #58a6ff; text-decoration: none; }
  .bubble a:hover { text-decoration: underline; }
  .bubble blockquote {
    border-left: 3px solid #30363d; margin: 6px 0; padding: 4px 12px; color: #8b949e;
  }

  .bubble .msg-img {
    max-width: 100%; border-radius: 8px; margin: 8px 0; cursor: pointer;
  }

  /* TTS Button in Assistant-Bubbles */
  .tts-btn {
    background: none; border: none; color: #484f58; cursor: pointer;
    font-size: 14px; padding: 2px 4px; margin-left: 4px; transition: color 0.15s;
  }
  .tts-btn:hover { color: #58a6ff; }
  .tts-btn.playing { color: #3fb950; }

  /* Typing Indicator */
  .typing { display: none; align-self: flex-start; padding: 0 4px; }
  .typing.visible { display: flex; }
  .typing-bubble {
    background: #161b22; border: 1px solid #30363d; border-radius: 12px;
    padding: 12px 18px; display: flex; gap: 5px; align-items: center;
    border-bottom-left-radius: 4px;
  }
  .typing-dot {
    width: 7px; height: 7px; background: #484f58; border-radius: 50%;
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
    background: #161b22; border-top: 1px solid #30363d;
    padding: 12px 16px; display: flex; gap: 10px; align-items: flex-end;
    flex-shrink: 0;
    padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px));
  }
  #voiceBtn {
    width: 40px; height: 40px; border-radius: 50%; border: 1px solid #30363d;
    background: #21262d; color: #8b949e; cursor: pointer; font-size: 18px;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.15s; flex-shrink: 0;
  }
  #voiceBtn:hover { border-color: #58a6ff; color: #c9d1d9; }
  #voiceBtn.recording { background: #f8514933; border-color: #f85149; color: #f85149; animation: pulse 1.5s infinite; }
  @keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 #f8514944; } 50% { box-shadow: 0 0 0 8px #f8514900; } }

  #msgInput {
    flex: 1; background: #0d1117; border: 1px solid #30363d; border-radius: 10px;
    color: #c9d1d9; padding: 10px 14px; font-family: inherit; font-size: 14px;
    resize: none; outline: none; max-height: 150px; min-height: 40px;
    line-height: 1.4; transition: border-color 0.15s;
  }
  #msgInput:focus { border-color: #58a6ff; }
  #msgInput::placeholder { color: #484f58; }

  #sendBtn {
    width: 40px; height: 40px; border-radius: 50%; border: none;
    background: #1f6feb; color: #fff; cursor: pointer; font-size: 18px;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.15s; flex-shrink: 0;
  }
  #sendBtn:hover { background: #388bfd; }
  #sendBtn:disabled { background: #21262d; color: #484f58; cursor: not-allowed; }

  .empty-state {
    flex: 1; display: flex; align-items: center; justify-content: center;
    color: #30363d; font-size: 48px; font-weight: 700; user-select: none;
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
  <h1>JARVIS Chat</h1>
  <div class="header-actions">
    <button class="header-btn" id="ttsToggle" title="Antworten vorlesen">TTS</button>
    <button class="header-btn" id="clearBtn" title="Chat leeren">Leeren</button>
  </div>
</header>

<div id="messages">
  <div class="empty-state">JARVIS</div>
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
    messagesEl.innerHTML = '<div class="empty-state">JARVIS</div>';
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
<title>JARVIS - Terminal</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0d1117; color: #c9d1d9;
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
    font-size: 13px; height: 100vh; display: flex; flex-direction: column;
  }
  header {
    background: #161b22; border-bottom: 1px solid #30363d; padding: 12px 16px;
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  }
  header h1 { font-size: 16px; color: #58a6ff; font-weight: 600; }
  header a {
    color: #8b949e; text-decoration: none; font-size: 12px;
    padding: 4px 10px; border: 1px solid #30363d; border-radius: 6px;
  }
  header a:hover { color: #c9d1d9; border-color: #58a6ff; }

  .main { flex: 1; display: flex; overflow: hidden; }

  /* --- Quick Actions Sidebar --- */
  .sidebar {
    width: 280px; min-width: 240px; background: #161b22;
    border-right: 1px solid #30363d; overflow-y: auto; padding: 12px;
  }
  .sidebar h2 {
    font-size: 11px; color: #8b949e; text-transform: uppercase;
    letter-spacing: 0.5px; margin-bottom: 10px; font-weight: 600;
  }
  .action-group { margin-bottom: 20px; }
  .action-btn {
    display: flex; align-items: center; gap: 10px; width: 100%;
    background: #21262d; border: 1px solid #30363d; color: #c9d1d9;
    padding: 10px 12px; border-radius: 6px; cursor: pointer;
    font-family: inherit; font-size: 12px; margin-bottom: 6px;
    transition: all 0.15s; text-align: left;
  }
  .action-btn:hover { border-color: #58a6ff; color: #58a6ff; }
  .action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .action-btn .icon { font-size: 16px; width: 24px; text-align: center; }
  .action-btn .label { flex: 1; }
  .action-btn .badge {
    font-size: 10px; padding: 2px 6px; border-radius: 8px;
    background: #21262d; color: #8b949e;
  }
  .action-btn.danger { border-color: #f8514944; }
  .action-btn.danger:hover { border-color: #f85149; color: #f85149; background: #f8514911; }
  .action-btn.warn { border-color: #d2992244; }
  .action-btn.warn:hover { border-color: #d29922; color: #d29922; background: #d2992211; }
  .action-btn.success { border-color: #3fb95044; }
  .action-btn.success:hover { border-color: #3fb950; color: #3fb950; background: #3fb95011; }

  .status-card {
    background: #0d1117; border: 1px solid #30363d; border-radius: 6px;
    padding: 10px; margin-bottom: 6px;
  }
  .status-card .label { font-size: 10px; color: #8b949e; text-transform: uppercase; margin-bottom: 4px; }
  .status-card .value { font-size: 13px; color: #e6edf3; }
  .status-card .value.running { color: #3fb950; }
  .status-card .value.stopped { color: #f85149; }

  /* --- Terminal Area --- */
  .terminal-wrap {
    flex: 1; display: flex; flex-direction: column; min-width: 0;
  }
  .terminal-header {
    background: #161b22; padding: 8px 16px; font-size: 11px; color: #8b949e;
    border-bottom: 1px solid #30363d; display: flex; align-items: center; gap: 12px;
  }
  .terminal-header .cwd { color: #58a6ff; }
  .terminal-header .clear-btn {
    margin-left: auto; background: none; border: 1px solid #30363d;
    color: #8b949e; padding: 2px 8px; border-radius: 4px; cursor: pointer;
    font-family: inherit; font-size: 11px;
  }
  .terminal-header .clear-btn:hover { border-color: #58a6ff; color: #c9d1d9; }
  #terminal-output {
    flex: 1; overflow-y: auto; padding: 8px 16px; background: #0d1117;
    white-space: pre-wrap; word-break: break-all; font-size: 12px;
    line-height: 1.5;
  }
  #terminal-output .cmd-line { color: #3fb950; margin-top: 8px; }
  #terminal-output .cmd-line:first-child { margin-top: 0; }
  #terminal-output .cmd-output { color: #c9d1d9; }
  #terminal-output .cmd-error { color: #f85149; }
  #terminal-output .cmd-info { color: #8b949e; font-style: italic; }
  .terminal-input-wrap {
    background: #161b22; border-top: 1px solid #30363d;
    padding: 8px 16px; display: flex; gap: 8px; align-items: center;
  }
  .prompt { color: #3fb950; font-size: 13px; font-weight: 600; }
  #terminal-input {
    flex: 1; background: #0d1117; border: 1px solid #30363d; color: #c9d1d9;
    padding: 8px 12px; border-radius: 6px; font-family: inherit; font-size: 13px;
    outline: none;
  }
  #terminal-input:focus { border-color: #58a6ff; }
  #terminal-input:disabled { opacity: 0.5; }
  .run-btn {
    background: #238636; border: 1px solid #2ea043; color: #fff;
    padding: 8px 16px; border-radius: 6px; cursor: pointer;
    font-family: inherit; font-size: 12px; font-weight: 600;
  }
  .run-btn:hover { background: #2ea043; }
  .run-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  @media (max-width: 800px) {
    .main { flex-direction: column; }
    .sidebar { width: 100%; max-height: 220px; border-right: none; border-bottom: 1px solid #30363d; }
  }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
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
</header>

<div class="main">
  <div class="sidebar">
    <div class="action-group">
      <h2>JARVIS Service</h2>
      <div class="status-card">
        <div class="label">Status</div>
        <div class="value" id="serviceStatus">Laden...</div>
      </div>
      <button class="action-btn success" onclick="quickAction('service-restart', 'JARVIS neustarten?')">
        <span class="icon">&#x21bb;</span><span class="label">JARVIS neustarten</span>
      </button>
      <button class="action-btn" onclick="quickAction('service-stop', 'JARVIS stoppen?')">
        <span class="icon">&#x23f9;</span><span class="label">JARVIS stoppen</span>
      </button>
      <button class="action-btn" onclick="quickAction('service-logs', null)">
        <span class="icon">&#x1F4CB;</span><span class="label">Service-Logs (50 Zeilen)</span>
      </button>
    </div>

    <div class="action-group">
      <h2>JARVIS Agent</h2>
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
      <button class="action-btn danger" onclick="quickAction('system-shutdown', 'System wirklich HERUNTERFAHREN?\\nJARVIS wird offline sein!')">
        <span class="icon">&#x23FB;</span><span class="label">System herunterfahren</span>
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
      <span>Verzeichnis: <span class="cwd" id="cwd">/home/mcde/whatsapp-claude</span></span>
      <button class="clear-btn" onclick="clearTerminal()">Leeren</button>
    </div>
    <div id="terminal-output">
      <div class="cmd-info">JARVIS WebTerminal bereit. Befehle eingeben oder Quick Actions nutzen.</div>
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
let currentCwd = '/home/mcde/whatsapp-claude';

function escapeHtml(s) {
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
}

function appendOutput(html) {
  output.insertAdjacentHTML('beforeend', html);
  output.scrollTop = output.scrollHeight;
}

function clearTerminal() {
  output.innerHTML = '<div class="cmd-info">Terminal geleert.</div>';
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
</script>
</body>
</html>`;
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
        const target = cdMatch[1].trim().replace(/^~/, process.env.HOME || "/home/mcde");
        const newCwd = path.resolve(cwd, target);
        if (fs.existsSync(newCwd) && fs.statSync(newCwd).isDirectory()) {
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ stdout: "", stderr: "", cwd: newCwd }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ stdout: "", stderr: "cd: " + target + ": Kein solches Verzeichnis", cwd }));
        }
        return;
      }

      const { exec } = require("child_process");
      exec(cmd, { cwd, timeout: 30000, maxBuffer: 1024 * 1024, env: { ...process.env, TERM: "dumb" } }, (err, stdout, stderr) => {
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
          exec("sudo systemctl restart jarvis-telegram 2>&1", { timeout: 15000 }, (err, out, serr) => {
            if (err) {
              // Fallback: process.exit for self-restart
              respond({ message: "JARVIS wird neu gestartet..." });
              setTimeout(() => process.exit(0), 500);
            } else {
              respond({ message: "JARVIS Service neu gestartet", output: out || serr });
            }
          });
          break;

        case "service-stop":
          respond({ message: "JARVIS wird gestoppt..." });
          setTimeout(() => process.exit(0), 500);
          break;

        case "service-logs":
          exec("journalctl -u jarvis-telegram --no-pager -n 50 2>/dev/null || echo 'Journal nicht verfügbar'", { timeout: 10000 }, (err, out) => {
            respond({ output: out || (err ? err.message : "Keine Logs") });
          });
          break;

        case "agent-reset":
          try {
            const agentMod = require("./agent");
            agentMod.conversations.clear();
            try { agentMod.chatDb.clearAllChats(); } catch {}
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

  exec("systemctl is-active jarvis-telegram 2>/dev/null", { timeout: 5000 }, (err, out) => {
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
<title>JARVIS - Erinnerungen</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0d1117; color: #c9d1d9;
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
    font-size: 13px;
  }
  header {
    background: #161b22; border-bottom: 1px solid #30363d; padding: 12px 16px;
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  }
  header h1 { font-size: 16px; color: #58a6ff; font-weight: 600; }
  header a {
    color: #8b949e; text-decoration: none; font-size: 12px;
    padding: 4px 10px; border: 1px solid #30363d; border-radius: 6px;
  }
  header a:hover { color: #c9d1d9; border-color: #58a6ff; }
  .container { max-width: 900px; margin: 20px auto; padding: 0 16px; }

  /* Toolbar */
  .toolbar {
    display: flex; gap: 8px; align-items: center; margin-bottom: 16px; flex-wrap: wrap;
  }
  .btn {
    padding: 6px 14px; border-radius: 6px; border: 1px solid #30363d;
    font-size: 12px; font-family: inherit; cursor: pointer; transition: all 0.15s;
    background: #21262d; color: #c9d1d9;
  }
  .btn:hover { border-color: #58a6ff; color: #58a6ff; }
  .btn-primary { background: #238636; border-color: #2ea043; color: #fff; }
  .btn-primary:hover { background: #2ea043; }
  .spacer { flex: 1; }
  .filter-btn {
    background: #21262d; border: 1px solid #30363d; color: #8b949e; padding: 4px 10px;
    border-radius: 12px; cursor: pointer; font-size: 11px; font-family: inherit;
  }
  .filter-btn:hover { border-color: #58a6ff; color: #c9d1d9; }
  .filter-btn.active { background: #1f6feb33; border-color: #58a6ff; color: #58a6ff; }
  .status-msg {
    font-size: 11px; color: #3fb950; opacity: 0; transition: opacity 0.3s;
  }
  .status-msg.show { opacity: 1; }
  .status-msg.error { color: #f85149; }

  /* Create Form */
  .create-form {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    padding: 16px; margin-bottom: 16px; display: none;
  }
  .create-form.show { display: block; }
  .create-form h3 { font-size: 13px; color: #58a6ff; margin-bottom: 12px; }
  .form-row { display: flex; gap: 12px; margin-bottom: 10px; align-items: center; flex-wrap: wrap; }
  .form-row label { font-size: 12px; color: #8b949e; min-width: 80px; }
  .form-row input, .form-row select {
    background: #0d1117; border: 1px solid #30363d; color: #c9d1d9;
    padding: 6px 10px; border-radius: 6px; font-family: inherit; font-size: 12px;
    outline: none; flex: 1; min-width: 150px;
  }
  .form-row input:focus { border-color: #58a6ff; }
  .form-actions { display: flex; gap: 8px; justify-content: flex-end; }

  /* Reminder List */
  .reminder-card {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    padding: 14px 16px; margin-bottom: 8px; display: flex; align-items: flex-start;
    gap: 12px; transition: all 0.15s;
  }
  .reminder-card:hover { border-color: #484f58; }
  .reminder-card.done { opacity: 0.5; }
  .reminder-card.overdue { border-left: 3px solid #f85149; }
  .reminder-card.upcoming { border-left: 3px solid #3fb950; }
  .reminder-card.future { border-left: 3px solid #58a6ff; }
  .reminder-check {
    width: 20px; height: 20px; border: 2px solid #30363d; border-radius: 4px;
    cursor: pointer; flex-shrink: 0; margin-top: 2px; display: flex;
    align-items: center; justify-content: center; background: none;
    color: transparent; font-size: 14px; transition: all 0.15s;
  }
  .reminder-check:hover { border-color: #3fb950; }
  .reminder-check.checked { border-color: #3fb950; background: #3fb95033; color: #3fb950; }
  .reminder-body { flex: 1; min-width: 0; }
  .reminder-text { font-size: 13px; color: #e6edf3; margin-bottom: 4px; word-break: break-word; }
  .reminder-card.done .reminder-text { text-decoration: line-through; color: #8b949e; }
  .reminder-meta { font-size: 11px; color: #8b949e; display: flex; gap: 12px; flex-wrap: wrap; }
  .reminder-meta .due { font-weight: 600; }
  .reminder-meta .overdue { color: #f85149; }
  .reminder-meta .soon { color: #d29922; }
  .reminder-actions { display: flex; gap: 6px; flex-shrink: 0; }
  .reminder-actions button {
    background: none; border: 1px solid #30363d; color: #8b949e;
    padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px;
    font-family: inherit; transition: all 0.15s;
  }
  .reminder-actions button:hover { border-color: #58a6ff; color: #c9d1d9; }
  .reminder-actions .del-btn:hover { border-color: #f85149; color: #f85149; }
  .empty-state {
    text-align: center; padding: 40px; color: #484f58; font-size: 14px;
  }

  /* Edit inline */
  .edit-row { display: flex; gap: 8px; margin-top: 8px; }
  .edit-row input {
    background: #0d1117; border: 1px solid #30363d; color: #c9d1d9;
    padding: 4px 8px; border-radius: 4px; font-family: inherit; font-size: 12px;
    outline: none;
  }
  .edit-row input:focus { border-color: #58a6ff; }

  @media (max-width: 600px) {
    .reminder-card { flex-direction: column; gap: 8px; }
    .reminder-actions { align-self: flex-end; }
  }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
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
    const typeBadge = r.type === 'task' ? '<span style="background:#1f6feb33;color:#58a6ff;padding:1px 6px;border-radius:4px;font-size:10px;margin-left:6px">Aufgabe</span>' : '';
    let intervalLabel = '';
    if (r.interval_hours) {
      const h = r.interval_hours;
      if (h % 24 === 0 && h >= 24) intervalLabel = '<span style="color:#d29922;margin-left:6px;font-size:10px">\\u27F3 alle ' + (h/24) + 'd</span>';
      else intervalLabel = '<span style="color:#d29922;margin-left:6px;font-size:10px">\\u27F3 alle ' + h + 'h</span>';
    }
    const pausedLabel = (r.failCount >= 3) ? '<span style="color:#f85149;margin-left:6px;font-size:10px">\\u26A0 pausiert</span>' : '';
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
  setTimeout(() => process.exit(0), 500);
}

// --- PWA Manifest + Service Worker ---

function getManifestJSON() {
  return JSON.stringify({
    name: "JARVIS Chat",
    short_name: "JARVIS",
    start_url: "/chat",
    display: "standalone",
    background_color: "#0d1117",
    theme_color: "#0d1117",
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

  return {
    cpu: { model: cpus[0]?.model || "-", cores: cpus.length, loadAvg: os.loadavg().map(v => +v.toFixed(2)) },
    memory: { total: formatGB(totalMem), used: formatGB(usedMem), free: formatGB(freeMem), percent: memPercent },
    disk,
    uptime: { system: sysUptime, process: procUptime },
    node: { heapUsed: formatMB(mem.heapUsed), heapTotal: formatMB(mem.heapTotal), rss: formatMB(mem.rss) },
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
    "WWW-Authenticate": 'Basic realm="JARVIS Monitor"',
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
        model: process.env.CLAUDE_MODEL || process.env.OLLAMA_MODEL || "unbekannt",
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
