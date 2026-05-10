// voice-ws.js — WebSocket-Server für Echtzeit-Sprachdialog (Port 8081)
//
// Protokoll Client→Server:
//   { type: "audio", data: base64(WAV 16kHz mono) }  — Audio für faster-whisper STT
//   { type: "text",  text: "..." }                   — Direkt-Text (kein STT)
//   { type: "stop" }                                  — Aktuelle Antwort abbrechen
//
// Protokoll Server→Client:
//   { type: "transcript",  text }        — STT-Ergebnis (sofort nach Whisper)
//   { type: "text_chunk",  text }        — LLM-Token (für Bubble-Anzeige)
//   { type: "audio_start", format }      — Piper-Format {rate, width, channels}
//   { type: "audio_chunk", data: base64} — PCM-Chunk (direkt von Piper, streaming)
//   { type: "done",        text }        — Ganzer Turn abgeschlossen
//   { type: "error",       message }     — Fehler

import { WebSocketServer } from "ws";
import * as whisper from "./whisper.js";
import * as agent from "./agent.js";
import * as piper from "./piper.js";

const WS_PORT = Number(process.env.WS_PORT || 8081);
const MIN_SENTENCE_LEN = 40;  // Kürzere Fragmente nicht einzeln synthetisieren

export function start() {
  const wss = new WebSocketServer({ port: WS_PORT });
  console.log(`[voice-ws] listening on :${WS_PORT}`);

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const chatId = url.searchParams.get("chatId") || "ios-realtime";
    console.log(`[voice-ws] connect chatId=${chatId}`);

    let abortCtl = null;

    ws.on("message", async raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === "stop") {
        abortCtl?.abort();
        return;
      }

      if (msg.type === "audio" || msg.type === "text") {
        abortCtl?.abort();
        abortCtl = new AbortController();
        const { signal } = abortCtl;

        try {
          let text = msg.text?.trim() || "";

          if (msg.type === "audio" && msg.data) {
            const buf = Buffer.from(msg.data, "base64");
            console.log(`[voice-ws] whisper transcribe ${buf.length} bytes`);
            const t0 = Date.now();
            const r = await whisper.transcribe(buf, { language: "de", ext: "wav" });
            text = r.text?.trim() || "";
            console.log(`[voice-ws] transcript in ${Date.now() - t0}ms: "${text}"`);
            if (!text) {
              safeSend(ws, { type: "error", message: "Keine Sprache erkannt" });
              return;
            }
            safeSend(ws, { type: "transcript", text });
          }

          if (!text || signal.aborted) return;
          await runTurn(ws, chatId, text, signal);

        } catch (e) {
          if (!signal.aborted) {
            console.error("[voice-ws] turn error:", e.message);
            safeSend(ws, { type: "error", message: e.message });
          }
        }
      }
    });

    ws.on("close", () => {
      abortCtl?.abort();
      console.log(`[voice-ws] disconnect chatId=${chatId}`);
    });
    ws.on("error", e => console.error("[voice-ws] ws error:", e.message));
  });

  return wss;
}

async function runTurn(ws, chatId, text, signal) {
  const t0 = Date.now();
  const ms = () => `${Date.now() - t0}ms`;

  let fullText = "";
  let ttsBuffer = "";
  let audioStartSent = false;
  let ttsChain = Promise.resolve();
  let firstDelta = true;
  let sentenceCount = 0;

  function flushTTS(sentence) {
    const s = sentence.trim();
    if (!s) return;
    const sentIdx = ++sentenceCount;
    const tPiperStart = Date.now();
    ttsChain = ttsChain.then(async () => {
      if (signal.aborted || ws.readyState !== 1) return;
      console.log(`[voice-ws] ⏱ T=${ms()} piper #${sentIdx} start: "${s.slice(0, 40)}"`);
      try {
        // synthesize gibt { pcm: Buffer, format: {rate,width,channels} } zurück.
        // synthesizeStreaming hatte "# channels not specified"-Bug in wyoming-piper.
        const { pcm, format } = await piper.synthesize(s);
        if (signal.aborted || ws.readyState !== 1) return;
        console.log(`[voice-ws] ⏱ T=${ms()} piper #${sentIdx} ready (${pcm.length} bytes, ${Date.now()-tPiperStart}ms synthesis)`);
        if (!audioStartSent) {
          audioStartSent = true;
          safeSend(ws, { type: "audio_start", format });
        }
        safeSend(ws, { type: "audio_chunk", data: pcm.toString("base64") });
        console.log(`[voice-ws] ⏱ T=${ms()} piper #${sentIdx} sent to client`);
      } catch (e) {
        console.error("[voice-ws] piper error:", e.message, "| text:", s.slice(0, 60));
      }
    });
  }

  for await (const ev of agent.streamHandle({ chatId, message: text })) {
    if (signal.aborted) break;

    if (ev.delta) {
      if (firstDelta) {
        firstDelta = false;
        console.log(`[voice-ws] ⏱ T=${ms()} first LLM delta`);
      }
      fullText += ev.delta;
      ttsBuffer += ev.delta;
      safeSend(ws, { type: "text_chunk", text: ev.delta });

      while (ttsBuffer.length >= MIN_SENTENCE_LEN) {
        const split = sentenceSplit(ttsBuffer);
        if (!split) break;
        flushTTS(split.spoken);
        ttsBuffer = split.remainder;
      }
    }

    if (ev.done && ttsBuffer.trim()) {
      flushTTS(ttsBuffer.trim());
      ttsBuffer = "";
    }
  }

  await ttsChain;

  if (!signal.aborted) {
    console.log(`[voice-ws] ⏱ T=${ms()} done sent (${sentenceCount} sentences, ${fullText.length} chars)`);
    safeSend(ws, { type: "done", text: fullText });
  }
}

// Satz-Grenze: .!? gefolgt von Whitespace + Großbuchstabe, oder Doppel-Newline
function sentenceSplit(text) {
  const re = /^([\s\S]*?[.!?])(\s+)([A-ZÄÖÜÀ-ɏ])/u;
  const m = text.match(re);
  if (m) {
    const remainder = m[3] + text.slice(m[1].length + m[2].length + 1);
    return { spoken: m[1].trim(), remainder };
  }
  if (text.includes("\n\n")) {
    const i = text.indexOf("\n\n");
    return { spoken: text.slice(0, i).trim(), remainder: text.slice(i + 2).trimStart() };
  }
  return null;
}

function safeSend(ws, obj) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {}
}
