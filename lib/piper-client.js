// lib/piper-client.js — Wyoming-Protocol-Client für Piper TTS
// Wyoming-Spec: https://github.com/rhasspy/wyoming
// Header (JSON + \n) → optional data (data_length bytes) → optional binary (payload_length bytes)

const net = require("net");

const HOST = process.env.PIPER_HOST || "";
const PORT = parseInt(process.env.PIPER_PORT || "10200", 10);
const VOICE = process.env.PIPER_VOICE || "de_DE-thorsten-high";
// Aggressives Timeout: Piper-medium liefert warm in ~100ms, kalt in 1-3s.
// 5s ist mehr als genug — bei mehr ist was kaputt, dann lieber sofort fallback.
const TIMEOUT_MS = parseInt(process.env.PIPER_TIMEOUT_MS || "5000", 10);

function isEnabled() {
  return Boolean(HOST);
}

function sendEvent(socket, type, data = null, payload = null) {
  // Inline-data-Variante: kompakt für kleine Daten
  const header = JSON.stringify({
    type,
    data,
    payload_length: payload ? payload.length : null,
  }) + "\n";
  socket.write(header);
  if (payload) socket.write(payload);
}

// Streaming-Parser: liefert Events mit JSON + optionalem Binary-Payload
class WyomingParser {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.buffer = Buffer.alloc(0);
    this.pendingJsonLen = 0;
    this.pendingPayloadLen = 0;
    this.currentEvent = null;
  }

  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      // Phase 1: noch JSON-Daten ausstehend?
      if (this.pendingJsonLen > 0) {
        if (this.buffer.length < this.pendingJsonLen) return;
        try {
          this.currentEvent.data = JSON.parse(this.buffer.slice(0, this.pendingJsonLen).toString("utf-8"));
        } catch {}
        this.buffer = this.buffer.slice(this.pendingJsonLen);
        this.pendingJsonLen = 0;
      }
      // Phase 2: Binary-Payload?
      if (this.pendingPayloadLen > 0) {
        if (this.buffer.length < this.pendingPayloadLen) return;
        this.currentEvent.payload = this.buffer.slice(0, this.pendingPayloadLen);
        this.buffer = this.buffer.slice(this.pendingPayloadLen);
        this.pendingPayloadLen = 0;
        this.onEvent(this.currentEvent);
        this.currentEvent = null;
        continue;
      }
      // Phase 3: aktuelles Event abgeschlossen?
      if (this.currentEvent && this.pendingJsonLen === 0 && this.pendingPayloadLen === 0) {
        this.onEvent(this.currentEvent);
        this.currentEvent = null;
      }
      // Phase 4: neuen Header lesen
      const nl = this.buffer.indexOf(0x0A);
      if (nl === -1) return;
      const headerStr = this.buffer.slice(0, nl).toString("utf-8");
      this.buffer = this.buffer.slice(nl + 1);
      let header;
      try { header = JSON.parse(headerStr); } catch { continue; }
      this.currentEvent = { type: header.type, data: header.data ?? null, payload: null };
      this.pendingJsonLen = header.data_length || 0;
      this.pendingPayloadLen = header.payload_length || 0;
      if (this.pendingJsonLen === 0 && this.pendingPayloadLen === 0) {
        this.onEvent(this.currentEvent);
        this.currentEvent = null;
      }
    }
  }
}

async function withSocket(fn) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: HOST, port: PORT });
    const timer = setTimeout(() => {
      socket.destroy(new Error(`Piper-Timeout (${TIMEOUT_MS}ms)`));
    }, TIMEOUT_MS);
    socket.once("error", (err) => { clearTimeout(timer); reject(err); });
    socket.once("connect", () => fn(socket, (val) => { clearTimeout(timer); resolve(val); }, (err) => { clearTimeout(timer); reject(err); }));
  });
}

/// Liefert PCM-Audio (Buffer) + Format {rate, width, channels}.
async function synthesizePCM(text, voiceName = VOICE) {
  const t0 = Date.now();
  return withSocket((socket, resolve, reject) => {
    let format = null;
    const chunks = [];
    const parser = new WyomingParser((ev) => {
      if (ev.type === "audio-start") format = ev.data;
      else if (ev.type === "audio-chunk" && ev.payload) chunks.push(ev.payload);
      else if (ev.type === "audio-stop") {
        socket.end();
        const totalBytes = chunks.reduce((s, c) => s + c.length, 0);
        console.log(`[piper] ${voiceName} ${text.length}c → ${totalBytes}b in ${Date.now()-t0}ms`);
        resolve({ pcm: Buffer.concat(chunks), format: format || { rate: 22050, width: 2, channels: 1 } });
      }
    });
    socket.on("data", (d) => parser.feed(d));
    socket.on("close", () => {
      if (chunks.length === 0) reject(new Error("Piper: kein Audio empfangen"));
    });
    sendEvent(socket, "synthesize", { text, voice: { name: voiceName } });
  });
}

/// Mini-Synthese um Piper das Voice-Modell laden zu lassen — verwerfen das Audio.
async function warmup(voiceName = VOICE) {
  try { await synthesizePCM("Hallo.", voiceName); }
  catch (e) { console.warn("[piper] Warmup fehlgeschlagen:", e.message); }
}

// PCM (16-bit LE) → WAV-Datei (in-memory Header)
function pcmToWav(pcm, format) {
  const { rate, width, channels } = format;
  const byteRate = rate * channels * width;
  const blockAlign = channels * width;
  const dataSize = pcm.length;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);            // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(width * 8, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  pcm.copy(buf, 44);
  return buf;
}

async function listVoices() {
  return withSocket((socket, resolve, reject) => {
    const parser = new WyomingParser((ev) => {
      if (ev.type === "info") {
        socket.end();
        const tts = ev.data?.tts || [];
        const out = [];
        for (const engine of tts) {
          for (const v of (engine.voices || [])) {
            if ((v.languages || []).some((l) => l.startsWith("de"))) {
              out.push({ name: v.name, description: v.description || v.name });
            }
          }
        }
        resolve(out);
      }
    });
    socket.on("data", (d) => parser.feed(d));
    socket.on("close", () => reject(new Error("Piper: keine info-Antwort")));
    sendEvent(socket, "describe");
  });
}

module.exports = { isEnabled, synthesizePCM, pcmToWav, listVoices, warmup };
