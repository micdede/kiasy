// kiasy-monitor — Web-UI mit Pages für tools/memory/reminders/news/health/settings/chat

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
  res.send(layout("dashboard", "kiasy", `
    <section class="hero">
      <h1>kiasy</h1>
      <p class="tag">v${pkg.version} · Phase 3 · core ${coreStatus}</p>
    </section>
    <section class="cards">
      ${[
        ["chat","Chat","💬","Web-Chat mit dem Agent"],
        ["tools","Tools","🔧","Tools aktivieren / testen"],
        ["memory","Memory","🧠","Facts / Todos / Notes"],
        ["reminders","Reminders","⏰","Erinnerungen"],
        ["news","News","📰","Quellen verwalten"],
        ["health","Health","🩺","Container-Status"],
        ["settings","Settings","⚙️","Konfiguration"]
      ].map(([p, t, e, d]) => `<a class="card-link" href="/${p}"><div class="card"><h3>${e} ${t}</h3><p class="lead">${d}</p></div></a>`).join("")}
    </section>
  `));
});

app.get("/chat", (req, res) => res.send(layout("chat", "Chat", chatBody())));
app.get("/tools", (req, res) => res.send(layout("tools", "Tools", toolsBody())));
app.get("/memory", (req, res) => res.send(layout("memory", "Memory", memoryBody())));
app.get("/reminders", (req, res) => res.send(layout("reminders", "Reminders", remindersBody())));
app.get("/news", (req, res) => res.send(layout("news", "News-Quellen", newsBody())));
app.get("/health", (req, res) => res.send(layout("health", "Health", healthBody())));
app.get("/settings", (req, res) => res.send(layout("settings", "Settings", settingsBody())));

app.listen(PORT, "0.0.0.0", () => console.log(`[kiasy-monitor] v${pkg.version} listening on :${PORT}`));

// ═════════════════════════════════════════════════════════════
// Page Bodies
// ═════════════════════════════════════════════════════════════

function chatBody() {
  return `
    <div class="page-head"><h2>Chat</h2><button class="btn" onclick="if(confirm('Verlauf leeren?')){location.reload()}">leeren</button></div>
    <div class="chat-wrap">
      <div id="messages" class="messages"></div>
      <form id="form" class="input-form">
        <textarea id="input" placeholder="Nachricht…" rows="2" autofocus></textarea>
        <button type="submit" id="send" class="btn primary">Send</button>
      </form>
    </div>
    <style>
      .chat-wrap { display:flex; flex-direction:column; height: calc(100vh - 200px); }
      .messages { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:10px; padding:8px 0; }
      .msg { padding: 10px 14px; border-radius: 10px; max-width: 85%; line-height:1.5; word-wrap:break-word; white-space:pre-wrap; }
      .msg.user { background: var(--accent-soft); border:1px solid rgba(78,201,255,0.3); align-self:flex-end; }
      .msg.assistant { background: var(--bg-card); border:1px solid var(--border); align-self:flex-start; }
      .msg.tool { background: var(--bg-elevated); border:1px solid var(--border); align-self:flex-start; font-family: var(--mono); font-size:12px; color: var(--text-dim); max-width: 95%; }
      .msg.error { background: rgba(255,107,122,0.15); border:1px solid var(--err); align-self:flex-start; color: var(--err); }
      .msg .role { font-size:10px; color: var(--text-dim); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px; }
      .input-form { display:flex; gap:8px; padding-top:12px; border-top:1px solid var(--border); }
      .input-form textarea { flex:1; padding:10px 14px; background: var(--bg-card); border:1px solid var(--border); border-radius: var(--radius); color: var(--text); font-family: var(--font); font-size:14px; resize:none; }
    </style>
    <script>
      const messages=document.getElementById('messages'),form=document.getElementById('form'),input=document.getElementById('input'),send=document.getElementById('send');
      const CHAT_ID='web-chat';
      function addMsg(r,t){const d=document.createElement('div');d.className='msg '+r;d.innerHTML='<div class="role">'+r+'</div><div class="text"></div>';d.querySelector('.text').textContent=t;messages.appendChild(d);messages.scrollTop=messages.scrollHeight;return d.querySelector('.text');}
      fetch('/api/chat/history?chatId='+CHAT_ID+'&limit=30').then(r=>r.json()).then(d=>{(d.messages||[]).forEach(m=>m.role!=='system'&&addMsg(m.role,m.content))});
      form.addEventListener('submit',async e=>{e.preventDefault();const t=input.value.trim();if(!t)return;input.value='';send.disabled=true;addMsg('user',t);const tgt=addMsg('assistant','');
        try{const res=await fetch('/api/chat/send/stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chatId:CHAT_ID,message:t})});
          const reader=res.body.getReader();const dec=new TextDecoder();let buf='',acc='';
          while(true){const{value,done}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});const evs=buf.split('\\n\\n');buf=evs.pop();
            for(const ev of evs){const ls=ev.split('\\n');const ty=ls.find(l=>l.startsWith('event: '))?.slice(7);const dl=ls.find(l=>l.startsWith('data: '))?.slice(6);if(!dl)continue;const d=JSON.parse(dl);
              if(ty==='delta'){acc+=d.text;tgt.textContent=acc;messages.scrollTop=messages.scrollHeight;}
              else if(ty==='tool_use')addMsg('tool','🔧 '+d.name+'('+JSON.stringify(d.input).slice(0,200)+')');
              else if(ty==='tool_result')addMsg('tool','↳ '+JSON.stringify(d.result).slice(0,300));
              else if(ty==='error')addMsg('error',d.error);}}}
        catch(err){addMsg('error',err.message);}finally{send.disabled=false;input.focus();}});
    </script>`;
}

