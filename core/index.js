// kiasy-core — Phase 1 Skelett
// Minimaler HTTP-Server mit /health.
// Echtes Agent-Loop, Tools, Telegram, Mail, Scheduler folgen in Phase 3.

import http from "node:http";
import { readFileSync, existsSync } from "node:fs";

const PORT = Number(process.env.PORT || 8080);
const VERSION = "0.1.0";
const STARTED = Date.now();

function pkgVersion() {
  try {
    return JSON.parse(readFileSync(new URL("./package.json", import.meta.url))).version;
  } catch { return VERSION; }
}

function checkUpstreams() {
  const upstreams = {
    ollama:  process.env.OLLAMA_URL  || null,
    qdrant:  process.env.QDRANT_URL  || null,
    whisper: process.env.WHISPER_URL || null,
    piper:   process.env.PIPER_HOST ? `${process.env.PIPER_HOST}:${process.env.PIPER_PORT||"10200"}` : null,
    searxng: process.env.SEARXNG_URL || null
  };
  return upstreams;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Health
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      service: "kiasy-core",
      version: pkgVersion(),
      uptime_s: Math.round((Date.now() - STARTED) / 1000),
      upstreams: checkUpstreams(),
      data_volume_mounted: existsSync("/data"),
    }, null, 2));
    return;
  }

  // Phase 1 Stub-API
  if (url.pathname === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ phase: 1, message: "Skelett läuft. Echte API folgt in Phase 3." }));
    return;
  }

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`kiasy-core ${pkgVersion()} — Phase 1 Skelett\nGet /health for status.\n`);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[kiasy-core] v${pkgVersion()} listening on :${PORT}`);
  console.log(`[kiasy-core] upstreams:`, checkUpstreams());
});

// Graceful Shutdown
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`[kiasy-core] ${sig} → shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
