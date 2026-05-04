// shell.js — Bash-Befehle ausführen (Timeout 30s)

import { execSync } from "node:child_process";

const TIMEOUT = Number(process.env.SHELL_TIMEOUT_MS) || 30_000;
const MAX_OUTPUT = 10_000;

export const definitions = [{
  name: "shell",
  description: "Führt einen Bash-Befehl aus. Timeout 30s. Output max 10KB. Nutze für: Systembefehle, Git, Prozesse, Logs prüfen.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Bash-Befehl" },
      cwd:     { type: "string", description: "Working-Directory (optional, default: $HOME)" }
    },
    required: ["command"]
  }
}];

export async function execute(name, input) {
  if (name !== "shell") throw new Error(`unknown: ${name}`);
  if (!input?.command) throw new Error("command erforderlich");

  try {
    const out = execSync(input.command, {
      cwd: input.cwd || process.env.HOME || "/data",
      timeout: TIMEOUT,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 5 * 1024 * 1024
    });
    return { ok: true, output: truncate(out) };
  } catch (err) {
    return {
      ok: false,
      exit: err.status,
      output: truncate((err.stdout || "") + (err.stderr || "")),
      error: err.message
    };
  }
}

function truncate(s) {
  s = String(s || "");
  return s.length > MAX_OUTPUT ? s.substring(0, MAX_OUTPUT) + `\n... [${s.length - MAX_OUTPUT} chars truncated]` : s;
}