function toolsBody() {
  return `
    <div class="page-head"><h2>Tools</h2><button class="btn" onclick="reloadTools()">⟳ reload</button></div>
    <div id="tools-list" class="list">lade…</div>
    <h3 style="margin-top:32px">Tool direkt ausführen</h3>
    <div class="exec-box">
      <input id="exec-name" placeholder="Tool-Name (z.B. current_time)" class="input">
      <textarea id="exec-input" placeholder='{"format":"both"}' rows="3" class="input mono"></textarea>
      <button class="btn primary" onclick="execTool()">execute</button>
    </div>
    <pre id="exec-result" class="result"></pre>
    <style>
      .list { display:flex; flex-direction:column; gap:8px; }
      .row { display:flex; align-items:center; gap:12px; padding:12px 16px; background: var(--bg-card); border:1px solid var(--border); border-radius: var(--radius); }
      .row .name { font-family:var(--mono); font-weight:600; flex:0 0 200px; }
      .row .desc { color: var(--text-dim); font-size:13px; flex:1; }
      .row .toggle { padding:4px 10px; border-radius:6px; cursor:pointer; font-size:12px; border:1px solid var(--border); background:var(--bg-elevated); }
      .row .toggle.on { color: var(--ok); border-color: var(--ok); }
      .row .toggle.off { color: var(--err); border-color: var(--err); }
      .exec-box { display:flex; flex-direction:column; gap:8px; max-width:600px; }
      .input { padding:10px 14px; background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); color:var(--text); font-family:var(--font); }
      .input.mono { font-family:var(--mono); font-size:13px; }
      .result { background:var(--bg-card); border:1px solid var(--border); padding:16px; border-radius:var(--radius); white-space:pre-wrap; word-wrap:break-word; max-height:400px; overflow:auto; font-size:12px; margin-top:12px; }
    </style>
    <script>
      async function loadTools(){
        const [defs, settings] = await Promise.all([
          fetch('/api/tools').then(r=>r.json()),
          fetch('/api/tools/settings').then(r=>r.json())
        ]);
        const sMap = new Map(settings.settings.map(s => [s.filename, s]));
        document.getElementById('tools-list').innerHTML = defs.tools.map(t => {
          // Tool-File ableiten ist nicht trivial — wir nehmen eine Heuristik (settings haben filename)
          // Hier nur Darstellung mit Toggle erst wenn setting vorhanden ist
          const setting = [...sMap.values()].find(s => s.filename.includes(t.name.split('_')[0]));
          const enabled = setting ? setting.enabled : 1;
          const fn = setting ? setting.filename : t.name + '.js';
          return \`<div class="row">
            <span class="name">\${t.name}</span>
            <span class="desc">\${t.description.substring(0,150)}\${t.description.length>150?'…':''}</span>
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
      loadTools();
    </script>`;
}

