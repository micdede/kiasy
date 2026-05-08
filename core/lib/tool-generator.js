// tool-generator.js — KI-gestützte Generierung neuer JARVIS-Tools
//
// API:
//   generate(description) → {code, suggestedFilename}
//   refine(currentCode, instruction) → {code}
//   testRun(code, input) → {result, error?, took_ms}
//   save(filename, code) → {path, parsed: bool, defs: [...]}

import { writeFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { getProvider } from "./providers.js";
import * as tools from "./tools.js";

const TOOLS_DIR = new URL("../tools/", import.meta.url).pathname;
const FILENAME_RE = /^[a-z][a-z0-9-]{0,40}\.js$/;

// ─── System-Prompt für Coding-LLM ───────────────────────────────
const SYSTEM_PROMPT = `\
Du generierst neue Tool-Module für JARVIS (Node.js, ES-Module).

PFLICHT-Pattern für jedes Tool-File:

\`\`\`js
// kurze-beschreibung.js — Eine Zeile was das Tool macht

import { someThing } from "node:something";  // bei Bedarf

export const definitions = [{
  name: "tool_name",                  // snake_case, eindeutig
  description: "Was das Tool tut, wann der Agent es nutzen soll. Konkret und kurz.",
  input_schema: {
    type: "object",
    properties: {
      param1: { type: "string", description: "..." },
      param2: { type: "number", description: "Optional", default: 10 }
    },
    required: ["param1"]
  }
}];

export async function execute(name, input, ctx = {}) {
  if (name !== "tool_name") throw new Error(\`unknown: \${name}\`);
  if (!input?.param1) throw new Error("param1 erforderlich");
  // ... Implementierung ...
  return { ok: true, /* result-Felder */ };
}
\`\`\`

REGELN:
- AUSSCHLIESSLICH JS-Code antworten — KEIN Markdown, KEINE Erklärung, KEINE Code-Fence
- Tool-Name in snake_case, eindeutig (z.B. "weather_quick", "linear_create_issue")
- input_schema als JSON-Schema, "required"-Array korrekt setzen
- execute() ist async, returnt JSON-serialisierbares Object
- Bei externen APIs: fetch + AbortSignal.timeout(10_000), Status-Check, sauberer Error
- Geheimnisse über process.env.<NAME> lesen, nie hardcoden
- ctx.chatId verfügbar (z.B. "ios-app", "telegram-XX") für source-aware tools
- Keine Imports aus anderen JARVIS-Files (außer Standard-Node)
- Nutze fetch (global verfügbar), nicht axios/got
- Keine npm-Packages importieren die nicht garantiert da sind`;

// ─── Generate ───────────────────────────────────────────────────
export async function generate(description) {
  if (!description?.trim()) throw new Error("description fehlt");
  const llm = getProvider("code");
  const res = await llm.chat({
    messages: [{
      role: "user",
      content: `Schreibe ein JARVIS-Tool für folgende Anforderung:\n\n${description}\n\nNur den vollständigen JS-Code, sonst nichts.`
    }],
    tools: [],
    system: SYSTEM_PROMPT
  });
  const code = stripCodeFence(res.text || "");
  const suggestedFilename = extractFilename(code) || "new-tool.js";
  return { code, suggestedFilename };
}

// ─── Refine ─────────────────────────────────────────────────────
export async function refine(currentCode, instruction) {
  if (!currentCode?.trim()) throw new Error("currentCode fehlt");
  if (!instruction?.trim()) throw new Error("instruction fehlt");
  const llm = getProvider("code");
  const res = await llm.chat({
    messages: [{
      role: "user",
      content:
        `Hier ist ein bestehendes JARVIS-Tool:\n\n\`\`\`js\n${currentCode}\n\`\`\`\n\n` +
        `Änderungswunsch: ${instruction}\n\n` +
        `Gib das KOMPLETTE überarbeitete Tool zurück (nicht nur den Diff). ` +
        `Nur den Code, kein Markdown.`
    }],
    tools: [],
    system: SYSTEM_PROMPT
  });
  const code = stripCodeFence(res.text || "");
  return { code };
}

// ─── Test-Run (Sandkasten via Subprocess) ───────────────────────
export async function testRun(code, input = {}) {
  const tmpFile = join(tmpdir(), `jarvis-tool-test-${randomBytes(4).toString("hex")}.mjs`);
  // Minimaler Wrapper: importiert das Tool, ruft execute() auf, liefert JSON
  const wrapper = `\
${code}

const __input = ${JSON.stringify(input)};
const __def = (definitions || [])[0];
if (!__def) { console.error(JSON.stringify({error:"keine definitions"})); process.exit(1); }
try {
  const result = await execute(__def.name, __input, { chatId: "test" });
  console.log(JSON.stringify({ ok: true, result }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err.message || String(err) }));
}
`;
  writeFileSync(tmpFile, wrapper);

  return new Promise((resolve) => {
    const t0 = Date.now();
    const proc = spawn("node", [tmpFile], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000
    });
    const stdout = []; const stderr = [];
    proc.stdout.on("data", c => stdout.push(c));
    proc.stderr.on("data", c => stderr.push(c));
    proc.on("close", (code) => {
      try { unlinkSync(tmpFile); } catch {}
      const took_ms = Date.now() - t0;
      const out = Buffer.concat(stdout).toString().trim();
      const err = Buffer.concat(stderr).toString().trim();
      // Letzte JSON-Zeile aus stdout parsen (Tool darf vorher console.log machen)
      const lastLine = out.split("\n").filter(l => l.trim().startsWith("{")).pop();
      let parsed = null;
      try { parsed = lastLine ? JSON.parse(lastLine) : null; } catch {}
      resolve({
        took_ms,
        exit_code: code,
        stdout: out.substring(0, 4000),
        stderr: err.substring(0, 2000),
        parsed
      });
    });
    proc.on("error", e => {
      try { unlinkSync(tmpFile); } catch {}
      resolve({ took_ms: Date.now()-t0, exit_code: -1, stderr: e.message, parsed: null });
    });
  });
}

