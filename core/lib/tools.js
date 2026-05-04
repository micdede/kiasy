// tools.js — Dynamisches Loading aller core/tools/*.js
//
// Konvention pro Tool-File:
//   export const definitions = [
//     { name, description, input_schema: {type:"object", properties:{}, required:[]} }
//   ];
//   export async function execute(name, input) { return result; }
//
// tool_settings.enabled = 0 deaktiviert ein Tool.
// Cache wird invalidiert via reload().

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as db from "./db.js";

const TOOLS_DIR = new URL("../tools/", import.meta.url).pathname;

let cached = null;  // { defs: [...], execMap: Map<name, fn>, modules: [...] }

export async function load(force = false) {
  if (cached && !force) return cached;

  const files = readdirSync(TOOLS_DIR)
    .filter(f => f.endsWith(".js") && !f.startsWith("_"))
    .sort();

  const settings = readSettings();
  const defs = [];
  const execMap = new Map();
  const modules = [];

  for (const file of files) {
    if (settings.has(file) && !settings.get(file)) {
      console.log(`[tools] ${file} disabled — skip`);
      continue;
    }
    try {
      // Cache-Buster für reload(true)
      const url = pathToFileURL(join(TOOLS_DIR, file)).href + (force ? `?v=${Date.now()}` : "");
      const mod = await import(url);
      const toolDefs = mod.definitions || [];
      const exec = mod.execute;
      if (!exec || !toolDefs.length) {
        console.warn(`[tools] ${file}: kein execute oder definitions — skip`);
        continue;
      }
      for (const d of toolDefs) {
        if (execMap.has(d.name)) {
          console.warn(`[tools] doppelter Tool-Name: ${d.name} (in ${file}) — überschreibt`);
        }
        defs.push(d);
        execMap.set(d.name, exec);
      }
      modules.push({ file, count: toolDefs.length });
      console.log(`[tools] loaded ${file} → ${toolDefs.map(d => d.name).join(", ")}`);
    } catch (err) {
      console.error(`[tools] ${file} load failed:`, err.message);
    }
  }

  cached = { defs, execMap, modules };
  console.log(`[tools] ${defs.length} tool(s) aktiv aus ${modules.length} file(s)`);
  return cached;
}

function readSettings() {
  const settings = new Map();
  try {
    const rows = db.get().prepare("SELECT filename, enabled FROM tool_settings").all();
    for (const r of rows) settings.set(r.filename, r.enabled === 1);
  } catch (err) {
    console.warn("[tools] tool_settings konnte nicht gelesen werden:", err.message);
  }
  return settings;
}

export async function getDefinitions() {
  const { defs } = await load();
  return defs;
}

export async function execute(name, input) {
  const { execMap } = await load();
  const fn = execMap.get(name);
  if (!fn) throw new Error(`Tool nicht gefunden: ${name}`);
  return fn(name, input || {});
}

export async function listInfo() {
  const { defs, modules } = await load();
  return {
    tools: defs.map(d => ({ name: d.name, description: d.description })),
    files: modules
  };
}

export function reload() {
  cached = null;
}