function memoryBody() {
  return `
    <div class="page-head"><h2>Memory</h2></div>
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
    <style>
      .filter-bar, .add-form { display:flex; gap:8px; align-items:flex-start; flex-wrap:wrap; }
      .add-form { flex-direction:column; max-width:600px; }
      .add-form .input { width:100%; }
      .input { padding:8px 12px; background:var(--bg-card); border:1px solid var(--border); border-radius:6px; color:var(--text); font-family:var(--font); font-size:14px; }
      .list { display:flex; flex-direction:column; gap:8px; margin-top:12px; }
      .row { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); padding:12px 16px; display:flex; gap:12px; align-items:flex-start; }
      .row .meta { flex:0 0 100px; color:var(--text-dim); font-size:12px; font-family:var(--mono); }
      .row .content { flex:1; word-wrap:break-word; }
      .row .delete { background:none; border:none; color:var(--err); cursor:pointer; opacity:0.5; }
      .row:hover .delete { opacity:1; }
      .badge { display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; background:var(--accent-soft); color:var(--accent); margin-right:6px; }
    </style>
    <script>
      async function loadMem(){
        const cat=document.getElementById('cat').value, q=document.getElementById('q').value.trim();
        const params=new URLSearchParams(); if(cat)params.set('category',cat); if(q)params.set('q',q);
        const r=await fetch('/api/memory?'+params).then(r=>r.json());
        document.getElementById('mem-list').innerHTML = r.items.length?r.items.map(m=>\`
          <div class="row"><div class="meta">#\${m.id}<br>\${m.added}</div>
          <div class="content"><span class="badge">\${m.category}</span>\${m.key?'<strong>'+m.key+':</strong> ':''}\${escapeHtml(m.value)}</div>
          <button class="delete" onclick="delMem(\${m.id})">✕</button></div>
        \`).join(''):'<p class="dim">keine Einträge</p>';
      }
      async function addMem(){
        const body={category:document.getElementById('new-cat').value,key:document.getElementById('new-key').value.trim()||null,value:document.getElementById('new-val').value.trim()};
        if(!body.value)return alert('Wert leer');
        await fetch('/api/memory',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        document.getElementById('new-val').value=''; document.getElementById('new-key').value=''; loadMem();
      }
      async function delMem(id){if(!confirm('löschen?'))return; await fetch('/api/memory/'+id,{method:'DELETE'}); loadMem();}
      function escapeHtml(s){return s.replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
      loadMem();
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
    <div class="page-head"><h2>Health</h2><button class="btn" onclick="check()">↻ check</button></div>
    <div id="health-grid" class="cards"></div>
    <h3 style="margin-top:24px">Status-Snapshot</h3>
    <pre id="status-json" class="result"></pre>
    <style>
      .cards { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px; }
      .health-card { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); padding:18px; }
      .health-card h4 { font-size:13px; color:var(--text-dim); text-transform:uppercase; margin-bottom:8px; }
      .health-card .status { font-size:22px; font-weight:600; }
      .health-card .status.ok { color:var(--ok); }
      .health-card .status.err { color:var(--err); }
      .health-card small { color:var(--text-dim); font-family:var(--mono); font-size:11px; }
      .result { background:var(--bg-card); border:1px solid var(--border); padding:16px; border-radius:var(--radius); white-space:pre-wrap; max-height:400px; overflow:auto; font-size:12px; }
    </style>
    <script>
      async function check(){
        document.getElementById('health-grid').innerHTML = 'lade…';
        const [h, s] = await Promise.all([fetch('/api/health/check').then(r=>r.json()), fetch('/api/status').then(r=>r.json())]);
        document.getElementById('health-grid').innerHTML = h.checks.map(c=>\`
          <div class="health-card"><h4>\${c.name}</h4><div class="status \${c.ok?'ok':'err'}">\${c.ok?'online':'offline'}</div>
          <small>\${c.latency_ms}ms\${c.error?' · '+c.error:''}</small></div>
        \`).join('');
        document.getElementById('status-json').textContent = JSON.stringify(s, null, 2);
      }
      check();
    </script>`;
}

