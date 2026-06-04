// kiasy-monitor — Web-UI mit Pages für tools/memory/reminders/news/health/settings

import express from "express";
import { readFileSync } from "node:fs";
import os from "node:os";
import { execSync } from "node:child_process";

const PORT = Number(process.env.PORT || 3000);
const CORE_URL = process.env.CORE_URL || "http://kiasy-core:8080";
const BOT_NAME = process.env.BOT_NAME || "kiasy";
const STARTED = Date.now();
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url)));

const app = express();
app.disable("x-powered-by");
app.use(express.json());

app.get("/ping", (req, res) => {
  res.json({ ok: true, service: "kiasy-monitor", version: pkg.version,
             uptime_s: Math.round((Date.now() - STARTED) / 1000), core_url: CORE_URL });
});

// ─── Hardware-Metriken (lokal, nicht an core proxied) ────────
app.get("/health/hw", (req, res) => {
  try {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPct = Math.round((usedMem / totalMem) * 100);
    const load = os.loadavg();

    // Disk via df
    let disk = { total: "?", used: "?", free: "?", pct: 0, raw: "" };
    try {
      const dfLine = execSync("df -h / | tail -1", { timeout: 3000 }).toString().trim();
      const parts = dfLine.split(/\s+/);
      disk = { total: parts[1], used: parts[2], free: parts[3], pct: parseInt(parts[4] || "0"), raw: dfLine };
    } catch (_) {}

    // Temperature
    let temp_c = null;
    try {
      const raw = readFileSync("/sys/class/thermal/thermal_zone0/temp", "utf8").trim();
      temp_c = Math.round(parseInt(raw) / 1000);
    } catch (_) {}

    // Uptime
    const uptimeSec = Math.round(os.uptime());
    const d = Math.floor(uptimeSec / 86400);
    const h = Math.floor((uptimeSec % 86400) / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    const uptimeStr = `${d}d ${h}h ${m}m`;

    res.json({
      cpu: { model: cpus[0]?.model || "unknown", cores: cpus.length, load_1: load[0], load_5: load[1], load_15: load[2] },
      memory: { total_bytes: totalMem, used_bytes: usedMem, free_bytes: freeMem, pct: memPct,
                total: (totalMem / 1073741824).toFixed(1) + " GB", used: (usedMem / 1073741824).toFixed(1) + " GB" },
      disk,
      uptime: uptimeStr,
      temp_c
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Generischer API-Proxy zu kiasy-core ────────────────────
app.use("/api", async (req, res) => {
  const url = CORE_URL + "/api" + req.url;
  const init = {
    method: req.method,
    headers: { "Content-Type": "application/json" },
    body: ["POST","PUT","PATCH","DELETE"].includes(req.method) ? JSON.stringify(req.body || {}) : undefined
  };
  try {
    const upstream = await fetch(url, init);
    res.status(upstream.status);
    const ct = upstream.headers.get("content-type") || "";
    if (ct.includes("event-stream")) {
      res.setHeader("Content-Type", ct);
      upstream.body.pipeTo(new WritableStream({
        write(c) { res.write(c); }, close() { res.end(); }
      })).catch(() => res.end());
    } else {
      res.setHeader("Content-Type", ct || "application/json");
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
    }
  } catch (err) {
    res.status(502).json({ error: "core unreachable", detail: err.message });
  }
});

// ─── Pages ───────────────────────────────────────────────────
app.get("/", async (req, res) => {
  let coreStatus = "unbekannt";
  try {
    const r = await fetch(`${CORE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    coreStatus = r.ok ? "online" : `HTTP ${r.status}`;
  } catch { coreStatus = "offline"; }
  res.send(layout("dashboard", BOT_NAME, `
    <section class="hero">
      <h1>${BOT_NAME}</h1>
      <p class="tag">v${pkg.version} · Phase 3 · core ${coreStatus}</p>
    </section>
    <section class="cards">
      ${[
        // ["chat","Chat","💬","Web-Chat mit Agent"],  // DEPRECATED: iOS-App + Telegram als Chat-Interfaces, Web-Chat ungenutzt
        // ["notes","Notes","📝","Markdown-Wissensbasis"],  // DEPRECATED: nach Kerio migriert (siehe note_* Tools)
        ["memory","Memory","🧠","Facts/Todos + Vector-Suche"],
        ["reminders","Reminders","⏰","Erinnerungen"],
        ["workflows","Workflows","⚙️","Mehrstufige Tasks"],
        ["delegations","Delegations","👥","Aufgaben delegieren"],
        ["labs","Labs","🧪","Ideen + Drafts"],
        ["news","News","📰","Quellen-Config"],
        ["tools","Tools","🔧","Tools verwalten"],
        ["voice","Voice","🎙","TTS/STT-Test"],
        ["ha-editor","HA","🏠","HA-Devices"],
        ["health","Health","🩺","Container-Status"],
        ["files","Dateien","📁","Bilder & Dokumente"],
        ["logs","Logs","📜","Live-Logs core"],
        ["backup","Backup","💾","Backups"],
        ["settings","Settings","🛠","Konfiguration"]
      ].map(([p, t, e, d]) => `<a class="card-link" href="/${p}"><div class="card"><h3>${e} ${t}</h3><p class="lead">${d}</p></div></a>`).join("")}
    </section>
  `));
});

// app.get("/chat", (req, res) => res.send(layout("chat", "Chat", chatBody())));  // DEPRECATED: Web-Chat ungenutzt
app.get("/tools", (req, res) => res.send(layout("tools", "Tools", toolsBody())));
app.get("/memory", (req, res) => res.send(layout("memory", "Memory", memoryBody())));
app.get("/reminders", (req, res) => res.send(layout("reminders", "Reminders", remindersBody())));
app.get("/news", (req, res) => res.send(layout("news", "News-Quellen", newsBody())));
app.get("/contacts", (req, res) => res.send(layout("contacts", "Kontakte", contactsBody())));
app.get("/health", (req, res) => res.send(layout("health", "Health", healthBody())));
app.get("/settings", (req, res) => res.send(layout("settings", "Settings", settingsBody())));
// DEPRECATED: lokale Markdown-Notes ersetzt durch Kerio CalDAV (note_* Tools).
// Code bleibt als Fallback — Route deaktiviert.
// app.get("/notes", (req, res) => res.send(layout("notes", "Notes", notesBody())));
app.get("/workflows", (req, res) => res.send(layout("workflows", "Workflows", workflowsBody())));
app.get("/delegations", (req, res) => res.send(layout("delegations", "Delegations", delegationsBody())));
app.get("/ha-editor", (req, res) => res.send(layout("ha-editor", "HA-Editor", haEditorBody())));
app.get("/voice", (req, res) => res.send(layout("voice", "Voice-Test", voiceBody())));
app.get("/backup", (req, res) => res.send(layout("backup", "Backups", backupBody())));
app.get("/labs", (req, res) => res.send(layout("labs", "Labs", labsBody())));
app.get("/logs", (req, res) => res.send(layout("logs", "Logs", logsBody())));
app.get("/files", (req, res) => res.send(layout("files", "Dateien", filesBody())));

app.listen(PORT, "0.0.0.0", () => console.log(`[kiasy-monitor] v${pkg.version} listening on :${PORT}`));

// ═════════════════════════════════════════════════════════════
// Page Bodies
// ═════════════════════════════════════════════════════════════

// DEPRECATED: Web-Chat ungenutzt (iOS-App + Telegram als Chat-Interfaces).
// chatBody() ausgeblendet, Datei als Fallback im git-history.
/*
function chatBody() { ... }
*/

function toolsBody() {
  return `
    <div class="page-head"><h2>Tools</h2>
      <div style="display:flex;gap:8px;">
        <button class="btn" onclick="reloadTools()">⟳ reload</button>
      </div>
    </div>

    <div class="tabs">
      <button class="tab active" data-tab="list" onclick="setTtab('list')">📋 Tool-Liste</button>
      <button class="tab" data-tab="exec" onclick="setTtab('exec')">▶️ Direkt ausführen</button>
      <button class="tab" data-tab="gen"  onclick="setTtab('gen')">🤖 KI-Generator</button>
    </div>

    <!-- Tab: Liste -->
    <div class="tpane" id="tpane-list">
      <div id="tools-list" class="list">lade…</div>
    </div>

    <!-- Tab: Exec -->
    <div class="tpane" id="tpane-exec" style="display:none;">
      <div class="exec-box">
        <input id="exec-name" placeholder="Tool-Name (z.B. current_time)" class="input">
        <textarea id="exec-input" placeholder='{"format":"both"}' rows="3" class="input mono"></textarea>
        <button class="btn primary" onclick="execTool()">execute</button>
      </div>
      <pre id="exec-result" class="result"></pre>
    </div>

    <!-- Tab: KI-Generator -->
    <div class="tpane" id="tpane-gen" style="display:none;">
      <p class="dim" style="margin-bottom:12px;">Beschreibe was das Tool tun soll — die Coding-KI (<code id="gen-model">…</code>) generiert ein vollständiges Tool-File. Du kannst es testen, verfeinern, und speichern (geht direkt in <code>core/tools/</code>, sofort live).</p>

      <div class="gen-row">
        <label>Beschreibung</label>
        <textarea id="gen-desc" rows="4" class="input" placeholder="z.B. Ein Tool das den BTC-Kurs in EUR von einer öffentlichen API holt"></textarea>
        <button class="btn primary" onclick="genGenerate()">🤖 Generieren</button>
        <span id="gen-status" class="dim mono" style="font-size:12px;"></span>
      </div>

      <div class="gen-row">
        <label>Code (editierbar)</label>
        <textarea id="gen-code" rows="20" class="input mono" spellcheck="false" style="font-size:12px;line-height:1.5;"></textarea>
      </div>

      <div class="gen-row two-cols">
        <div>
          <label>Verfeinern</label>
          <input id="gen-refine" class="input" placeholder="z.B. dazu noch die 24h-Änderung in %">
          <button class="btn" onclick="genRefine()">✨ Verfeinern</button>
        </div>
        <div>
          <label>Test-Input (JSON)</label>
          <textarea id="gen-test-input" rows="3" class="input mono" placeholder='{}'></textarea>
          <button class="btn" onclick="genTest()">▶️ Test ausführen</button>
        </div>
      </div>

      <pre id="gen-test-result" class="result"></pre>

      <div class="gen-row save-row">
        <label>Dateiname</label>
        <input id="gen-filename" class="input mono" placeholder="z.B. btc-price.js" style="max-width:300px;">
        <label class="overwrite-lbl"><input type="checkbox" id="gen-overwrite"> existierendes überschreiben</label>
        <button class="btn primary" onclick="genSave()">💾 Speichern</button>
        <span id="gen-save-status" class="dim mono" style="font-size:12px;"></span>
      </div>
    </div>

    <style>
      .tabs { display:flex; gap:4px; margin-bottom:16px; border-bottom:1px solid var(--border); }
      .tab { background:none; border:none; padding:10px 16px; cursor:pointer; color:var(--text-dim); font-size:13px; border-bottom:2px solid transparent; }
      .tab:hover { color:var(--text); }
      .tab.active { color:var(--accent); border-bottom-color:var(--accent); }
      .tpane { animation: fadeIn 0.15s; }
      @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
      .list { display:flex; flex-direction:column; gap:8px; }
      .row { display:flex; align-items:center; gap:12px; padding:12px 16px; background: var(--bg-card); border:1px solid var(--border); border-radius: var(--radius); }
      .row .name { font-family:var(--mono); font-weight:600; flex:0 0 200px; }
      .row .desc { color: var(--text-dim); font-size:13px; flex:1; }
      .row .toggle { padding:4px 10px; border-radius:6px; cursor:pointer; font-size:12px; border:1px solid var(--border); background:var(--bg-elevated); }
      .row .toggle.on { color: var(--ok); border-color: var(--ok); }
      .row .toggle.off { color: var(--err); border-color: var(--err); }
      .row .src-btn { padding:4px 10px; border-radius:6px; cursor:pointer; font-size:11px; border:1px solid var(--border); background:var(--bg-elevated); color:var(--text-dim); }
      .row .src-btn:hover { color:var(--accent); border-color:var(--accent); }
      .exec-box { display:flex; flex-direction:column; gap:8px; max-width:600px; }
      .input { padding:10px 14px; background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); color:var(--text); font-family:var(--font); }
      .input.mono { font-family:var(--mono); font-size:13px; }
      .result { background:var(--bg-card); border:1px solid var(--border); padding:16px; border-radius:var(--radius); white-space:pre-wrap; word-wrap:break-word; max-height:400px; overflow:auto; font-size:12px; margin-top:12px; }
      .gen-row { margin-bottom:18px; display:flex; flex-direction:column; gap:8px; }
      .gen-row label { font-size:12px; color:var(--text-dim); text-transform:uppercase; letter-spacing:0.5px; }
      .gen-row.two-cols { display:grid; grid-template-columns: 1fr 1fr; gap:18px; }
      .gen-row.two-cols > div { display:flex; flex-direction:column; gap:8px; }
      .save-row { flex-direction:row; align-items:center; flex-wrap:wrap; }
      .save-row label { margin-bottom:0; }
      .overwrite-lbl { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--text-dim); cursor:pointer; }
    </style>
    <script>
      // ─── Tabs ────────────────────────────────
      function setTtab(t){
        document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab===t));
        document.querySelectorAll('.tpane').forEach(p => p.style.display = (p.id==='tpane-'+t) ? '' : 'none');
        if (t==='gen') loadGenModel();
      }

      // ─── Tool-Liste ─────────────────────────
      async function loadTools(){
        const [defs, settings] = await Promise.all([
          fetch('/api/tools').then(r=>r.json()),
          fetch('/api/tools/settings').then(r=>r.json())
        ]);
        const sMap = new Map(settings.settings.map(s => [s.filename, s]));
        document.getElementById('tools-list').innerHTML = defs.tools.map(t => {
          const setting = [...sMap.values()].find(s => s.filename.includes(t.name.split('_')[0]));
          const enabled = setting ? setting.enabled : 1;
          const fn = setting ? setting.filename : t.name.replace(/_/g,'-') + '.js';
          return \`<div class="row">
            <span class="name">\${t.name}</span>
            <span class="desc">\${t.description.substring(0,150)}\${t.description.length>150?'…':''}</span>
            <button class="src-btn" onclick="loadSourceForRefine('\${fn}','\${t.name}')">✏️ KI-Edit</button>
            <button class="toggle \${enabled?'on':'off'}" onclick="toggleTool('\${fn}',\${enabled?0:1},this)">\${enabled?'enabled':'disabled'}</button>
          </div>\`;
        }).join('');
      }
      async function toggleTool(filename, enabled, btn){
        await fetch('/api/tools/settings/'+encodeURIComponent(filename),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:!!enabled})});
        loadTools();
      }
      async function reloadTools(){
        await fetch('/api/tools/reload',{method:'POST'});
        loadTools();
      }
      async function execTool(){
        const name = document.getElementById('exec-name').value.trim();
        const inputStr = document.getElementById('exec-input').value.trim() || '{}';
        let input;
        try { input = JSON.parse(inputStr); } catch(e){ document.getElementById('exec-result').textContent = 'JSON-Fehler: '+e.message; return; }
        const r = await fetch('/api/tools/exec',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,input})});
        const data = await r.json();
        document.getElementById('exec-result').textContent = JSON.stringify(data, null, 2);
      }

      // ─── KI-Generator ───────────────────────
      async function loadGenModel(){
        try {
          const s = await (await fetch('/api/settings')).json();
          document.getElementById('gen-model').textContent = s.models?.ollama_code || 'qwen3-coder:480b-cloud (Default)';
        } catch {}
      }
      async function genGenerate(){
        const desc = document.getElementById('gen-desc').value.trim();
        if (!desc) { alert('Beschreibung fehlt'); return; }
        const status = document.getElementById('gen-status');
        status.textContent = '⏳ KI generiert (kann 10-30s dauern)…';
        try {
          const t0 = Date.now();
          const r = await fetch('/api/tools/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({description:desc})});
          const d = await r.json();
          if (!r.ok) { status.textContent = '✗ '+(d.error||'Fehler'); return; }
          document.getElementById('gen-code').value = d.code || '';
          document.getElementById('gen-filename').value = d.suggestedFilename || '';
          status.textContent = '✓ generiert in '+((Date.now()-t0)/1000).toFixed(1)+'s';
        } catch (e) { status.textContent = '✗ '+e.message; }
      }
      async function genRefine(){
        const code = document.getElementById('gen-code').value.trim();
        const instr = document.getElementById('gen-refine').value.trim();
        if (!code || !instr) { alert('Code + Anweisung erforderlich'); return; }
        const status = document.getElementById('gen-status');
        status.textContent = '⏳ verfeinere…';
        try {
          const r = await fetch('/api/tools/refine',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentCode:code, instruction:instr})});
          const d = await r.json();
          if (!r.ok) { status.textContent = '✗ '+(d.error||'Fehler'); return; }
          document.getElementById('gen-code').value = d.code || code;
          document.getElementById('gen-refine').value = '';
          status.textContent = '✓ überarbeitet';
        } catch (e) { status.textContent = '✗ '+e.message; }
      }
      async function genTest(){
        const code = document.getElementById('gen-code').value.trim();
        if (!code) { alert('Kein Code'); return; }
        let input;
        try { input = JSON.parse(document.getElementById('gen-test-input').value.trim() || '{}'); }
        catch(e) { document.getElementById('gen-test-result').textContent = 'JSON-Fehler: '+e.message; return; }
        document.getElementById('gen-test-result').textContent = '⏳ test läuft…';
        try {
          const r = await fetch('/api/tools/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code, input})});
          const d = await r.json();
          document.getElementById('gen-test-result').textContent = JSON.stringify(d, null, 2);
        } catch (e) { document.getElementById('gen-test-result').textContent = 'Fehler: '+e.message; }
      }
      async function genSave(){
        const code = document.getElementById('gen-code').value.trim();
        const filename = document.getElementById('gen-filename').value.trim();
        const overwrite = document.getElementById('gen-overwrite').checked;
        if (!code || !filename) { alert('Code + Dateiname erforderlich'); return; }
        const status = document.getElementById('gen-save-status');
        status.textContent = '⏳ speichere…';
        try {
          const r = await fetch('/api/tools/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code, filename, overwrite})});
          const d = await r.json();
          if (!r.ok) { status.textContent = '✗ '+(d.error||'Fehler'); return; }
          if (d.parsed) {
            status.textContent = '✓ gespeichert + geladen — Tools verfügbar: ' + (d.defs?.map(x=>x.name).join(', ') || '?');
          } else {
            status.textContent = '⚠ gespeichert, aber Tool-Parsing fehlgeschlagen: ' + (d.error || '?');
          }
          loadTools();
        } catch (e) { status.textContent = '✗ '+e.message; }
      }
      async function loadSourceForRefine(filename, name){
        try {
          const r = await fetch('/api/tools/source?filename='+encodeURIComponent(filename));
          const d = await r.json();
          if (!r.ok) { alert('Konnte Source nicht laden: '+(d.error||'?')); return; }
          setTtab('gen');
          document.getElementById('gen-code').value = d.code || '';
          document.getElementById('gen-filename').value = d.filename || filename;
          document.getElementById('gen-overwrite').checked = true;
          document.getElementById('gen-status').textContent = '📂 '+filename+' geladen — verfeinere oder editiere';
          document.getElementById('gen-desc').placeholder = '(Beschreibung nicht nötig — du editierst ein bestehendes Tool)';
        } catch (e) { alert(e.message); }
      }

      loadTools();
    </script>`;
}

function memoryBody() {
  return `
    <div class="page-head"><h2>Memory</h2></div>

    <!-- Qdrant-Stats Panel -->
    <div class="vec-stats" id="vec-stats">lade Vector-Status…</div>

    <!-- Tabs: Facts/Todos vs Vectors -->
    <div class="tabs">
      <button class="tab active" data-tab="explicit" onclick="setTab('explicit')">📋 Facts / Todos / Notes (SQLite)</button>
      <button class="tab" data-tab="search" onclick="setTab('search')">🔍 Semantische Suche (Qdrant)</button>
      <button class="tab" data-tab="browse" onclick="setTab('browse')">📚 Vector-Browser</button>
    </div>

    <!-- Tab: explicit (SQLite memory) -->
    <div class="tab-pane" id="tab-explicit">
      <div class="filter-bar">
        <select id="cat" class="input"><option value="">alle</option><option>facts</option><option>todos</option><option>notes</option></select>
        <input id="q" placeholder="Volltext-Suche…" class="input">
        <button class="btn" onclick="loadMem()">filter</button>
      </div>
      <h3 style="margin-top:24px">Neu</h3>
      <div class="add-form">
        <select id="new-cat" class="input"><option>facts</option><option>todos</option><option>notes</option></select>
        <input id="new-key" placeholder="Stichwort (optional)" class="input">
        <textarea id="new-val" placeholder="Inhalt…" rows="2" class="input"></textarea>
        <button class="btn primary" onclick="addMem()">speichern</button>
      </div>
      <h3 style="margin-top:24px">Einträge</h3>
      <div id="mem-list" class="list"></div>
    </div>

    <!-- Tab: semantische Suche -->
    <div class="tab-pane" id="tab-search" style="display:none;">
      <p class="dim">Sucht in <b>allen</b> auto-vektorisierten Inhalten (Chat-Messages, Memory, Notes) mit bge-m3 + Cosine-Similarity.</p>
      <div style="display:flex;gap:8px;margin:16px 0;">
        <input id="sq" class="input" placeholder="z.B. 'Wann war der letzte Kerio-Backup'" style="flex:1;">
        <select id="sk" class="input" style="width:80px;"><option>5</option><option>10</option><option>20</option><option>50</option></select>
        <button class="btn primary" onclick="doSearch()">🔍 Suchen</button>
      </div>
      <div id="sresults" class="list"></div>
    </div>

    <!-- Tab: Vector-Browser -->
    <div class="tab-pane" id="tab-browse" style="display:none;">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">
        <select id="bt" class="input" onchange="loadBrowse(true)">
          <option value="">alle Typen</option>
          <option value="message">message</option>
          <option value="memory">memory</option>
          <option value="note">note</option>
        </select>
        <button class="btn" onclick="loadBrowse(true)">refresh</button>
        <button class="btn" onclick="cleanup()" style="margin-left:auto;">🧹 V1-Altlast löschen</button>
        <button class="btn" onclick="reindex()">🔄 Re-Index alles</button>
      </div>
      <div id="bresults" class="list"></div>
      <div style="text-align:center;margin-top:12px;">
        <button class="btn" id="bmore" onclick="loadBrowse(false)" style="display:none;">↓ mehr laden</button>
      </div>
    </div>

    <style>
      .vec-stats { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); padding:14px 18px; margin-bottom:16px; display:flex; gap:24px; flex-wrap:wrap; font-size:13px; }
      .vec-stats .stat { display:flex; flex-direction:column; gap:2px; }
      .vec-stats .stat .v { font-size:20px; font-weight:600; color:var(--accent); font-family:var(--mono); }
      .vec-stats .stat .l { color:var(--text-dim); font-size:11px; text-transform:uppercase; }
      .vec-stats .err { color:var(--err); }
      .tabs { display:flex; gap:4px; margin-bottom:16px; border-bottom:1px solid var(--border); }
      .tab { background:none; border:none; padding:10px 16px; cursor:pointer; color:var(--text-dim); font-size:13px; border-bottom:2px solid transparent; }
      .tab:hover { color:var(--text); }
      .tab.active { color:var(--accent); border-bottom-color:var(--accent); }
      .filter-bar, .add-form { display:flex; gap:8px; align-items:flex-start; flex-wrap:wrap; }
      .add-form { flex-direction:column; max-width:600px; }
      .add-form .input { width:100%; }
      .input { padding:8px 12px; background:var(--bg-card); border:1px solid var(--border); border-radius:6px; color:var(--text); font-family:var(--font); font-size:14px; }
      .list { display:flex; flex-direction:column; gap:8px; margin-top:12px; }
      .row { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); padding:12px 16px; display:flex; gap:12px; align-items:flex-start; }
      .row .meta { flex:0 0 110px; color:var(--text-dim); font-size:11px; font-family:var(--mono); }
      .row .content { flex:1; word-wrap:break-word; word-break:break-word; }
      .row .delete { background:none; border:none; color:var(--err); cursor:pointer; opacity:0.5; }
      .row:hover .delete { opacity:1; }
      .badge { display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; background:var(--accent-soft); color:var(--accent); margin-right:6px; }
      .badge.message { background:rgba(56,139,253,0.18); color:#79b8ff; }
      .badge.memory  { background:rgba(111,229,164,0.18); color:#7ee5a8; }
      .badge.note    { background:rgba(229,179,74,0.18); color:#e5b34a; }
      .score { font-family:var(--mono); color:var(--accent); font-weight:600; font-size:12px; }
    </style>
    <script>
      // ─── Stats ───────────────────────────────
      async function loadStats(){
        try {
          const s = await (await fetch('/api/memory/vectors/stats')).json();
          const el = document.getElementById('vec-stats');
          if (!s.enabled) { el.innerHTML = '<span class="err">Vector-Memory deaktiviert (VECTOR_MEMORY_ENABLED=false)</span>'; return; }
          if (s.error)    { el.innerHTML = '<span class="err">Qdrant-Fehler: '+s.error+'</span>'; return; }
          const t = s.types || {};
          el.innerHTML = \`
            <div class="stat"><span class="v">\${s.total||0}</span><span class="l">Total Vektoren</span></div>
            <div class="stat"><span class="v">\${t.message||0}</span><span class="l">Messages</span></div>
            <div class="stat"><span class="v">\${t.memory||0}</span><span class="l">Memory</span></div>
            <div class="stat"><span class="v">\${t.note||0}</span><span class="l">Notes</span></div>
            <div class="stat"><span class="v" style="font-size:13px;">\${s.collection}</span><span class="l">Collection (\${s.dim}d, \${s.status})</span></div>
          \`;
        } catch (e) {
          document.getElementById('vec-stats').innerHTML = '<span class="err">Stats nicht erreichbar: '+e.message+'</span>';
        }
      }
      // ─── Tabs ────────────────────────────────
      function setTab(t){
        document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab===t));
        document.querySelectorAll('.tab-pane').forEach(p => p.style.display = (p.id==='tab-'+t) ? '' : 'none');
        if (t==='browse' && !browseLoaded) loadBrowse(true);
      }
      // ─── Explicit memory (SQLite) ────────────
      async function loadMem(){
        const cat=document.getElementById('cat').value, q=document.getElementById('q').value.trim();
        const params=new URLSearchParams(); if(cat)params.set('category',cat); if(q)params.set('q',q);
        const r=await fetch('/api/memory?'+params).then(r=>r.json());
        document.getElementById('mem-list').innerHTML = r.items.length?r.items.map(m=>\`
          <div class="row"><div class="meta">#\${m.id}<br>\${m.added||''}</div>
          <div class="content"><span class="badge">\${m.category}</span>\${m.key?'<strong>'+escapeHtml(m.key)+':</strong> ':''}\${escapeHtml(m.value)}</div>
          <button class="delete" onclick="delMem(\${m.id})">✕</button></div>
        \`).join(''):'<p class="dim">keine Einträge</p>';
      }
      async function addMem(){
        const body={category:document.getElementById('new-cat').value,key:document.getElementById('new-key').value.trim()||null,value:document.getElementById('new-val').value.trim()};
        if(!body.value)return alert('Wert leer');
        await fetch('/api/memory',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        document.getElementById('new-val').value=''; document.getElementById('new-key').value=''; loadMem(); loadStats();
      }
      async function delMem(id){if(!confirm('löschen?'))return; await fetch('/api/memory/'+id,{method:'DELETE'}); loadMem(); loadStats();}
      // ─── Semantic Search ─────────────────────
      async function doSearch(){
        const query = document.getElementById('sq').value.trim();
        const limit = Number(document.getElementById('sk').value);
        if (!query) return;
        const el = document.getElementById('sresults');
        el.innerHTML = '<p class="dim">⏳ embedding + suche…</p>';
        try {
          const r = await fetch('/api/memory/search/semantic', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query, limit})});
          const d = await r.json();
          if (!d.results?.length) { el.innerHTML = '<p class="dim">keine Treffer</p>'; return; }
          el.innerHTML = d.results.map(p => renderPoint(p)).join('');
        } catch (e) { el.innerHTML = '<p class="dim">Fehler: '+e.message+'</p>'; }
      }
      // ─── Vector-Browser ──────────────────────
      let browseLoaded = false, browseOffset = null;
      async function loadBrowse(reset){
        const type = document.getElementById('bt').value;
        if (reset) { browseOffset = null; document.getElementById('bresults').innerHTML = ''; }
        const params = new URLSearchParams(); params.set('limit', 30);
        if (type) params.set('type', type);
        if (browseOffset != null) params.set('offset', browseOffset);
        try {
          const r = await fetch('/api/memory/vectors/browse?'+params);
          const d = await r.json();
          const list = document.getElementById('bresults');
          if (reset && (!d.points || !d.points.length)) { list.innerHTML = '<p class="dim">keine Vektoren</p>'; return; }
          list.insertAdjacentHTML('beforeend', d.points.map(p => renderPoint(p)).join(''));
          browseOffset = d.next;
          document.getElementById('bmore').style.display = d.next != null ? '' : 'none';
          browseLoaded = true;
        } catch (e) { document.getElementById('bresults').innerHTML = '<p class="dim">Fehler: '+e.message+'</p>'; }
      }
      async function cleanup(){
        if (!confirm('Alle Vektoren mit type=kb oder type=chat (V1-Migrations-Altlast) endgültig aus Qdrant löschen?')) return;
        try {
          const r = await fetch('/api/memory/vectors/cleanup', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
          const d = await r.json();
          alert('Cleanup:\\n' + JSON.stringify(d, null, 2));
          loadStats(); loadBrowse(true);
        } catch (e) { alert('Fehler: '+e.message); }
      }
      async function reindex(){
        if (!confirm('Alle Messages, Memory-Einträge und Notes neu vektorisieren? (kann je nach Anzahl 1-5 Min dauern)')) return;
        const el = document.getElementById('bresults');
        el.innerHTML = '<p class="dim">⏳ re-indexing…</p>';
        try {
          const r = await fetch('/api/memory/vectors/reindex', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
          const d = await r.json();
          alert('Re-Index abgeschlossen:\\n' + JSON.stringify(d.reindexed, null, 2));
          loadStats(); loadBrowse(true);
        } catch (e) { alert('Fehler: '+e.message); }
      }
      // ─── Render ──────────────────────────────
      function renderPoint(p){
        const pl = p.payload || {};
        const t = pl.type || '?';
        const score = (typeof p.score === 'number') ? '<span class="score">'+p.score.toFixed(3)+'</span><br>' : '';
        const id = '#'+p.id;
        const meta = pl.chat_id ? 'chat:'+pl.chat_id+(pl.role?' '+pl.role:'') : (pl.filename || (pl.category||''));
        return \`<div class="row">
          <div class="meta">\${score}\${id}<br>\${escapeHtml(meta)}</div>
          <div class="content"><span class="badge \${t}">\${t}</span>\${escapeHtml((pl.text||'').substring(0, 400))}</div>
        </div>\`;
      }
      function escapeHtml(s){return (s||'').toString().replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
      // Init
      loadStats(); loadMem();
      document.getElementById('sq').addEventListener('keydown', e => { if (e.key==='Enter') doSearch(); });
    </script>`;
}

function remindersBody() {
  return `
    <div class="page-head"><h2>Reminders</h2></div>
    <h3>Neu</h3>
    <div class="add-form">
      <input id="r-text" placeholder="Erinnerungstext…" class="input">
      <input id="r-due" type="datetime-local" class="input">
      <select id="r-type" class="input"><option value="oneshot">einmalig</option><option value="recurring">wiederholt</option></select>
      <input id="r-int" type="number" step="0.5" placeholder="Intervall h (nur recurring)" class="input">
      <button class="btn primary" onclick="addRem()">speichern</button>
    </div>
    <h3 style="margin-top:24px">Offen</h3>
    <div id="r-open" class="list"></div>
    <h3 style="margin-top:24px">Erledigt (letzte 30)</h3>
    <div id="r-done" class="list"></div>
    <style>
      .add-form { display:flex; flex-direction:column; gap:8px; max-width:600px; }
      .add-form .input { width:100%; }
      .input { padding:8px 12px; background:var(--bg-card); border:1px solid var(--border); border-radius:6px; color:var(--text); font-family:var(--font); font-size:14px; }
      .list { display:flex; flex-direction:column; gap:6px; margin-top:8px; }
      .row { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); padding:10px 14px; display:flex; gap:12px; align-items:center; }
      .row.overdue { border-color: var(--warn); }
      .row .due { flex:0 0 130px; color:var(--text-dim); font-size:12px; font-family:var(--mono); }
      .row .text { flex:1; word-wrap:break-word; }
      .row .badge { padding:2px 6px; border-radius:4px; font-size:10px; background:var(--bg-elevated); color:var(--text-dim); }
      .row button { background:none; border:1px solid var(--border); color:var(--text-dim); padding:4px 8px; border-radius:4px; cursor:pointer; font-size:12px; }
    </style>
    <script>
      async function loadRem(){
        const open = (await (await fetch('/api/reminders?done=0')).json()).items;
        const done = (await (await fetch('/api/reminders?done=1')).json()).items.slice(-30).reverse();
        const now=new Date();
        document.getElementById('r-open').innerHTML = open.length?open.map(r=>{
          const ov=new Date(r.due)<now;
          return \`<div class="row \${ov?'overdue':''}"><div class="due">\${r.due}</div><div class="text">\${escapeHtml(r.text)} \${r.type==='recurring'?\`<span class="badge">↻ \${r.interval_hours}h</span>\`:''}</div>
          <button onclick="markDone(\${r.id})">✓ done</button>
          <button onclick="delRem(\${r.id})">✕</button></div>\`;
        }).join(''):'<p class="dim">nichts offen</p>';
        document.getElementById('r-done').innerHTML = done.length?done.map(r=>\`
          <div class="row"><div class="due">\${r.due}</div><div class="text">\${escapeHtml(r.text)}</div><button onclick="delRem(\${r.id})">✕</button></div>
        \`).join(''):'<p class="dim">noch nichts erledigt</p>';
      }
      async function addRem(){
        const body={text:document.getElementById('r-text').value.trim(),due:document.getElementById('r-due').value,type:document.getElementById('r-type').value,interval_hours:Number(document.getElementById('r-int').value)||null};
        if(!body.text||!body.due)return alert('Text+Datum nötig');
        body.due=body.due.replace('T',' ');
        await fetch('/api/reminders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        document.getElementById('r-text').value=''; loadRem();
      }
      async function markDone(id){await fetch('/api/reminders/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({done:1})}); loadRem();}
      async function delRem(id){if(!confirm('löschen?'))return; await fetch('/api/reminders/'+id,{method:'DELETE'}); loadRem();}
      function escapeHtml(s){return s.replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
      loadRem();
    </script>`;
}

function contactsBody() {
  return `
    <div class="page-head"><h2>Kontakte</h2><button class="btn" onclick="openModal()">+ Neu</button></div>
    <input type="search" id="searchInput" placeholder="Suchen…" class="input" style="width:100%;margin-bottom:16px;" oninput="debounceLoad()">
    <div id="contactsList"></div>

    <!-- Modal -->
    <div id="modalOverlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:200;align-items:center;justify-content:center;">
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:24px;min-width:340px;max-width:480px;width:90%;">
        <h3 id="modalTitle" style="margin:0 0 16px;">Kontakt anlegen</h3>
        <input type="hidden" id="editId">
        <div class="form-row"><label>Name *</label><input id="fName" class="input" placeholder="Vollständiger Name"></div>
        <div class="form-row"><label>E-Mail (Arbeit)</label><input id="fEmailWork" class="input" type="email" placeholder="name@firma.de"></div>
        <div class="form-row"><label>E-Mail (Privat)</label><input id="fEmailPrivate" class="input" type="email" placeholder="name@gmail.com"></div>
        <div class="form-row"><label>Telegram-ID</label><input id="fTelegramId" class="input" placeholder="12345678"></div>
        <div class="form-row"><label>Telefon</label><input id="fPhone" class="input" placeholder="+49 ..."></div>
        <div class="form-row"><label>Tags (kommagetrennt)</label><input id="fTags" class="input" placeholder="familie, arbeit, freunde"></div>
        <div class="form-row"><label>Notizen</label><textarea id="fNotes" class="input" rows="3" style="resize:vertical;"></textarea></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
          <button class="btn" onclick="closeModal()">Abbrechen</button>
          <button class="btn" style="background:var(--accent-soft);color:var(--accent);" onclick="saveContact()">Speichern</button>
        </div>
      </div>
    </div>

    <style>
      .contact-card{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin-bottom:10px;display:grid;grid-template-columns:1fr auto;gap:8px;}
      .contact-card h3{margin:0 0 6px;font-size:15px;}
      .cf{font-size:13px;color:var(--text-dim);display:flex;gap:6px;align-items:baseline;}
      .cf a{color:var(--accent);text-decoration:none;}
      .fl{font-size:11px;color:var(--text-dim);min-width:80px;}
      .tag{background:var(--accent-soft);color:var(--accent);font-size:11px;padding:2px 6px;border-radius:10px;}
      .form-row{margin-bottom:10px;}
      .form-row label{display:block;font-size:12px;color:var(--text-dim);margin-bottom:4px;}
      .form-row .input{width:100%;box-sizing:border-box;}
    </style>
    <script>
    let contacts = [];
    let debTimer;
    function debounceLoad() { clearTimeout(debTimer); debTimer = setTimeout(load, 300); }

    async function load() {
      const q = document.getElementById('searchInput').value.trim();
      const url = q ? '/api/contacts/search?q=' + encodeURIComponent(q) : '/api/contacts';
      const r = await fetch(url);
      const data = await r.json();
      contacts = data.contacts || [];
      render();
    }

    function render() {
      const el = document.getElementById('contactsList');
      if (!contacts.length) { el.innerHTML = '<p style="color:var(--text-dim)">Keine Kontakte.</p>'; return; }
      el.innerHTML = contacts.map(c => \`
        <div class="contact-card">
          <div>
            <h3>\${esc(c.name)} \${tags(c.tags)}</h3>
            \${c.email_work ? \`<div class="cf"><span class="fl">Arbeit</span><a href="mailto:\${esc(c.email_work)}">\${esc(c.email_work)}</a></div>\` : ''}
            \${c.email_private ? \`<div class="cf"><span class="fl">Privat</span><a href="mailto:\${esc(c.email_private)}">\${esc(c.email_private)}</a></div>\` : ''}
            \${c.telegram_id ? \`<div class="cf"><span class="fl">Telegram</span>\${esc(c.telegram_id)}</div>\` : ''}
            \${c.phone ? \`<div class="cf"><span class="fl">Telefon</span><a href="tel:\${esc(c.phone)}">\${esc(c.phone)}</a></div>\` : ''}
            \${c.notes ? \`<div class="cf" style="margin-top:6px"><span class="fl">Notiz</span><span style="white-space:pre-wrap">\${esc(c.notes)}</span></div>\` : ''}
          </div>
          <div style="display:flex;gap:6px;align-items:flex-start;">
            <button class="btn" style="padding:4px 9px;font-size:12px;" onclick="openModal(\${c.id})">✎</button>
            <button class="btn" style="padding:4px 9px;font-size:12px;color:var(--err);" onclick="del(\${c.id})">🗑</button>
          </div>
        </div>
      \`).join('');
    }

    function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
    function tags(t){if(!t)return'';return t.split(',').map(s=>\`<span class="tag">\${esc(s.trim())}</span>\`).join(' ');}

    function openModal(id) {
      const c = id ? contacts.find(x=>x.id===id) : null;
      document.getElementById('modalTitle').textContent = c ? 'Kontakt bearbeiten' : 'Kontakt anlegen';
      document.getElementById('editId').value = c ? c.id : '';
      ['Name','EmailWork','EmailPrivate','TelegramId','Phone','Tags','Notes'].forEach(k => {
        const el = document.getElementById('f'+k);
        if (el) el.value = c ? (c[k.replace(/([A-Z])/g,'_$1').toLowerCase().replace(/^_/,'')] || '') : '';
      });
      const ov = document.getElementById('modalOverlay');
      ov.style.display = 'flex';
      document.getElementById('fName').focus();
    }

    function closeModal() { document.getElementById('modalOverlay').style.display = 'none'; }

    async function saveContact() {
      const id = document.getElementById('editId').value;
      const body = {
        name: document.getElementById('fName').value.trim(),
        email_work: document.getElementById('fEmailWork').value.trim() || null,
        email_private: document.getElementById('fEmailPrivate').value.trim() || null,
        telegram_id: document.getElementById('fTelegramId').value.trim() || null,
        phone: document.getElementById('fPhone').value.trim() || null,
        tags: document.getElementById('fTags').value.trim() || null,
        notes: document.getElementById('fNotes').value.trim() || null,
      };
      if (!body.name) { alert('Name ist Pflichtfeld'); return; }
      await fetch(id ? '/api/contacts/'+id : '/api/contacts', {
        method: id ? 'PUT' : 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
      });
      closeModal(); load();
    }

    async function del(id) {
      if (!confirm('Kontakt wirklich löschen?')) return;
      await fetch('/api/contacts/'+id, { method:'DELETE' });
      load();
    }

    document.getElementById('modalOverlay').addEventListener('click', e => { if(e.target===e.currentTarget) closeModal(); });
    document.addEventListener('keydown', e => { if(e.key==='Escape') closeModal(); });
    load();
    </script>`;
}

function newsBody() {
  return `
    <div class="page-head"><h2>News-Quellen</h2></div>
    <h3>Neu hinzufügen</h3>
    <div class="add-form">
      <select id="n-type" class="input"><option value="rss">RSS-Feed</option><option value="api">API</option></select>
      <input id="n-name" placeholder="Anzeigename" class="input">
      <input id="n-url" placeholder="URL" class="input">
      <input id="n-cat" placeholder="Kategorie (optional)" class="input">
      <input id="n-key" placeholder="API-Key (nur wenn nötig)" class="input">
      <button class="btn primary" onclick="addSource()">speichern</button>
    </div>
    <h3 style="margin-top:24px">Aktive Quellen</h3>
    <div id="src-list" class="list"></div>
    <style>
      .add-form { display:flex; flex-direction:column; gap:8px; max-width:600px; }
      .add-form .input { width:100%; }
      .input { padding:8px 12px; background:var(--bg-card); border:1px solid var(--border); border-radius:6px; color:var(--text); font-family:var(--font); font-size:14px; }
      .list { display:flex; flex-direction:column; gap:6px; margin-top:12px; }
      .row { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); padding:12px 16px; display:flex; gap:12px; align-items:center; }
      .row .name { flex:0 0 200px; font-weight:600; }
      .row .url { flex:1; color:var(--text-dim); font-size:12px; font-family:var(--mono); word-break:break-all; }
      .row .badge { padding:2px 6px; border-radius:4px; font-size:10px; background:var(--bg-elevated); color:var(--text-dim); margin-right:8px; }
      .toggle { padding:4px 10px; border-radius:6px; cursor:pointer; font-size:12px; border:1px solid var(--border); }
      .toggle.on { color:var(--ok); border-color:var(--ok); }
      .toggle.off { color:var(--err); border-color:var(--err); }
    </style>
    <script>
      async function loadSources(){
        const r = await (await fetch('/api/news/sources')).json();
        document.getElementById('src-list').innerHTML = r.items.length?r.items.map(s=>\`
          <div class="row"><div class="name"><span class="badge">\${s.type}</span>\${escapeHtml(s.name)}</div>
          <div class="url">\${escapeHtml(s.url)}\${s.category?' · '+s.category:''}</div>
          <button class="toggle \${s.enabled?'on':'off'}" onclick="toggleSrc(\${s.id},\${s.enabled?0:1})">\${s.enabled?'on':'off'}</button>
          <button onclick="delSrc(\${s.id})" class="toggle">✕</button></div>
        \`).join(''):'<p class="dim">keine Quellen</p>';
      }
      async function addSource(){
        const body={type:document.getElementById('n-type').value,name:document.getElementById('n-name').value.trim(),url:document.getElementById('n-url').value.trim(),category:document.getElementById('n-cat').value.trim()||null,api_key:document.getElementById('n-key').value.trim()||null};
        if(!body.name||!body.url)return alert('Name+URL nötig');
        await fetch('/api/news/sources',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        document.getElementById('n-name').value='';document.getElementById('n-url').value='';loadSources();
      }
      async function toggleSrc(id,enabled){await fetch('/api/news/sources/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled})}); loadSources();}
      async function delSrc(id){if(!confirm('löschen?'))return; await fetch('/api/news/sources/'+id,{method:'DELETE'}); loadSources();}
      function escapeHtml(s){return s.replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
      loadSources();
    </script>`;
}

function healthBody() {
  return `
    <style>
      .h-page-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:20px; flex-wrap:wrap; gap:8px; }
      .h-page-head h2 { margin:0; }
      .h-ts { font-size:12px; color:var(--text-dim); font-family:var(--mono); }
      .h-actions { display:flex; gap:8px; align-items:center; }

      /* Section titles */
      .sec-title { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--text-dim);
                   border-bottom:1px solid var(--border); padding-bottom:6px; margin:24px 0 14px; }

      /* Hardware metric cards */
      .hw-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:12px; }
      .hw-card { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); padding:16px 18px; }
      .hw-card .hw-label { font-size:11px; text-transform:uppercase; color:var(--text-dim); margin-bottom:6px; letter-spacing:.05em; }
      .hw-card .hw-val { font-size:22px; font-weight:700; font-family:var(--mono); color:var(--text); line-height:1.1; }
      .hw-card .hw-sub { font-size:11px; color:var(--text-dim); margin-top:4px; }
      .hw-bar-wrap { margin-top:10px; background:var(--bg-elevated); border-radius:4px; height:6px; overflow:hidden; }
      .hw-bar { height:6px; border-radius:4px; transition:width .4s; }
      .bar-ok  { background:var(--ok); }
      .bar-warn { background:var(--warn); }
      .bar-err  { background:var(--err); }

      /* Services table */
      .svc-table { width:100%; border-collapse:collapse; }
      .svc-table th { font-size:11px; text-transform:uppercase; color:var(--text-dim); padding:6px 10px; text-align:left; border-bottom:1px solid var(--border); }
      .svc-table td { padding:9px 10px; border-bottom:1px solid var(--border); font-size:13px; }
      .svc-table tr:last-child td { border-bottom:none; }
      .badge { display:inline-flex; align-items:center; gap:5px; padding:2px 9px; border-radius:100px; font-size:12px; font-weight:600; }
      .badge.ok  { background:rgba(111,229,164,0.15); color:var(--ok); border:1px solid var(--ok); }
      .badge.err { background:rgba(255,107,122,0.15); color:var(--err); border:1px solid var(--err); }
      .ms { font-family:var(--mono); font-size:11px; color:var(--text-dim); }
      .svc-err { font-family:var(--mono); font-size:11px; color:var(--err); }

      /* Container rows */
      .ct-row { display:flex; align-items:center; padding:10px 14px; background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); margin-bottom:8px; gap:12px; }
      .ct-name { font-family:var(--mono); font-size:13px; flex:1; }
      .ct-status { flex:0 0 120px; }
      .ct-action { flex-shrink:0; }
      .ct-msg { font-size:11px; color:var(--accent); margin-left:8px; }

      /* Systemaktionen */
      .sys-box { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); padding:18px; }
      .sys-box .dim { font-size:12px; color:var(--text-dim); margin-top:10px; }

      @media(max-width:500px){
        .hw-grid { grid-template-columns:1fr 1fr; }
        .ct-status { display:none; }
      }
    </style>

    <div class="h-page-head">
      <h2>Health</h2>
      <div class="h-actions">
        <span class="h-ts">zuletzt aktualisiert: <span id="h-ts">–</span></span>
        <button class="btn" onclick="refreshAll()">↻ refresh</button>
      </div>
    </div>

    <!-- Hardware -->
    <h3 class="sec-title">Hardware</h3>
    <div id="hw-grid" class="hw-grid">
      <div class="hw-card"><div class="hw-label">CPU</div><div class="hw-val">–</div></div>
    </div>

    <!-- Dienste -->
    <h3 class="sec-title">Dienste</h3>
    <div style="overflow-x:auto;">
      <table class="svc-table">
        <thead><tr><th>Service</th><th>Status</th><th>Latenz</th><th>Detail</th></tr></thead>
        <tbody id="svc-body"><tr><td colspan="4" class="dim">lade…</td></tr></tbody>
      </table>
    </div>

    <!-- Docker Container -->
    <h3 class="sec-title">Docker Container</h3>
    <div id="ct-list">lade…</div>

    <!-- Systemaktionen -->
    <h3 class="sec-title">Systemaktionen</h3>
    <div class="sys-box">
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
        <button class="btn primary" onclick="stackRestart()">↻ Stack restart</button>
        <span id="stack-msg" class="ct-msg"></span>
      </div>
      <p class="dim">Startet kiasy-core und kiasy-monitor nacheinander neu. Core-Neustart dauert ~5–10s, Monitor-Seite lädt danach automatisch neu.</p>
      <p class="dim" style="margin-top:6px;">Hardware-Reboot: noch nicht implementiert</p>
    </div>

    <script>
    const CONTAINERS = [
      'kiasy-core','kiasy-monitor','kiasy-caddy',
      'kiasy-piper','kiasy-whisper','kiasy-ollama','kiasy-searxng','kiasy-qdrant'
    ];

    // Map service-check names to container names (for status inference)
    const SVC_TO_CT = {
      ollama: 'kiasy-ollama', qdrant: 'kiasy-qdrant',
      whisper: 'kiasy-whisper', searxng: 'kiasy-searxng', piper: 'kiasy-piper'
    };

    let lastSvcChecks = [];

    function barClass(pct) {
      if (pct < 70) return 'bar-ok';
      if (pct < 88) return 'bar-warn';
      return 'bar-err';
    }

    async function loadHw() {
      try {
        const d = await fetch('/health/hw').then(r => r.json());
        const load1 = d.cpu.load_1.toFixed(2);
        const loadPct = Math.min(100, Math.round((d.cpu.load_1 / d.cpu.cores) * 100));
        const tempHtml = d.temp_c != null
          ? \`<div class="hw-card"><div class="hw-label">CPU Temp</div><div class="hw-val">\${d.temp_c}°C</div></div>\`
          : '';
        document.getElementById('hw-grid').innerHTML = \`
          <div class="hw-card">
            <div class="hw-label">CPU Load</div>
            <div class="hw-val">\${load1}</div>
            <div class="hw-sub">\${d.cpu.cores} Kerne · 1/5/15min: \${d.cpu.load_1.toFixed(2)} / \${d.cpu.load_5.toFixed(2)} / \${d.cpu.load_15.toFixed(2)}</div>
            <div class="hw-bar-wrap"><div class="hw-bar \${barClass(loadPct)}" style="width:\${loadPct}%"></div></div>
          </div>
          <div class="hw-card">
            <div class="hw-label">RAM</div>
            <div class="hw-val">\${d.memory.pct}%</div>
            <div class="hw-sub">\${d.memory.used} / \${d.memory.total}</div>
            <div class="hw-bar-wrap"><div class="hw-bar \${barClass(d.memory.pct)}" style="width:\${d.memory.pct}%"></div></div>
          </div>
          <div class="hw-card">
            <div class="hw-label">Disk /</div>
            <div class="hw-val">\${d.disk.pct}%</div>
            <div class="hw-sub">\${d.disk.used} / \${d.disk.total} · frei: \${d.disk.free}</div>
            <div class="hw-bar-wrap"><div class="hw-bar \${barClass(d.disk.pct)}" style="width:\${d.disk.pct}%"></div></div>
          </div>
          <div class="hw-card">
            <div class="hw-label">Uptime</div>
            <div class="hw-val" style="font-size:16px;padding-top:4px;">\${d.uptime}</div>
          </div>
          \${tempHtml}
        \`;
      } catch (e) {
        document.getElementById('hw-grid').innerHTML = \`<div class="hw-card"><div class="hw-val" style="color:var(--err)">Fehler</div><div class="hw-sub">\${e.message}</div></div>\`;
      }
    }

    async function loadSvcs() {
      try {
        const h = await fetch('/api/health/check').then(r => r.json());
        lastSvcChecks = h.checks || [];
        document.getElementById('svc-body').innerHTML = lastSvcChecks.map(c => \`
          <tr>
            <td><b>\${c.name}</b></td>
            <td><span class="badge \${c.ok ? 'ok' : 'err'}">\${c.ok ? '✓ online' : '✗ offline'}</span></td>
            <td><span class="ms">\${c.latency_ms != null ? c.latency_ms + 'ms' : '–'}</span></td>
            <td>\${c.error ? '<span class="svc-err">' + c.error + '</span>' : ''}</td>
          </tr>
        \`).join('');
        renderContainers();
      } catch (e) {
        document.getElementById('svc-body').innerHTML = \`<tr><td colspan="4" style="color:var(--err)">\${e.message}</td></tr>\`;
      }
    }

    function ctStatus(name) {
      // Monitor + Caddy: Seite wurde ausgeliefert → beide laufen definitiv
      if (name === 'kiasy-monitor' || name === 'kiasy-caddy') {
        return '<span class="badge ok">✓ läuft</span>';
      }
      // Core: health/check-Daten kommen von Core → wenn wir Daten haben, läuft Core
      if (name === 'kiasy-core') {
        return lastSvcChecks.length > 0
          ? '<span class="badge ok">✓ läuft</span>'
          : '<span class="badge err">✗ offline</span>';
      }
      // Restliche Services: aus health/check-Ergebnissen ableiten
      for (const [svcName, ctName] of Object.entries(SVC_TO_CT)) {
        if (ctName === name) {
          const chk = lastSvcChecks.find(c => c.name === svcName);
          if (chk) return chk.ok
            ? '<span class="badge ok">✓ läuft</span>'
            : '<span class="badge err">✗ offline</span>';
        }
      }
      return '<span class="badge" style="color:var(--text-dim);border-color:var(--border)">– unbekannt</span>';
    }

    function renderContainers() {
      document.getElementById('ct-list').innerHTML = CONTAINERS.map(name => \`
        <div class="ct-row" id="ct-\${name}">
          <div class="ct-name">\${name}</div>
          <div class="ct-status">\${ctStatus(name)}</div>
          <div class="ct-action">
            <button class="btn" onclick="restartContainer('\${name}')">↻ Restart</button>
            <span class="ct-msg" id="msg-\${name}"></span>
          </div>
        </div>
      \`).join('');
    }

    async function restartContainer(name) {
      const msgEl = document.getElementById('msg-' + name);
      msgEl.textContent = '…';
      try {
        const r = await fetch('/api/restart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ service: name })
        });
        const d = await r.json();
        if (r.ok) {
          if (name === 'kiasy-monitor' || name === 'kiasy-core') {
            msgEl.textContent = 'Container startet neu — Seite lädt in 10s';
            setTimeout(() => location.reload(), 10000);
          } else {
            msgEl.textContent = 'neu gestartet ✓';
            setTimeout(() => { msgEl.textContent = ''; }, 5000);
          }
        } else {
          msgEl.style.color = 'var(--err)';
          msgEl.textContent = d.error || 'Fehler';
        }
      } catch (e) {
        msgEl.style.color = 'var(--err)';
        msgEl.textContent = e.message;
      }
    }

    async function stackRestart() {
      const msg = document.getElementById('stack-msg');
      msg.textContent = 'Starte core neu…';
      try {
        await fetch('/api/restart', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({service:'kiasy-core'}) });
        msg.textContent = 'core restartet. Starte monitor neu…';
        setTimeout(async () => {
          await fetch('/api/restart', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({service:'kiasy-monitor'}) });
          msg.textContent = 'monitor restartet — Seite lädt in 10s';
          setTimeout(() => location.reload(), 10000);
        }, 3000);
      } catch(e) {
        msg.style.color = 'var(--err)';
        msg.textContent = e.message;
      }
    }

    function updateTs() {
      const now = new Date();
      document.getElementById('h-ts').textContent =
        now.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    }

    async function refreshAll() {
      updateTs();
      await Promise.all([loadHw(), loadSvcs()]);
    }

    // Initial render of container list immediately (before svc data)
    renderContainers();
    refreshAll();
    setInterval(refreshAll, 20000);
    </script>`;
}

function filesBody() {
  return `
    <div class="page-head" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:16px;">
      <h2 style="margin:0">Dateien</h2>
      <div style="display:flex;gap:8px;align-items:center;">
        <span id="fb-count" class="dim" style="font-size:12px;"></span>
        <button class="btn" onclick="fbLoad()">↻ refresh</button>
      </div>
    </div>

    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
      <button class="btn fb-tab active" data-dir="all"    onclick="fbSetTab(this,'all')">Alle</button>
      <button class="btn fb-tab"        data-dir="images" onclick="fbSetTab(this,'images')">Bilder</button>
      <button class="btn fb-tab"        data-dir="exports" onclick="fbSetTab(this,'exports')">Dokumente</button>
    </div>

    <div id="fb-grid"></div>

    <!-- Lightbox -->
    <div id="fb-lb" onclick="fbCloseLb()" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:999;align-items:center;justify-content:center;cursor:zoom-out;">
      <img id="fb-lb-img" style="max-width:92vw;max-height:92vh;border-radius:8px;box-shadow:0 8px 40px #000;" src="">
    </div>

    <style>
      .fb-tab.active { background:var(--accent);color:#000;border-color:var(--accent); }
      .fb-img-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:12px; }
      .fb-img-card { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); overflow:hidden; position:relative; }
      .fb-img-card img { width:100%; aspect-ratio:1; object-fit:cover; display:block; cursor:zoom-in; transition:opacity .2s; }
      .fb-img-card img:hover { opacity:.85; }
      .fb-img-info { padding:8px 10px; }
      .fb-img-name { font-size:11px; color:var(--text-dim); font-family:var(--mono); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .fb-img-meta { font-size:10px; color:var(--text-dim); margin-top:2px; }
      .fb-img-actions { display:flex; gap:6px; padding:0 8px 8px; }
      .fb-doc-table { width:100%; border-collapse:collapse; }
      .fb-doc-table th { font-size:11px; text-transform:uppercase; color:var(--text-dim); padding:6px 10px; text-align:left; border-bottom:1px solid var(--border); }
      .fb-doc-table td { padding:9px 10px; border-bottom:1px solid var(--border); font-size:13px; vertical-align:middle; }
      .fb-doc-table tr:last-child td { border-bottom:none; }
      .fb-doc-table tr:hover td { background:var(--bg-elevated); }
      .fb-ext { display:inline-block; padding:1px 6px; border-radius:4px; font-size:10px; font-family:var(--mono); background:var(--bg-elevated); color:var(--text-dim); margin-right:4px; }
      .fb-del { color:var(--err); border-color:var(--err); }
      .fb-del:hover { background:rgba(255,107,122,.12); }
      @media(max-width:480px){ .fb-img-grid { grid-template-columns:repeat(auto-fill,minmax(130px,1fr)); } }
    </style>

    <script>
    let fbDir = 'all';
    let fbFiles = [];

    function fbSetTab(el, dir) {
      document.querySelectorAll('.fb-tab').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
      fbDir = dir;
      fbLoad();
    }

    function fmtSize(b) {
      if (b < 1024) return b + ' B';
      if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
      return (b/1024/1024).toFixed(1) + ' MB';
    }
    function fmtDate(ms) {
      return new Date(ms).toLocaleString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
    }

    async function fbLoad() {
      document.getElementById('fb-grid').innerHTML = '<p class="dim">lade…</p>';
      try {
        const d = await fetch('/api/files?dir=' + fbDir).then(r => r.json());
        fbFiles = d.files || [];
        document.getElementById('fb-count').textContent = fbFiles.length + ' Datei' + (fbFiles.length !== 1 ? 'en' : '');
        fbRender();
      } catch(e) {
        document.getElementById('fb-grid').innerHTML = \`<p style="color:var(--err)">Fehler: \${e.message}</p>\`;
      }
    }

    function fbRender() {
      const images = fbFiles.filter(f => f.is_image);
      const docs   = fbFiles.filter(f => !f.is_image);
      let html = '';

      if (images.length) {
        html += \`<h3 style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-dim);border-bottom:1px solid var(--border);padding-bottom:6px;margin:0 0 14px;">Bilder (\${images.length})</h3>\`;
        html += '<div class="fb-img-grid">';
        html += images.map(f => \`
          <div class="fb-img-card">
            <img src="\${f.url}?preview=1" alt="\${f.name}" loading="lazy" onclick="fbOpenLb('\${f.url}?preview=1')">
            <div class="fb-img-info">
              <div class="fb-img-name" title="\${f.name}">\${f.name}</div>
              <div class="fb-img-meta">\${fmtSize(f.size)} · \${fmtDate(f.mtime)}</div>
            </div>
            <div class="fb-img-actions">
              <a class="btn" style="font-size:11px;padding:3px 8px;" href="\${f.url}" download="\${f.name}">↓</a>
              <button class="btn fb-del" style="font-size:11px;padding:3px 8px;" onclick="fbDelete('\${f.dir}','\${f.name}')">✕</button>
            </div>
          </div>
        \`).join('');
        html += '</div>';
        if (docs.length) html += '<div style="margin-top:24px;"></div>';
      }

      if (docs.length) {
        html += \`<h3 style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-dim);border-bottom:1px solid var(--border);padding-bottom:6px;margin:0 0 14px;">Dokumente (\${docs.length})</h3>\`;
        html += '<div style="overflow-x:auto;"><table class="fb-doc-table"><thead><tr><th>Name</th><th>Größe</th><th>Datum</th><th></th></tr></thead><tbody>';
        html += docs.map(f => \`
          <tr>
            <td><span class="fb-ext">\${f.ext}</span>\${f.name}</td>
            <td style="white-space:nowrap;color:var(--text-dim);font-size:12px;">\${fmtSize(f.size)}</td>
            <td style="white-space:nowrap;color:var(--text-dim);font-size:12px;">\${fmtDate(f.mtime)}</td>
            <td style="white-space:nowrap;">
              <a class="btn" style="font-size:11px;padding:3px 10px;" href="\${f.url}" download="\${f.name}">↓ Download</a>
              <button class="btn fb-del" style="font-size:11px;padding:3px 8px;margin-left:4px;" onclick="fbDelete('\${f.dir}','\${f.name}')">✕</button>
            </td>
          </tr>
        \`).join('');
        html += '</tbody></table></div>';
      }

      if (!images.length && !docs.length) {
        html = '<p class="dim" style="padding:32px 0;text-align:center;">Noch keine Dateien vorhanden.</p>';
      }
      document.getElementById('fb-grid').innerHTML = html;
    }

    function fbOpenLb(src) {
      const lb = document.getElementById('fb-lb');
      document.getElementById('fb-lb-img').src = src;
      lb.style.display = 'flex';
    }
    function fbCloseLb() {
      document.getElementById('fb-lb').style.display = 'none';
      document.getElementById('fb-lb-img').src = '';
    }
    document.addEventListener('keydown', e => { if (e.key === 'Escape') fbCloseLb(); });

    async function fbDelete(dir, name) {
      if (!confirm('Datei löschen: ' + name + '?')) return;
      const url = dir === 'images' ? '/api/images/' + encodeURIComponent(name) : '/api/files/' + encodeURIComponent(name);
      try {
        const r = await fetch(url, { method: 'DELETE' });
        if (!r.ok) { const d = await r.json(); alert('Fehler: ' + (d.error || r.status)); return; }
        fbLoad();
      } catch(e) { alert('Fehler: ' + e.message); }
    }

    fbLoad();
    </script>`;
}

function settingsBody() {
  return `
    <div class="page-head"><h2>Settings</h2>
      <div style="display:flex;gap:8px;">
        <button class="btn" onclick="saveAll(false)">💾 Speichern</button>
        <button class="btn primary" onclick="saveAll(true)">💾 Speichern + Recreate</button>
      </div>
    </div>
    <p class="dim">Änderungen werden in <code>.env</code> geschrieben. <b>Recreate</b> startet kiasy-core via deploy-Sidecar automatisch neu (5–10s).</p>
    <div id="settings-form"></div>
    <div class="sec" style="margin-top:12px;">
      <h3>CalDAV-Test</h3>
      <p class="dim" style="font-size:12px;margin-bottom:8px;">Probt die Verbindung mit den oben gespeicherten CalDAV-Werten.</p>
      <button class="btn" onclick="probeCal()">🩺 Verbindung testen</button>
      <pre id="cal-probe" style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;padding:10px;font-family:var(--mono);font-size:12px;margin-top:8px;display:none;white-space:pre-wrap;"></pre>
    </div>
    <div class="sec" style="margin-top:12px;">
      <h3>System-Prompt (Agent-Persönlichkeit)</h3>
      <p class="dim" style="font-size:12px;margin-bottom:8px;">Wird bei jeder Anfrage als <code>system</code>-Message ans LLM geschickt. <b>Hot-Reload:</b> Speichern reicht — kein Container-Recreate. Leeres Feld = Default-Prompt (siehe Platzhalter im Textarea unten).</p>
      <textarea id="sys-prompt" rows="14" style="width:100%;background:var(--bg-elevated);border:1px solid var(--border);color:var(--text);border-radius:4px;font-family:var(--mono);font-size:13px;padding:10px;" placeholder="(leer = Default — siehe unten)"></textarea>
      <div style="margin-top:8px;display:flex;gap:8px;align-items:center;">
        <button class="btn primary" onclick="savePrompt()">💾 Prompt speichern</button>
        <button class="btn" onclick="resetPrompt()">↺ Auf Default zurücksetzen</button>
        <span id="prompt-msg" class="dim" style="font-size:12px;"></span>
      </div>
      <details style="margin-top:10px;">
        <summary class="dim" style="cursor:pointer;font-size:12px;">Aktuell aktiver Prompt anzeigen (Default oder Custom)</summary>
        <pre id="prompt-active" style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;padding:10px;font-family:var(--mono);font-size:12px;margin-top:8px;white-space:pre-wrap;max-height:400px;overflow:auto;"></pre>
      </details>
    </div>
    <div class="sec" style="margin-top:12px;">
      <h3>Mail-Signatur</h3>
      <p class="dim" style="font-size:12px;margin-bottom:8px;">Wird an jede via <code>mail_send</code> verschickte Mail angehängt (Standard-Trenner <code>-- </code>). Datei: <code>/data/mail-signature.txt</code>.</p>
      <textarea id="mail-sig" rows="8" style="width:100%;background:var(--bg-elevated);border:1px solid var(--border);color:var(--text);border-radius:4px;font-family:var(--mono);font-size:13px;padding:10px;" placeholder="Viele Grüße&#10;Michael Dedecke&#10;..."></textarea>
      <div style="margin-top:8px;display:flex;gap:8px;align-items:center;">
        <button class="btn primary" onclick="saveSig()">💾 Signatur speichern</button>
        <span id="sig-msg" class="dim" style="font-size:12px;"></span>
      </div>
    </div>
    <div id="save-result" style="margin-top:16px;"></div>
    <style>
      .sec { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); padding:18px; margin-bottom:12px; }
      .sec h3 { font-size:14px; color:var(--text-dim); text-transform:uppercase; margin-bottom:12px; }
      .kv { display:flex; align-items:center; padding:8px 0; border-bottom:1px solid var(--border); font-family:var(--mono); font-size:13px; gap:12px; }
      .kv:last-child { border-bottom:none; }
      .kv .k { flex:0 0 220px; color:var(--text-dim); }
      .kv .v input, .kv .v select { width:100%; padding:6px 10px; background:var(--bg-elevated); border:1px solid var(--border); color:var(--text); border-radius:4px; font-family:var(--mono); font-size:13px; }
      .kv .v.toggle { display:flex; align-items:center; gap:8px; }
      .kv .v label { cursor:pointer; }
      .kv .v { flex:1; }
      code { background:var(--bg-elevated); padding:2px 6px; border-radius:3px; font-family:var(--mono); font-size:12px; }
      .save-msg { padding:12px 16px; border-radius:var(--radius); }
      .save-msg.ok { background:rgba(111,229,164,0.12); border:1px solid var(--ok); color:var(--ok); }
      .save-msg.err { background:rgba(255,107,122,0.12); border:1px solid var(--err); color:var(--err); }
      .save-msg pre { font-family:var(--mono); font-size:12px; margin-top:8px; padding:8px 12px; background:var(--bg-elevated); border-radius:6px; overflow-x:auto; }
    </style>
    <script>
      const FIELDS = {
        'Allgemein': [
          ['BOT_NAME', 'Assistenten-Name (Header, Titel, Agent-Prompt)', 'text'],
          ['OWNER_NAME', 'Dein Name', 'text']
        ],
        'LLM-Modelle (3 Rollen)': [
          ['LLM_PROVIDER', 'Default-Provider', 'select', ['ollama','anthropic']],
          ['OLLAMA_MODEL', 'Chat-Modell (Hauptantworten)', 'text'],
          ['OLLAMA_MODEL_CHEAP', 'Cheap-Modell (Klassifikation, Routing)', 'text'],
          ['OLLAMA_MODEL_EMBED', 'Embedding-Modell (Vector-Memory)', 'text'],
          ['OLLAMA_MODEL_CODE',  'Coding-Modell (Tool-Generator)', 'text'],
          ['ANTHROPIC_MODEL', 'Anthropic Model (Fallback)', 'text'],
          ['MAX_TOKENS', 'Max Tokens', 'text']
        ],
        'Voice': [
          ['WHISPER_MODEL', 'Whisper Model', 'select', ['tiny','base','small','medium','large-v3']],
          ['PIPER_VOICE', 'Piper Voice', 'text']
        ],
        'Subsysteme (Restart nötig)': [
          ['TELEGRAM_ENABLED', 'Telegram-Bot', 'bool'],
          ['SCHEDULER_ENABLED', 'Reminder-Scheduler', 'bool'],
          ['MAIL_WATCHER_ENABLED', 'Mail-Watcher', 'bool'],
          ['TELEGRAM_REPLY_MODE', 'Telegram-Antwort: text/voice/both/auto', 'select', ['auto','text','voice','both']],
          ['VECTOR_MEMORY_ENABLED', 'Vector-Memory (Auto-Embed + Recall)', 'bool'],
          ['AGENT_AUTO_ROUTE', 'Cheap-Fallback wenn Cloud nicht erreichbar (30s Cooldown)', 'bool']
        ],
        'Telegram': [
          ['TELEGRAM_ALLOWED_USERS', 'Whitelist (comma-separated IDs)', 'text']
        ],
        'Mail (Kerio IMAP/SMTP)': [
          ['KERIO_HOST', 'IMAP/SMTP Host', 'text'],
          ['KERIO_USER', 'Benutzername', 'text'],
          ['KERIO_PASSWORD', 'Passwort', 'password'],
          ['KERIO_FROM', 'Absender (Name <email>)', 'text'],
          ['MAIL_ALLOWED_DOMAINS', 'Erlaubte Empfänger-Domains (comma)', 'text'],
          ['MAIL_WHITELIST', 'Adress-Whitelist (comma)', 'text'],
          ['EMAIL_MODE', 'Modus', 'select', ['read','write','off']],
          ['EMAIL_MARK_READ', 'Gelesene markieren', 'bool'],
          ['SUPPORT_EMAIL', 'Support-Adresse', 'text']
        ],
        'Kalender (CalDAV)': [
          ['CALDAV_URL', 'CalDAV-URL (z.B. https://wrsk-mail.de — Auto-Discovery)', 'text'],
          ['CALDAV_USER', 'Benutzername', 'text'],
          ['CALDAV_PASS', 'Passwort', 'password'],
          ['CALDAV_MODE', 'Modus', 'select', ['read','write','off']],
          ['CALDAV_CALENDAR', 'Reminder-Kalender (Name oder Substring, leer = erster)', 'text'],
          ['CALDAV_TASKS', 'Tasks-Kalender (Name oder Substring, leer = "Tasks")', 'text'],
          ['CALDAV_NOTES', 'Notizen-Kalender (Substring; leer = Events-Kalender, Kerio-Konvention)', 'text'],
          ['CALDAV_WATCHER_ENABLED', 'CalDAV-Watcher (Cron-Ersatz: Events feuern Reminder/Agent)', 'bool'],
          ['CALDAV_POLL_SECONDS', 'Poll-Intervall (Sekunden)', 'text']
        ]
      };
      let current = {};
      async function load(){
        const s = await (await fetch('/api/settings')).json();
        current = {
          BOT_NAME: s.bot_name || 'JARVIS',
          OWNER_NAME: s.owner_name || '',
          LLM_PROVIDER: s.provider,
          OLLAMA_MODEL: s.models.ollama, OLLAMA_MODEL_CHEAP: s.models.ollama_cheap, OLLAMA_MODEL_EMBED: s.models.ollama_embed, OLLAMA_MODEL_CODE: s.models.ollama_code,
          ANTHROPIC_MODEL: s.models.anthropic,
          WHISPER_MODEL: s.stt.whisper_model, PIPER_VOICE: s.tts.piper_voice,
          TELEGRAM_ENABLED: s.flags.telegram_enabled, SCHEDULER_ENABLED: s.flags.scheduler_enabled,
          MAIL_WATCHER_ENABLED: s.flags.mail_watcher_enabled,
          TELEGRAM_REPLY_MODE: s.telegram_reply_mode || 'auto',
          VECTOR_MEMORY_ENABLED: s.flags.vector_memory_enabled,
          AGENT_AUTO_ROUTE: s.flags.agent_auto_route,
          TELEGRAM_ALLOWED_USERS: s.whitelist.join(','), MAX_TOKENS: s.max_tokens,
          KERIO_HOST: s.mail?.kerio_host, KERIO_USER: s.mail?.kerio_user, KERIO_PASSWORD: s.mail?.kerio_password,
          KERIO_FROM: s.mail?.kerio_from, MAIL_ALLOWED_DOMAINS: s.mail?.mail_allowed_domains,
          MAIL_WHITELIST: s.mail?.mail_whitelist, EMAIL_MODE: s.mail?.email_mode,
          EMAIL_MARK_READ: s.mail?.email_mark_read, SUPPORT_EMAIL: s.mail?.support_email,
          CALDAV_URL: s.calendar?.caldav_url, CALDAV_USER: s.calendar?.caldav_user,
          CALDAV_PASS: s.calendar?.caldav_pass, CALDAV_MODE: s.calendar?.caldav_mode,
          CALDAV_CALENDAR: s.calendar?.caldav_calendar, CALDAV_TASKS: s.calendar?.caldav_tasks,
          CALDAV_NOTES: s.calendar?.caldav_notes,
          CALDAV_WATCHER_ENABLED: s.calendar?.caldav_watcher,
          CALDAV_POLL_SECONDS: String(s.calendar?.caldav_poll_seconds || 300)
        };
        document.getElementById('settings-form').innerHTML = Object.entries(FIELDS).map(([sec, fields]) =>
          \`<div class="sec"><h3>\${sec}</h3>\${fields.map(([k, label, type, opts]) => {
            const v = current[k];
            let input;
            if (type === 'bool') {
              input = \`<div class="v toggle"><input type="checkbox" id="f-\${k}" \${v?'checked':''}><label for="f-\${k}">\${v?'an':'aus'}</label></div>\`;
            } else if (type === 'select') {
              input = \`<div class="v"><select id="f-\${k}">\${(opts||[]).map(o => \`<option \${o===v?'selected':''}>\${o}</option>\`).join('')}</select></div>\`;
            } else if (type === 'password') {
              input = \`<div class="v"><input type="password" id="f-\${k}" value="\${(v??'').toString().replace(/"/g,'&quot;')}" placeholder="(leer lassen = unverändert)"></div>\`;
            } else {
              input = \`<div class="v"><input type="text" id="f-\${k}" value="\${(v??'').toString().replace(/"/g,'&quot;')}"></div>\`;
            }
            return \`<div class="kv"><div class="k">\${label}<br><small style="opacity:0.5">\${k}</small></div>\${input}</div>\`;
          }).join('')}</div>\`
        ).join('');
      }
      async function saveAll(applyAfter){
        const updates = {};
        for (const fields of Object.values(FIELDS)) {
          for (const [k, , type] of fields) {
            const el = document.getElementById('f-' + k);
            if (!el) continue;
            if (type === 'bool') updates[k] = el.checked ? 'true' : 'false';
            else if (type === 'password') {
              // Leeres Feld ODER unverändertes ******** überspringen
              if (el.value === '' || el.value === '********') continue;
              updates[k] = el.value;
            } else updates[k] = el.value;
          }
        }
        const msg = document.getElementById('save-result');
        msg.innerHTML = '<div class="save-msg">⏳ speichere…</div>';
        const r = await fetch('/api/settings', {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({updates})});
        const data = await r.json();
        if (!r.ok) { msg.innerHTML = '<div class="save-msg err">✗ '+(data.error||'Fehler')+'</div>'; return; }
        if (!applyAfter) {
          msg.innerHTML = '<div class="save-msg ok">✓ '+data.saved+' Werte gespeichert. <em>kiasy-core</em> noch nicht recreated — Button rechts klicken oder manuell.</div>';
          return;
        }
        msg.innerHTML = '<div class="save-msg ok">✓ '+data.saved+' gespeichert. ⏳ Recreate-Trigger gesetzt…</div>';
        await fetch('/api/restart', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({service:'kiasy-core'})});
        // Wenn BOT_NAME geändert wurde → auch Monitor neu starten (Layout cached den Namen beim Start)
        if (updates.BOT_NAME && updates.BOT_NAME !== current.BOT_NAME) {
          await fetch('/api/restart', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({service:'kiasy-monitor'})});
        }
        // Jetzt poll /health bis core wieder antwortet (max 30s)
        msg.innerHTML = '<div class="save-msg">⏳ warte auf kiasy-core…</div>';
        const t0 = Date.now();
        while (Date.now() - t0 < 30000) {
          await new Promise(r => setTimeout(r, 1500));
          try {
            const h = await fetch('/api/status', {signal: AbortSignal.timeout(2000)});
            if (h.ok) {
              const took = ((Date.now() - t0) / 1000).toFixed(1);
              msg.innerHTML = '<div class="save-msg ok">✓ Recreated in '+took+'s — Settings sind aktiv.</div>';
              load();
              return;
            }
          } catch {}
        }
        msg.innerHTML = '<div class="save-msg err">⚠ Core kommt nicht hoch — <code>docker compose logs kiasy-core</code> prüfen</div>';
      }
      async function probeCal(){
        const out = document.getElementById('cal-probe');
        out.style.display = 'block';
        out.textContent = '⏳ teste…';
        try {
          const r = await fetch('/api/calendar/probe');
          const d = await r.json();
          out.textContent = JSON.stringify(d, null, 2);
        } catch (e) { out.textContent = 'Fehler: ' + e.message; }
      }
      async function loadSig(){
        try {
          const r = await fetch('/api/mail/signature');
          const d = await r.json();
          document.getElementById('mail-sig').value = d.content || '';
        } catch {}
      }
      async function saveSig(){
        const content = document.getElementById('mail-sig').value;
        const m = document.getElementById('sig-msg');
        m.textContent = 'speichere…';
        try {
          const r = await fetch('/api/mail/signature', {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content})});
          const d = await r.json();
          m.textContent = r.ok ? '✓ gespeichert ('+d.bytes+' Bytes) — sofort aktiv' : '✗ '+(d.error||'Fehler');
        } catch (e) { m.textContent = '✗ '+e.message; }
      }
      async function loadPrompt(){
        try {
          const r = await fetch('/api/system-prompt');
          const d = await r.json();
          document.getElementById('sys-prompt').value = d.content || '';
          document.getElementById('prompt-active').textContent = d.active || '';
        } catch {}
      }
      async function savePrompt(){
        const content = document.getElementById('sys-prompt').value;
        const m = document.getElementById('prompt-msg');
        m.textContent = 'speichere…';
        try {
          const r = await fetch('/api/system-prompt', {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content})});
          const d = await r.json();
          if (r.ok) {
            m.textContent = '✓ gespeichert ('+d.mode+', '+d.bytes+' Bytes) — sofort aktiv beim nächsten Chat';
            loadPrompt();
          } else {
            m.textContent = '✗ '+(d.error||'Fehler');
          }
        } catch (e) { m.textContent = '✗ '+e.message; }
      }
      async function resetPrompt(){
        if (!confirm('Custom-Prompt löschen und auf Default zurücksetzen?')) return;
        document.getElementById('sys-prompt').value = '';
        await savePrompt();
      }
      load();
      loadSig();
      loadPrompt();
    </script>

    <div class="sec" style="margin-top:24px">
      <h3>Ollama Modelle</h3>
      <div id="ollama-model-list" style="margin-bottom:12px;font-size:13px">lade…</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="text" id="pull-model-name" placeholder="z.B. llama3.1:8b oder minimax-m2.7:cloud"
          style="flex:1;min-width:200px;padding:6px 10px;background:var(--bg-elevated);border:1px solid var(--border);color:var(--text);border-radius:4px;font-family:var(--mono);font-size:13px">
        <button class="btn" onclick="pullModel()" style="white-space:nowrap">⬇ Pull</button>
      </div>
      <div id="pull-status" style="font-size:12px;color:var(--text-muted);margin-top:6px"></div>
    </div>

    <script>
      async function loadOllamaModels() {
        const el = document.getElementById('ollama-model-list');
        try {
          const r = await fetch('/api/ollama/models');
          const d = await r.json();
          const models = d.models || [];
          if (!models.length) { el.innerHTML = '<em style="color:var(--text-muted)">Keine Modelle gefunden</em>'; return; }
          el.innerHTML = models.map(m => {
            const gb = m.size ? (m.size / 1e9).toFixed(2) + ' GB' : '?';
            const mod = m.modified_at ? new Date(m.modified_at).toLocaleDateString('de-DE') : '';
            return \`<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
              <span style="flex:1;font-family:var(--mono);font-size:13px">\${m.name}</span>
              <span style="color:var(--text-muted);font-size:12px;white-space:nowrap">\${gb}\${mod?' · '+mod:''}</span>
              <button class="btn" style="padding:3px 10px;font-size:12px" onclick="setKeepalive('\${m.name}')" title="Keepalive setzen">⏱</button>
              <button class="btn" style="padding:3px 10px;font-size:12px;color:var(--err)" onclick="unloadModel('\${m.name}')" title="Aus RAM entladen">⏏</button>
              <button class="btn" style="padding:3px 10px;font-size:12px;color:var(--err)" onclick="deleteModel('\${m.name}')">✕</button>
            </div>\`;
          }).join('');
        } catch (e) { el.innerHTML = '<span style="color:var(--err)">Fehler: ' + e.message + '</span>'; }
      }

      async function pullModel() {
        const name = document.getElementById('pull-model-name').value.trim();
        const st = document.getElementById('pull-status');
        if (!name) { st.textContent = 'Bitte Modellnamen eingeben.'; return; }
        st.textContent = '⏳ Pull läuft… (kann Minuten dauern)';
        try {
          const r = await fetch('/api/ollama/pull', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
          const d = await r.json();
          if (r.ok) { st.textContent = '✓ ' + name + ' geladen.'; loadOllamaModels(); }
          else st.textContent = '✗ ' + (d.error || r.status);
        } catch (e) { st.textContent = '✗ ' + e.message; }
      }

      async function deleteModel(name) {
        if (!confirm('Modell "' + name + '" löschen?')) return;
        const r = await fetch('/api/ollama/delete', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
        if (r.ok) loadOllamaModels();
        else alert('Fehler beim Löschen');
      }

      async function unloadModel(name) {
        const r = await fetch('/api/ollama/keepalive', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name, keep_alive:'0'})});
        document.getElementById('pull-status').textContent = r.ok ? '✓ ' + name + ' aus RAM entladen.' : '✗ Fehler';
      }

      async function setKeepalive(name) {
        const val = prompt('Keepalive für "' + name + '" — 0=entladen, -1=unbegrenzt, z.B. 30m, 2h:', '30m');
        if (val === null) return;
        const r = await fetch('/api/ollama/keepalive', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name, keep_alive: val})});
        document.getElementById('pull-status').textContent = r.ok ? '✓ Keepalive für ' + name + ' gesetzt: ' + val : '✗ Fehler';
      }
      loadOllamaModels();
    </script>`;
}

// ─── Notes Page ───────────────────────────────────────────
function notesBody() {
  return `
    <div class="page-head"><h2>Notes</h2><div><button class="btn" onclick="newNote()">+ neu</button></div></div>
    <div class="notes-layout">
      <div class="notes-list" id="notes-list">lade…</div>
      <div class="notes-editor">
        <input id="note-filename" class="input" placeholder="filename.md" disabled>
        <textarea id="note-content" class="input mono" rows="22" placeholder="(Datei links wählen)"></textarea>
        <div class="note-actions">
          <button class="btn primary" onclick="saveNote()">💾 Speichern</button>
          <button class="btn" onclick="delNote()">✕ Löschen</button>
        </div>
      </div>
    </div>
    <style>
      .notes-layout { display:grid; grid-template-columns:280px 1fr; gap:16px; height:calc(100vh - 220px); }
      .notes-list { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); padding:8px; overflow-y:auto; }
      .notes-list .n { padding:8px 12px; cursor:pointer; border-radius:6px; font-size:13px; }
      .notes-list .n:hover { background:var(--bg-elevated); }
      .notes-list .n.active { background:var(--accent-soft); color:var(--accent); }
      .notes-list .n small { display:block; color:var(--text-dim); font-size:11px; margin-top:2px; }
      .notes-editor { display:flex; flex-direction:column; gap:8px; }
      .notes-editor textarea { flex:1; resize:none; }
      .input { padding:8px 12px; background:var(--bg-card); border:1px solid var(--border); border-radius:6px; color:var(--text); font-family:var(--font); font-size:14px; }
      .input.mono { font-family:var(--mono); font-size:13px; line-height:1.6; }
      .input:disabled { opacity:0.6; }
      .note-actions { display:flex; gap:8px; }
      @media(max-width:700px){.notes-layout{grid-template-columns:1fr;height:auto;}}
    </style>
    <script>
      let activeFile = null;
      async function loadList(){
        const r = await (await fetch('/api/notes')).json();
        document.getElementById('notes-list').innerHTML = r.items.length?r.items.map(n=>\`
          <div class="n \${n.filename===activeFile?'active':''}" onclick="openNote('\${n.filename}')"><strong>\${n.filename}</strong><small>\${n.size}B · \${n.modified.substring(0,10)}</small></div>
        \`).join(''):'<p class="dim" style="padding:12px">keine Notes</p>';
      }
      async function openNote(filename){
        activeFile = filename;
        const r = await (await fetch('/api/notes/' + encodeURIComponent(filename))).json();
        document.getElementById('note-filename').value = filename;
        document.getElementById('note-filename').disabled = true;
        document.getElementById('note-content').value = r.content || '';
        loadList();
      }
      function newNote(){
        activeFile = null;
        document.getElementById('note-filename').value = '';
        document.getElementById('note-filename').disabled = false;
        document.getElementById('note-content').value = '';
        document.getElementById('note-filename').focus();
      }
      async function saveNote(){
        const filename = document.getElementById('note-filename').value.trim();
        if (!filename || !filename.endsWith('.md')) return alert('filename.md erforderlich');
        const content = document.getElementById('note-content').value;
        await fetch('/api/notes/' + encodeURIComponent(filename), {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content})});
        activeFile = filename;
        document.getElementById('note-filename').disabled = true;
        loadList();
      }
      async function delNote(){
        if (!activeFile) return;
        if (!confirm('Datei "'+activeFile+'" löschen?')) return;
        await fetch('/api/notes/' + encodeURIComponent(activeFile), {method:'DELETE'});
        activeFile = null;
        document.getElementById('note-filename').value = '';
        document.getElementById('note-content').value = '';
        loadList();
      }
      loadList();
    </script>`;
}

// ─── Workflows Page ───────────────────────────────────────
function workflowsBody() {
  return `
    <div class="page-head"><h2>Workflows</h2></div>
    <h3>Neuer Workflow</h3>
    <div class="add-form">
      <input id="wf-name" placeholder="Name" class="input">
      <textarea id="wf-steps" placeholder='Steps als JSON-Array, z.B. [{"action":"Hole das Wetter"},{"action":"Schicke per Telegram","delay_minutes":1}]' rows="4" class="input mono"></textarea>
      <button class="btn primary" onclick="addWf()">erstellen</button>
    </div>
    <h3 style="margin-top:24px">Workflows</h3>
    <div id="wf-list" class="list"></div>
    <div id="wf-detail" style="margin-top:24px;"></div>
    <style>
      .add-form { display:flex; flex-direction:column; gap:8px; max-width:700px; }
      .add-form .input { width:100%; }
      .input { padding:8px 12px; background:var(--bg-card); border:1px solid var(--border); border-radius:6px; color:var(--text); font-family:var(--font); font-size:14px; }
      .input.mono { font-family:var(--mono); font-size:13px; }
      .list { display:flex; flex-direction:column; gap:6px; }
      .row { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); padding:12px 16px; display:flex; gap:12px; align-items:center; cursor:pointer; }
      .row:hover { border-color:var(--accent); }
      .row .id { color:var(--text-dim); font-family:var(--mono); flex:0 0 60px; }
      .row .name { flex:1; font-weight:600; }
      .row .badge { padding:2px 8px; border-radius:4px; font-size:11px; background:var(--bg-elevated); color:var(--text-dim); }
      .badge.pending { color:var(--warn); } .badge.running { color:var(--accent); } .badge.done { color:var(--ok); } .badge.cancelled { color:var(--err); }
      .step { background:var(--bg-elevated); padding:8px 12px; border-radius:6px; margin-bottom:4px; font-family:var(--mono); font-size:12px; }
    </style>
    <script>
      async function loadWfs(){
        const r = await (await fetch('/api/workflows')).json();
        document.getElementById('wf-list').innerHTML = r.items.length?r.items.map(w=>\`
          <div class="row" onclick="showDetail(\${w.id})"><div class="id">#\${w.id}</div><div class="name">\${escapeHtml(w.name)}</div>
          <span class="badge \${w.status}">\${w.status}</span><span class="badge">step \${w.current_step}</span></div>
        \`).join(''):'<p class="dim">keine Workflows</p>';
      }
      async function showDetail(id){
        const w = await (await fetch('/api/workflows/' + id)).json();
        document.getElementById('wf-detail').innerHTML = \`
          <h3>#\${w.id} \${escapeHtml(w.name)} <button class="btn" onclick="delWf(\${w.id})">✕ löschen</button></h3>
          \${w.steps.map((s,i)=>\`<div class="step">\${s.step_num}. [\${s.status}] \${escapeHtml(s.action)}\${s.scheduled?' (@'+s.scheduled+')':''}\${s.result?' → '+escapeHtml(s.result.substring(0,80)):''}</div>\`).join('')}\`;
      }
      async function addWf(){
        const name = document.getElementById('wf-name').value.trim();
        let steps;
        try { steps = JSON.parse(document.getElementById('wf-steps').value); }
        catch(e){ return alert('JSON-Fehler: '+e.message); }
        if (!name) return alert('name fehlt');
        await fetch('/api/workflows', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name, steps})});
        document.getElementById('wf-name').value=''; document.getElementById('wf-steps').value=''; loadWfs();
      }
      async function delWf(id){
        if (!confirm('löschen?')) return;
        await fetch('/api/workflows/' + id, {method:'DELETE'});
        document.getElementById('wf-detail').innerHTML='';
        loadWfs();
      }
      function escapeHtml(s){return (s||'').toString().replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
      loadWfs();
    </script>`;
}

// ─── Delegations Page ─────────────────────────────────────
function delegationsBody() {
  return `
    <div class="page-head"><h2>Delegations</h2></div>
    <h3>Neue Delegation</h3>
    <div class="add-form">
      <input id="d-assignee" placeholder="Wer (Name)" class="input">
      <input id="d-email" placeholder="E-Mail (optional)" class="input">
      <input id="d-subject" placeholder="Betreff" class="input">
      <textarea id="d-body" placeholder="Beschreibung" rows="3" class="input"></textarea>
      <input id="d-deadline" type="date" class="input">
      <input id="d-followup" type="number" placeholder="Followup nach Tagen (default 3)" class="input">
      <button class="btn primary" onclick="addDel()">anlegen</button>
    </div>
    <h3 style="margin-top:24px">Liste</h3>
    <div id="d-list" class="list"></div>
    <style>
      .add-form { display:flex; flex-direction:column; gap:8px; max-width:600px; }
      .add-form .input { width:100%; }
      .input { padding:8px 12px; background:var(--bg-card); border:1px solid var(--border); border-radius:6px; color:var(--text); font-family:var(--font); font-size:14px; }
      .list { display:flex; flex-direction:column; gap:6px; }
      .row { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); padding:12px 16px; display:flex; gap:12px; align-items:flex-start; }
      .row.overdue { border-color:var(--warn); }
      .row .meta { flex:0 0 120px; font-family:var(--mono); font-size:11px; color:var(--text-dim); }
      .row .content { flex:1; }
      .row .badge { padding:2px 6px; border-radius:4px; font-size:11px; background:var(--bg-elevated); color:var(--text-dim); margin-right:8px; }
      .badge.open { color:var(--accent); } .badge.done { color:var(--ok); } .badge.overdue { color:var(--warn); } .badge.cancelled { color:var(--err); }
      .row select, .row button { background:var(--bg-elevated); border:1px solid var(--border); color:var(--text); padding:4px 8px; border-radius:4px; font-size:12px; cursor:pointer; }
    </style>
    <script>
      async function loadDel(){
        const r = await (await fetch('/api/delegations')).json();
        const now = new Date();
        document.getElementById('d-list').innerHTML = r.items.length?r.items.map(d=>{
          const ov = d.deadline && new Date(d.deadline)<now && d.status==='open';
          return \`<div class="row \${ov?'overdue':''}">
            <div class="meta">#\${d.id}<br>\${d.deadline||'kein Termin'}</div>
            <div class="content"><span class="badge \${d.status}">\${d.status}</span><strong>\${escapeHtml(d.assignee)}</strong> — \${escapeHtml(d.subject)}\${d.body?'<br><small class="dim">'+escapeHtml(d.body.substring(0,150))+'</small>':''}</div>
            <select onchange="setStatus(\${d.id},this.value)"><option value="open" \${d.status==='open'?'selected':''}>open</option><option value="done" \${d.status==='done'?'selected':''}>done</option><option value="cancelled" \${d.status==='cancelled'?'selected':''}>cancelled</option></select>
            <button onclick="delDel(\${d.id})">✕</button></div>\`;
        }).join(''):'<p class="dim">keine Delegations</p>';
      }
      async function addDel(){
        const body = {
          assignee: document.getElementById('d-assignee').value.trim(),
          assignee_email: document.getElementById('d-email').value.trim() || null,
          subject: document.getElementById('d-subject').value.trim(),
          body: document.getElementById('d-body').value.trim() || null,
          deadline: document.getElementById('d-deadline').value || null,
          followup_days: Number(document.getElementById('d-followup').value) || 3
        };
        if (!body.assignee || !body.subject) return alert('Wer + Betreff nötig');
        await fetch('/api/delegations', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        ['d-assignee','d-email','d-subject','d-body','d-deadline','d-followup'].forEach(i=>document.getElementById(i).value='');
        loadDel();
      }
      async function setStatus(id, status){
        await fetch('/api/delegations/' + id, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});
        loadDel();
      }
      async function delDel(id){
        if (!confirm('löschen?')) return;
        await fetch('/api/delegations/' + id, {method:'DELETE'});
        loadDel();
      }
      function escapeHtml(s){return (s||'').toString().replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
      loadDel();
    </script>`;
}

// ─── HA-Editor Page ───────────────────────────────────────
function haEditorBody() {
  return `
    <div class="page-head"><h2>Home-Assistant Devices</h2><button class="btn" onclick="regen()">↻ aus HA neu generieren</button></div>
    <p class="dim">Markdown-Beschreibung der HA-Geräte. Wird vom Agent in den System-Prompt eingespeist.</p>
    <textarea id="ha-content" class="input mono" rows="28" placeholder="lade…"></textarea>
    <div style="margin-top:12px;"><button class="btn primary" onclick="save()">💾 Speichern</button></div>
    <style>
      .input { padding:12px 16px; background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); color:var(--text); font-family:var(--font); font-size:14px; width:100%; }
      .input.mono { font-family:var(--mono); font-size:13px; line-height:1.6; resize:vertical; }
    </style>
    <script>
      async function load(){
        const r = await (await fetch('/api/ha/devices')).json();
        document.getElementById('ha-content').value = r.content || '';
      }
      async function save(){
        await fetch('/api/ha/devices', {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content: document.getElementById('ha-content').value})});
        alert('gespeichert');
      }
      async function regen(){
        if (!confirm('Aus aktuellen HA-States überschreiben?')) return;
        const r = await fetch('/api/ha/devices/regenerate', {method:'POST'});
        if (r.ok) load();
        else alert('fehlgeschlagen — HOMEASSISTANT_TOKEN gesetzt?');
      }
      load();
    </script>`;
}

// ─── Voice-Test + Sprachtrainer Page ─────────────────────
function voiceBody() {
  return `
    <div class="page-head"><h2>Voice & Sprachtrainer</h2></div>

    <div class="sec">
      <h3>🎙 Sprachtrainer — Deutsch → Zielsprache (gesprochen)</h3>
      <p class="dim">Tipp einen deutschen Satz, wähle Zielsprache + Stimme, hör die Übersetzung. Wiederhol's bis es sitzt.</p>
      <div class="row-controls">
        <select id="tr-lang" class="input" onchange="loadVoices()">
          <option value="en">🇺🇸 Englisch</option>
          <option value="fr">🇫🇷 Französisch</option>
          <option value="es">🇪🇸 Spanisch</option>
          <option value="it">🇮🇹 Italienisch</option>
          <option value="de">🇩🇪 Deutsch (nur TTS)</option>
        </select>
        <select id="tr-voice" class="input"></select>
      </div>
      <textarea id="tr-text" class="input" rows="3" placeholder="Deutscher Satz, z.B. 'Wo ist der Bahnhof?'">Wo finde ich hier den nächsten Supermarkt?</textarea>
      <button class="btn primary" onclick="trainerGo()">🔊 Übersetzen + Sprechen</button>
      <div id="tr-result" style="margin-top:12px;"></div>
      <audio id="tr-audio" controls style="display:block;margin-top:8px;width:100%;"></audio>
    </div>

    <div class="sec">
      <h3>🔊 TTS direkt (kein Translate)</h3>
      <textarea id="tts-text" class="input" rows="2" placeholder="Text in beliebiger Sprache…">Hello, how are you today?</textarea>
      <select id="tts-voice" class="input"></select>
      <button class="btn primary" onclick="synth()">▶ Synthesize</button>
      <audio id="tts-audio" controls style="display:block;margin-top:8px;width:100%;"></audio>
    </div>

    <div class="sec">
      <h3>📝 STT — Audio → Text (Whisper)</h3>
      <input type="file" id="stt-file" accept="audio/*" class="input">
      <select id="stt-lang" class="input">
        <option value="de">🇩🇪 Deutsch</option>
        <option value="en">🇺🇸 Englisch</option>
        <option value="fr">🇫🇷 Französisch</option>
        <option value="es">🇪🇸 Spanisch</option>
        <option value="it">🇮🇹 Italienisch</option>
      </select>
      <button class="btn primary" onclick="transcribe()">📝 Transkribieren</button>
      <pre id="stt-result" class="result"></pre>
    </div>

    <style>
      .sec { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); padding:18px; margin-bottom:16px; }
      .sec h3 { margin-bottom:8px; }
      .sec p { margin-bottom:12px; }
      .sec .input, .sec textarea, .sec select { width:100%; margin-bottom:8px; padding:8px 12px; background:var(--bg-elevated); border:1px solid var(--border); border-radius:6px; color:var(--text); font-family:var(--font); font-size:14px; }
      .row-controls { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:8px; }
      .row-controls .input { margin-bottom:0; }
      .result { background:var(--bg-elevated); padding:12px 16px; border-radius:6px; font-family:var(--mono); font-size:13px; min-height:40px; margin-top:8px; }
      .tr-orig { color:var(--text-dim); font-size:13px; }
      .tr-trans { color:var(--accent); font-size:18px; font-weight:600; padding:8px 12px; background:var(--accent-soft); border-radius:6px; margin-top:6px; }
    </style>

    <script>
      let allVoices = [];
      async function loadVoices(){
        if (!allVoices.length) {
          const r = await (await fetch('/api/voice/voices')).json();
          allVoices = r.voices;
        }
        // Sprachtrainer: nur ausgewählte Sprache
        const lang = document.getElementById('tr-lang').value;
        const filtered = allVoices.filter(v => v.lang === lang);
        document.getElementById('tr-voice').innerHTML = filtered.map(v =>
          \`<option value="\${v.voice}">\${v.flag} \${v.name} (\${v.gender}, \${v.quality})</option>\`).join('');
        // Direkt-TTS: alle Stimmen alphabetisch
        document.getElementById('tts-voice').innerHTML = allVoices.map(v =>
          \`<option value="\${v.voice}">\${v.flag} \${v.name} — \${v.voice}</option>\`).join('');
      }

      async function trainerGo(){
        const text = document.getElementById('tr-text').value.trim();
        const targetLang = document.getElementById('tr-lang').value;
        const voice = document.getElementById('tr-voice').value;
        if (!text) return;
        document.getElementById('tr-result').innerHTML = '⏳ übersetze + synthesize…';
        const r = await fetch('/api/voice/translate-synth', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text, targetLang, voice})});
        if (!r.ok) { document.getElementById('tr-result').innerHTML = '<div class="tr-orig" style="color:var(--err)">Fehler: '+r.status+'</div>'; return; }
        const original = decodeURIComponent(r.headers.get('X-Original')||'');
        const translated = decodeURIComponent(r.headers.get('X-Translated')||'');
        document.getElementById('tr-result').innerHTML = \`
          <div class="tr-orig">DE: \${original}</div>
          <div class="tr-trans">\${translated}</div>\`;
        const blob = await r.blob();
        const audio = document.getElementById('tr-audio');
        audio.src = URL.createObjectURL(blob);
        audio.play();
      }

      async function synth(){
        const text = document.getElementById('tts-text').value.trim();
        const voice = document.getElementById('tts-voice').value;
        if (!text) return;
        const r = await fetch('/api/voice/synth', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text, voice})});
        if (!r.ok) return alert('Synth fehlgeschlagen');
        const blob = await r.blob();
        document.getElementById('tts-audio').src = URL.createObjectURL(blob);
        document.getElementById('tts-audio').play();
      }

      async function transcribe(){
        const f = document.getElementById('stt-file').files[0];
        if (!f) return;
        const ext = (f.name.split('.').pop() || 'm4a').toLowerCase();
        const lang = document.getElementById('stt-lang').value;
        document.getElementById('stt-result').textContent = '⏳ transkribiere…';
        const r = await fetch('/api/voice/transcribe?lang='+lang+'&ext='+ext, {method:'POST',headers:{'Content-Type':'application/octet-stream'},body:f});
        const data = await r.json();
        document.getElementById('stt-result').textContent = JSON.stringify(data, null, 2);
      }

      loadVoices();
    </script>`;
}

// ─── Backup Page ──────────────────────────────────────────
function backupBody() {
  return `
    <div class="page-head"><h2>Backups</h2></div>
    <p class="dim">Liste aller Backup-Tarballs in <code>/home/mcde/kiasy/backups/</code>. Erstellen via Host:</p>
    <pre class="result">bash /home/mcde/kiasy/scripts/backup.sh</pre>
    <h3 style="margin-top:24px">Vorhandene Backups</h3>
    <div id="bk-list" class="list"></div>
    <style>
      .result { background:var(--bg-card); border:1px solid var(--border); padding:12px 16px; border-radius:6px; font-family:var(--mono); font-size:13px; user-select:all; }
      .list { display:flex; flex-direction:column; gap:6px; }
      .row { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); padding:12px 16px; display:flex; gap:12px; align-items:center; }
      .row .name { flex:1; font-family:var(--mono); font-size:13px; }
      .row .size { color:var(--text-dim); font-family:var(--mono); font-size:12px; }
      .row .date { color:var(--text-dim); font-size:12px; }
    </style>
    <script>
      async function load(){
        const r = await (await fetch('/api/backup/list')).json();
        document.getElementById('bk-list').innerHTML = r.items.length?r.items.map(b=>\`
          <div class="row"><div class="name">\${b.filename}</div><div class="size">\${b.size_human}</div><div class="date">\${b.created.substring(0,19).replace('T',' ')}</div></div>
        \`).join(''):'<p class="dim">noch keine Backups in '+r.dir+'. '+(r.note||'')+'</p>';
      }
      load();
    </script>`;
}

// ─── Labs Page ────────────────────────────────────────────
function labsBody() {
  return `
    <div class="page-head"><h2>Labs <small style="color:var(--text-dim);font-size:13px;">— Ideen, Drafts, Experimente</small></h2></div>
    <h3>Neue Idee</h3>
    <div class="add-form">
      <input id="l-title" placeholder="Titel" class="input">
      <select id="l-type" class="input"><option value="idea">Idee</option><option value="draft">Tool-Draft</option><option value="experiment">Experiment</option><option value="tool">Tool</option></select>
      <textarea id="l-desc" placeholder="Beschreibung" rows="3" class="input"></textarea>
      <button class="btn primary" onclick="addLab()">anlegen</button>
    </div>
    <div class="kanban" id="kanban"></div>
    <style>
      .add-form { display:flex; flex-direction:column; gap:8px; max-width:600px; margin-bottom:24px; }
      .add-form .input { width:100%; }
      .input { padding:8px 12px; background:var(--bg-card); border:1px solid var(--border); border-radius:6px; color:var(--text); font-family:var(--font); font-size:14px; }
      .kanban { display:grid; grid-template-columns:repeat(5,1fr); gap:12px; }
      .col { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); padding:12px; min-height:100px; }
      .col h4 { font-size:12px; color:var(--text-dim); text-transform:uppercase; margin-bottom:10px; padding-bottom:8px; border-bottom:1px solid var(--border); }
      .item { background:var(--bg-elevated); border:1px solid var(--border); border-radius:6px; padding:8px 10px; margin-bottom:6px; font-size:12px; }
      .item .title { font-weight:600; margin-bottom:4px; }
      .item .desc { color:var(--text-dim); }
      .item .actions { display:flex; gap:4px; margin-top:6px; }
      .item select, .item button { background:var(--bg-card); border:1px solid var(--border); color:var(--text-dim); padding:2px 6px; border-radius:3px; font-size:11px; cursor:pointer; }
      .item .badge { display:inline-block; padding:1px 5px; border-radius:3px; font-size:10px; background:var(--bg-card); color:var(--text-dim); margin-bottom:4px; }
      @media(max-width:1000px){.kanban{grid-template-columns:repeat(2,1fr);}}
    </style>
    <script>
      const STATUSES = ['idee','konzept','bauen','live','verworfen'];
      async function loadLabs(){
        const r = await (await fetch('/api/labs')).json();
        const byStatus = Object.fromEntries(STATUSES.map(s => [s, []]));
        for (const it of r.items) (byStatus[it.status] || (byStatus[it.status]=[])).push(it);
        document.getElementById('kanban').innerHTML = STATUSES.map(s => \`
          <div class="col"><h4>\${s} (\${byStatus[s].length})</h4>
            \${byStatus[s].map(it => \`
              <div class="item">
                <span class="badge">\${it.type}</span>
                <div class="title">\${escapeHtml(it.title)}</div>
                \${it.description?'<div class="desc">'+escapeHtml(it.description.substring(0,100))+'</div>':''}
                <div class="actions">
                  <select onchange="setStatus(\${it.id},this.value)">\${STATUSES.map(st => \`<option \${st===it.status?'selected':''}>\${st}</option>\`).join('')}</select>
                  <button onclick="delLab(\${it.id})">✕</button>
                </div>
              </div>\`).join('')}</div>\`).join('');
      }
      async function addLab(){
        const body = {
          title: document.getElementById('l-title').value.trim(),
          type: document.getElementById('l-type').value,
          description: document.getElementById('l-desc').value.trim() || null
        };
        if (!body.title) return alert('Titel fehlt');
        await fetch('/api/labs', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        document.getElementById('l-title').value=''; document.getElementById('l-desc').value=''; loadLabs();
      }
      async function setStatus(id, status){
        await fetch('/api/labs/' + id, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});
        loadLabs();
      }
      async function delLab(id){
        if (!confirm('löschen?')) return;
        await fetch('/api/labs/' + id, {method:'DELETE'});
        loadLabs();
      }
      function escapeHtml(s){return (s||'').toString().replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
      loadLabs();
    </script>`;
}

// ─── Logs Page ───────────────────────────────────────────
function logsBody() {
  return `
    <div class="page-head"><h2>Logs (kiasy-core, live)</h2>
      <div style="display:flex;gap:8px;align-items:center;">
        <input id="lf" class="input" placeholder="Filter (substring)" style="width:240px;">
        <select id="ll" class="input" style="width:130px;">
          <option value="">Alle Levels</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <button class="btn" id="bp">⏸ Pause</button>
        <button class="btn" id="bc">🗑 Clear</button>
        <span id="bs" class="dim" style="font-size:12px;">connecting…</span>
      </div>
    </div>
    <p class="dim">Ring-Buffer (max 1000 Zeilen). Stream wird automatisch reconnected. <b>Tipp:</b> für vollständige Logs (incl. anderer Container) <code>sudo docker logs kiasy-core -f</code> auf dem Host.</p>
    <div id="lv" class="logs"></div>
    <style>
      .logs { background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--radius); padding:8px 12px; height:calc(100vh - 280px); overflow-y:auto; font-family:var(--mono); font-size:12px; line-height:1.5; }
      .logs .ln { white-space:pre-wrap; word-break:break-word; padding:2px 0; border-bottom:1px solid rgba(255,255,255,0.04); }
      .logs .ln .t { color:var(--text-dim); margin-right:8px; }
      .logs .ln .l { display:inline-block; width:48px; text-transform:uppercase; font-weight:600; margin-right:8px; }
      .logs .ln .l.info  { color:var(--accent); }
      .logs .ln .l.warn  { color:#e5b34a; }
      .logs .ln .l.error { color:var(--err); }
      .logs .ln.hi { background:rgba(255,255,255,0.05); }
      .input { padding:6px 10px; background:var(--bg-elevated); border:1px solid var(--border); color:var(--text); border-radius:4px; font-size:13px; }
    </style>
    <script>
      const lv = document.getElementById('lv');
      const lf = document.getElementById('lf');
      const ll = document.getElementById('ll');
      const bp = document.getElementById('bp');
      const bc = document.getElementById('bc');
      const bs = document.getElementById('bs');
      let paused = false;
      let buffer = [];
      const MAX_RENDER = 1000;
      function fmt(line) {
        const d = new Date(line.ts);
        const t = d.toLocaleTimeString('de-DE', { hour12:false }) + '.' + String(d.getMilliseconds()).padStart(3,'0');
        const esc = s => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
        return \`<div class="ln" data-l="\${line.level}"><span class="t">\${t}</span><span class="l \${line.level}">\${line.level}</span>\${esc(line.msg)}</div>\`;
      }
      function applyFilter() {
        const fq = lf.value.toLowerCase();
        const fl = ll.value;
        let html = '';
        let count = 0;
        for (let i = buffer.length - 1; i >= 0 && count < MAX_RENDER; i--) {
          const b = buffer[i];
          if (fl && b.level !== fl) continue;
          if (fq && !b.msg.toLowerCase().includes(fq)) continue;
          html = fmt(b) + html;
          count++;
        }
        lv.innerHTML = html;
        const atBottom = lv.scrollTop + lv.clientHeight >= lv.scrollHeight - 50;
        if (atBottom) lv.scrollTop = lv.scrollHeight;
      }
      function append(line) {
        buffer.push(line);
        if (buffer.length > 2000) buffer.splice(0, buffer.length - 2000);
        if (paused) return;
        const fq = lf.value.toLowerCase();
        const fl = ll.value;
        if (fl && line.level !== fl) return;
        if (fq && !line.msg.toLowerCase().includes(fq)) return;
        const wasAtBottom = lv.scrollTop + lv.clientHeight >= lv.scrollHeight - 50;
        lv.insertAdjacentHTML('beforeend', fmt(line));
        while (lv.children.length > MAX_RENDER) lv.removeChild(lv.firstChild);
        if (wasAtBottom) lv.scrollTop = lv.scrollHeight;
      }
      lf.addEventListener('input', applyFilter);
      ll.addEventListener('change', applyFilter);
      bp.addEventListener('click', () => { paused = !paused; bp.textContent = paused ? '▶ Resume' : '⏸ Pause'; if (!paused) applyFilter(); });
      bc.addEventListener('click', () => { buffer = []; lv.innerHTML = ''; });
      let es;
      function connect() {
        bs.textContent = 'connecting…';
        es = new EventSource('/api/logs/stream');
        es.addEventListener('snapshot', e => {
          const d = JSON.parse(e.data);
          buffer = d.items || [];
          applyFilter();
          bs.textContent = 'live';
        });
        es.addEventListener('log', e => {
          append(JSON.parse(e.data));
        });
        es.onerror = () => {
          bs.textContent = 'reconnecting…';
          es.close();
          setTimeout(connect, 3000);
        };
      }
      connect();
    </script>`;
}

// ═════════════════════════════════════════════════════════════
// Layout (mit Top-Nav)
// ═════════════════════════════════════════════════════════════
function layout(active, title, body) {
  const navItems = [
    ["dashboard","/","Dashboard"],
    // ["chat","/chat","Chat"],  // DEPRECATED: Web-Chat ungenutzt
    // ["notes","/notes","Notes"],  // DEPRECATED: nach Kerio migriert
    ["memory","/memory","Memory"],
    ["reminders","/reminders","Reminders"],
    ["workflows","/workflows","Workflows"],
    ["delegations","/delegations","Delegations"],
    ["labs","/labs","Labs"],
    ["news","/news","News"],
    ["contacts","/contacts","Kontakte"],
    ["tools","/tools","Tools"],
    ["voice","/voice","Voice"],
    ["ha-editor","/ha-editor","HA"],
    ["health","/health","Health"],
    ["logs","/logs","Logs"],
    ["backup","/backup","Backup"],
    ["settings","/settings","Settings"]
  ];
  return `<!doctype html>
<html lang="de" data-theme="dark"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — ${BOT_NAME}</title>
  <style>
    :root {
      --bg:#0b0d12; --bg-card:#131722; --bg-elevated:#1a1f2e; --border:#232938;
      --text:#e6e9f0; --text-dim:#8b94a8;
      --accent:#4ec9ff; --accent-soft:rgba(78,201,255,0.12);
      --ok:#6fe5a4; --err:#ff6b7a; --warn:#ffb86b;
      --radius:8px;
      --font:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",system-ui,sans-serif;
      --mono:"SF Mono",Menlo,Consolas,monospace;
    }
    *{box-sizing:border-box;margin:0;padding:0;}
    html,body{background:var(--bg);color:var(--text);font-family:var(--font);-webkit-font-smoothing:antialiased;}
    body{min-height:100vh;}
    .topnav{background:var(--bg-card);border-bottom:1px solid var(--border);padding:12px 24px;display:flex;align-items:center;gap:8px;overflow-x:auto;}
    .topnav .brand{font-weight:700;color:var(--accent);margin-right:24px;font-size:18px;}
    .topnav a{color:var(--text-dim);text-decoration:none;padding:6px 12px;border-radius:6px;font-size:13px;white-space:nowrap;}
    .topnav a:hover{background:var(--bg-elevated);color:var(--text);}
    .topnav a.active{background:var(--accent-soft);color:var(--accent);}
    .container{max-width:1100px;margin:0 auto;padding:24px;}
    .hero{text-align:center;padding:24px 0;}
    .hero h1{font-size:48px;letter-spacing:-2px;background:linear-gradient(135deg,var(--accent),#a872ff);-webkit-background-clip:text;background-clip:text;color:transparent;}
    .tag{color:var(--text-dim);font-family:var(--mono);font-size:13px;margin-top:8px;}
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:24px;}
    .card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:18px;transition:border-color .15s;}
    .card:hover{border-color:var(--accent);}
    .card h3{font-size:16px;margin-bottom:8px;}
    .card-link{text-decoration:none;color:inherit;}
    .lead{color:var(--text-dim);font-size:13px;}
    .page-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;padding-bottom:12px;border-bottom:1px solid var(--border);}
    .page-head h2{font-size:24px;}
    .btn{background:var(--bg-elevated);border:1px solid var(--border);color:var(--text);padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px;}
    .btn:hover{border-color:var(--accent);}
    .btn.primary{background:var(--accent);color:var(--bg);font-weight:600;border-color:var(--accent);}
    .dim{color:var(--text-dim);}
    h3{font-size:14px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;}
    @media(max-width:600px){.hero h1{font-size:32px;}.container{padding:16px;}}
  </style>
</head><body>
  <nav class="topnav">
    <span class="brand">${BOT_NAME}</span>
    ${navItems.map(([id, href, label]) => `<a href="${href}" class="${id===active?'active':''}">${label}</a>`).join("")}
  </nav>
  <div class="container">${body}</div>
</body></html>`;
}
