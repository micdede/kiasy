// Kerio Connect JSON-RPC API Client
// Für Notizen und Aufgaben (nicht via CalDAV/CardDAV verfügbar)
const { getKerioConfig } = require("./kerio-config");

async function withSession(fn) {
  const cfg = getKerioConfig();
  const baseUrl = `https://${cfg.host}/webmail/api/jsonrpc`;
  let token = null;
  let cookies = null;

  async function rpc(method, params = {}) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers["X-Token"] = token;
    if (cookies) headers["Cookie"] = cookies;

    const res = await fetch(baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });

    if (!cookies) {
      const sc = res.headers.getSetCookie?.() || [];
      cookies = sc.map((c) => c.split(";")[0]).join("; ");
    }

    const data = await res.json();
    if (data.error) {
      throw new Error(data.error.message || "JSON-RPC Fehler");
    }
    return data.result;
  }

  // Login
  const login = await rpc("Session.login", {
    userName: cfg.user,
    password: cfg.password,
    application: { name: "JARVIS", vendor: "JARVIS" },
  });
  token = login.token;

  // Ordner-IDs holen
  const folders = await rpc("Folders.get");
  const folderMap = {};
  for (const f of folders.list) {
    folderMap[f.type] = f.id;
  }

  try {
    return await fn(rpc, folderMap);
  } finally {
    try {
      await rpc("Session.logout");
    } catch {}
  }
}

module.exports = { withSession };