function settingsBody() {
  return `
    <div class="page-head"><h2>Settings</h2></div>
    <p class="dim">Read-only. Änderungen aktuell nur via <code>.env</code> + <code>docker compose up -d kiasy-core</code> (recreate für ENV-Reload).</p>
    <div id="settings-content"></div>
    <style>
      .sec { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); padding:18px; margin-bottom:12px; }
      .sec h3 { font-size:14px; color:var(--text-dim); text-transform:uppercase; margin-bottom:12px; }
      .kv { display:flex; padding:6px 0; border-bottom:1px solid var(--border); font-family:var(--mono); font-size:13px; }
      .kv:last-child { border-bottom:none; }
      .kv .k { flex:0 0 200px; color:var(--text-dim); }
      .kv .v { color:var(--text); word-break:break-all; }
      .kv .v.on { color:var(--ok); }
      .kv .v.off { color:var(--err); }
      code { background:var(--bg-elevated); padding:2px 6px; border-radius:3px; font-family:var(--mono); font-size:12px; }
    </style>
    <script>
      fetch('/api/settings').then(r=>r.json()).then(s=>{
        const sec = (title, items) => \`<div class="sec"><h3>\${title}</h3>\${items.map(([k,v,cls=''])=>\`<div class="kv"><div class="k">\${k}</div><div class="v \${cls}">\${v}</div></div>\`).join('')}</div>\`;
        document.getElementById('settings-content').innerHTML =
          sec('LLM', [['Provider', s.provider], ['Ollama Model', s.models.ollama], ['Anthropic Model', s.models.anthropic||'(nicht aktiv)']]) +
          sec('Voice', [['STT (Whisper)', s.stt.whisper_model], ['TTS (Piper)', s.tts.piper_voice]]) +
          sec('Subsysteme (ENABLED-Flags)', Object.entries(s.flags).map(([k,v])=>[k, v?'an':'aus', v?'on':'off'])) +
          sec('Telegram-Whitelist', [['IDs', s.whitelist.join(', ') || '(leer = alle abgelehnt)']]);
      });
    </script>`;
}

// ═════════════════════════════════════════════════════════════
// Layout (mit Top-Nav)
// ═════════════════════════════════════════════════════════════
function layout(active, title, body) {
  const navItems = [
    ["dashboard","/","Dashboard"],
    ["chat","/chat","Chat"],
    ["tools","/tools","Tools"],
    ["memory","/memory","Memory"],
    ["reminders","/reminders","Reminders"],
    ["news","/news","News"],
    ["health","/health","Health"],
    ["settings","/settings","Settings"]
  ];
  return `<!doctype html>
<html lang="de" data-theme="dark"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — kiasy</title>
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
    <span class="brand">kiasy</span>
    ${navItems.map(([id, href, label]) => `<a href="${href}" class="${id===active?'active':''}">${label}</a>`).join("")}
  </nav>
  <div class="container">${body}</div>
</body></html>`;
}
