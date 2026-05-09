// files.js — sichere Filesystem-Operationen (sandboxed auf /data)

import { readFileSync, writeFileSync, statSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, relative, basename } from "node:path";

const ALLOWED_BASE = process.env.FILES_BASE || "/data";
const EXPORTS_DIR = `${ALLOWED_BASE}/exports`;  // Files hier sind via /api/files/<name> downloadbar
const MAX_READ = 200_000;

function safePath(p) {
  const abs = resolve(p.startsWith("/") ? p : `${ALLOWED_BASE}/${p}`);
  if (!abs.startsWith(ALLOWED_BASE)) {
    throw new Error(`Pfad außerhalb von ${ALLOWED_BASE}/ verboten`);
  }
  return abs;
}

function ensureExportsDir() {
  if (!existsSync(EXPORTS_DIR)) mkdirSync(EXPORTS_DIR, { recursive: true });
}

export const definitions = [
  {
    name: "file_read",
    description: `Liest eine Datei (Text). Pfad muss innerhalb ${ALLOWED_BASE}/ liegen.`,
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    }
  },
  {
    name: "file_write",
    description: `Schreibt eine Datei. Pfad muss innerhalb ${ALLOWED_BASE}/ liegen. Erstellt fehlende Verzeichnisse. WICHTIG: Wenn der User die Datei runterladen oder ansehen soll (CSV, JSON, Text-Reports etc.) → Pfad in "exports/<dateiname>" — Antwort enthält dann eine download_url die der User direkt in der App tappen kann.`,
    input_schema: {
      type: "object",
      properties: {
        path:    { type: "string" },
        content: { type: "string" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "file_list",
    description: `Listet Verzeichnisinhalt. Pfad muss innerhalb ${ALLOWED_BASE}/ liegen.`,
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    }
  }
];

export async function execute(name, input) {
  if (name === "file_read") {
    const p = safePath(input.path);
    const st = statSync(p);
    if (st.size > MAX_READ) throw new Error(`Datei zu groß: ${st.size} > ${MAX_READ}`);
    return { path: relative(ALLOWED_BASE, p), size: st.size, content: readFileSync(p, "utf8") };
  }
  if (name === "file_write") {
    const p = safePath(input.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, input.content);
    const result = { path: relative(ALLOWED_BASE, p), bytes: Buffer.byteLength(input.content) };
    // Wenn die Datei in /data/exports/ landet, ist sie via /api/files/<name>
    // downloadbar — diese URL ans Tool-Result hängen, damit Clients sie als
    // Datei-Card rendern können.
    ensureExportsDir();
    if (p.startsWith(EXPORTS_DIR)) {
      const filename = basename(p);
      result.download_url = `/api/files/${encodeURIComponent(filename)}`;
      result.filename = filename;
    }
    return result;
  }
  if (name === "file_list") {
    const p = safePath(input.path);
    const entries = readdirSync(p, { withFileTypes: true }).map(e => ({
      name: e.name,
      type: e.isDirectory() ? "dir" : "file"
    }));
    return { path: relative(ALLOWED_BASE, p), count: entries.length, entries };
  }
  throw new Error(`unknown: ${name}`);
}