// ─── Save ───────────────────────────────────────────────────────
export async function save(filename, code, { overwrite = false } = {}) {
  if (!FILENAME_RE.test(filename)) {
    throw new Error(`Ungültiger Dateiname: ${filename} (erlaubt: lowercase, ziffern, bindestrich, .js)`);
  }
  if (!code?.trim()) throw new Error("code fehlt");
  if (!existsSync(TOOLS_DIR)) mkdirSync(TOOLS_DIR, { recursive: true });

  const filepath = join(TOOLS_DIR, filename);
  const exists = existsSync(filepath);
  if (exists && !overwrite) {
    throw new Error(`Datei existiert bereits: ${filename}. Mit overwrite=true erzwingen.`);
  }

  writeFileSync(filepath, code);
  // Validieren: kann das Modul geladen werden + hat es definitions+execute?
  let parsed = false;
  let defs = [];
  let parseErr = null;
  try {
    tools.reload();
    const all = await tools.load(true);
    const fileBase = filename.replace(/\.js$/, "");
    defs = all.defs.filter(d => all.modules.find(m => m.file === filename));
    parsed = defs.length > 0;
    if (!parsed) parseErr = `Tool wurde nicht erkannt (keine definitions oder execute fehlt) — siehe core-Logs`;
  } catch (e) {
    parseErr = e.message;
  }
  return {
    path: filepath,
    filename,
    overwritten: exists,
    parsed,
    defs: defs.map(d => ({ name: d.name, description: d.description })),
    error: parseErr
  };
}

// ─── Read existing tool (für Refine) ────────────────────────────
export function read(filename) {
  if (!FILENAME_RE.test(filename)) throw new Error("Ungültiger Dateiname");
  const filepath = join(TOOLS_DIR, filename);
  if (!existsSync(filepath)) throw new Error("Tool nicht gefunden");
  return { filename, code: readFileSync(filepath, "utf8") };
}

// ─── Delete ─────────────────────────────────────────────────────
export function remove(filename) {
  if (!FILENAME_RE.test(filename)) throw new Error("Ungültiger Dateiname");
  const filepath = join(TOOLS_DIR, filename);
  if (!existsSync(filepath)) throw new Error("Tool nicht gefunden");
  unlinkSync(filepath);
  tools.reload();
  return { deleted: filename };
}

// ─── Helpers ────────────────────────────────────────────────────
function stripCodeFence(s) {
  // ```js ... ``` oder ``` ... ``` entfernen
  return s
    .replace(/^```(?:js|javascript|ts|typescript)?\s*\n/i, "")
    .replace(/\n```\s*$/i, "")
    .trim();
}

function extractFilename(code) {
  // 1. Zeile-Kommentar "// xxx.js — desc"
  const m1 = code.match(/^\/\/\s*([a-z][a-z0-9-]+\.js)/m);
  if (m1) return m1[1];
  // Tool-name aus definitions extrahieren → snake_case → kebab-case.js
  const m2 = code.match(/name:\s*["']([a-z][a-z0-9_]+)["']/);
  if (m2) return m2[1].replace(/_/g, "-") + ".js";
  return null;
}
