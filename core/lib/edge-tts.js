// edge-tts.js — TTS via Python edge-tts CLI (rany2/edge-tts)
//
// Wir spawnen den CLI-Prozess (im Container per pip3 installiert) und
// fangen den MP3-Output über stdout ab. Das Python-Tool wird aktiv
// gepflegt und folgt Microsoft's anti-abuse Updates.
//
// API:
//   import * as edge from "./lib/edge-tts.js";
//   const { audio, mime } = await edge.synthesize("Hallo", { voice: "de-DE-KillianNeural" });
//   edge.VOICES  → kuratierte Stimmenliste

import { spawn } from "node:child_process";

const DEFAULT_VOICE  = process.env.EDGE_VOICE  || "de-DE-KillianNeural";
const DEFAULT_RATE   = process.env.EDGE_RATE   || "+0%";
const DEFAULT_PITCH  = process.env.EDGE_PITCH  || "+0Hz";
const DEFAULT_VOLUME = process.env.EDGE_VOLUME || "+0%";
const TIMEOUT        = Number(process.env.EDGE_TIMEOUT_MS) || 30_000;
const BIN            = process.env.EDGE_TTS_BIN || "edge-tts";

// ─── Kuratierte Stimmen (analog piper.js) ───────────────────────
export const VOICES = [
  // Deutsch
  { lang: "de", code: "de-DE", flag: "🇩🇪", name: "Killian (m, natürlich)",       voice: "de-DE-KillianNeural",       gender: "m", quality: "neural" },
  { lang: "de", code: "de-DE", flag: "🇩🇪", name: "Conrad (m, sachlich)",         voice: "de-DE-ConradNeural",        gender: "m", quality: "neural" },
  { lang: "de", code: "de-DE", flag: "🇩🇪", name: "Florian (m, multilingual)",    voice: "de-DE-FlorianMultilingualNeural", gender: "m", quality: "neural" },
  { lang: "de", code: "de-DE", flag: "🇩🇪", name: "Katja (w, warm)",              voice: "de-DE-KatjaNeural",         gender: "f", quality: "neural" },
  { lang: "de", code: "de-DE", flag: "🇩🇪", name: "Amala (w)",                    voice: "de-DE-AmalaNeural",         gender: "f", quality: "neural" },
  { lang: "de", code: "de-DE", flag: "🇩🇪", name: "Seraphina (w, multilingual)",  voice: "de-DE-SeraphinaMultilingualNeural", gender: "f", quality: "neural" },
  { lang: "de", code: "de-DE", flag: "🇩🇪", name: "Tanja (w)",                    voice: "de-DE-TanjaNeural",         gender: "f", quality: "neural" },
  { lang: "de", code: "de-DE", flag: "🇩🇪", name: "Klaus (m)",                    voice: "de-DE-KlausNeural",         gender: "m", quality: "neural" },
  { lang: "de", code: "de-CH", flag: "🇨🇭", name: "Jan (m, CH)",                  voice: "de-CH-JanNeural",           gender: "m", quality: "neural" },
  { lang: "de", code: "de-CH", flag: "🇨🇭", name: "Leni (w, CH)",                 voice: "de-CH-LeniNeural",          gender: "f", quality: "neural" },
  { lang: "de", code: "de-AT", flag: "🇦🇹", name: "Jonas (m, AT)",                voice: "de-AT-JonasNeural",         gender: "m", quality: "neural" },
  { lang: "de", code: "de-AT", flag: "🇦🇹", name: "Ingrid (w, AT)",               voice: "de-AT-IngridNeural",        gender: "f", quality: "neural" },
  // Englisch
  { lang: "en", code: "en-US", flag: "🇺🇸", name: "Andrew (m)",                   voice: "en-US-AndrewNeural",        gender: "m", quality: "neural" },
  { lang: "en", code: "en-US", flag: "🇺🇸", name: "Aria (w)",                     voice: "en-US-AriaNeural",          gender: "f", quality: "neural" },
  { lang: "en", code: "en-US", flag: "🇺🇸", name: "Guy (m)",                      voice: "en-US-GuyNeural",           gender: "m", quality: "neural" },
  { lang: "en", code: "en-US", flag: "🇺🇸", name: "Jenny (w)",                    voice: "en-US-JennyNeural",         gender: "f", quality: "neural" },
  { lang: "en", code: "en-GB", flag: "🇬🇧", name: "Ryan (m, GB)",                 voice: "en-GB-RyanNeural",          gender: "m", quality: "neural" },
  { lang: "en", code: "en-GB", flag: "🇬🇧", name: "Sonia (w, GB)",                voice: "en-GB-SoniaNeural",         gender: "f", quality: "neural" },
  // Französisch
  { lang: "fr", code: "fr-FR", flag: "🇫🇷", name: "Henri (m)",                    voice: "fr-FR-HenriNeural",         gender: "m", quality: "neural" },
  { lang: "fr", code: "fr-FR", flag: "🇫🇷", name: "Denise (w)",                   voice: "fr-FR-DeniseNeural",        gender: "f", quality: "neural" },
  // Spanisch
  { lang: "es", code: "es-ES", flag: "🇪🇸", name: "Alvaro (m)",                   voice: "es-ES-AlvaroNeural",        gender: "m", quality: "neural" },
  { lang: "es", code: "es-ES", flag: "🇪🇸", name: "Elvira (w)",                   voice: "es-ES-ElviraNeural",        gender: "f", quality: "neural" },
  // Italienisch
  { lang: "it", code: "it-IT", flag: "🇮🇹", name: "Diego (m)",                    voice: "it-IT-DiegoNeural",         gender: "m", quality: "neural" },
  { lang: "it", code: "it-IT", flag: "🇮🇹", name: "Elsa (w)",                     voice: "it-IT-ElsaNeural",          gender: "f", quality: "neural" }
];

/**
 * Synthesize Text → MP3-Buffer via Python edge-tts CLI.
 * @param {string} text
 * @param {{voice?: string, rate?: string, pitch?: string, volume?: string}} opts
 * @returns {Promise<{audio: Buffer, mime: string}>}
 */
export async function synthesize(text, opts = {}) {
  const voice  = opts.voice  || DEFAULT_VOICE;
  const rate   = opts.rate   || DEFAULT_RATE;
  const pitch  = opts.pitch  || DEFAULT_PITCH;
  const volume = opts.volume || DEFAULT_VOLUME;

  return new Promise((resolve, reject) => {
    const args = [
      "--voice", voice,
      "--rate",  rate,
      "--pitch", pitch,
      "--volume", volume,
      "--text",  text
      // ohne --write-media → MP3 landet auf stdout
    ];
    const proc = spawn(BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    const errChunks = [];
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { proc.kill("SIGKILL"); } catch {}
      reject(new Error(`Edge-TTS timeout after ${TIMEOUT}ms`));
    }, TIMEOUT);

    proc.stdout.on("data", c => chunks.push(c));
    proc.stderr.on("data", c => errChunks.push(c));
    proc.on("error", err => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error(`Edge-TTS spawn-Fehler (${BIN} fehlt?): ${err.message}`));
    });
    proc.on("close", code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0) {
        const err = Buffer.concat(errChunks).toString().trim();
        return reject(new Error(`Edge-TTS exit ${code}: ${err || "(stderr leer)"}`));
      }
      resolve({ audio: Buffer.concat(chunks), mime: "audio/mpeg" });
    });
  });
}
