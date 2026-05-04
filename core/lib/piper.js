// Kuratierte Voice-Liste pro Sprache (Wyoming-Piper lädt on-demand)
export const VOICES = [
  // Deutsch
  { lang: "de", code: "de-DE", flag: "🇩🇪", name: "Thorsten (medium)",  voice: "de_DE-thorsten-medium",  gender: "m", quality: "medium" },
  { lang: "de", code: "de-DE", flag: "🇩🇪", name: "Thorsten (high)",    voice: "de_DE-thorsten-high",    gender: "m", quality: "high" },
  { lang: "de", code: "de-DE", flag: "🇩🇪", name: "Eva (low)",          voice: "de_DE-eva_k-x_low",      gender: "f", quality: "low" },
  // Englisch (US)
  { lang: "en", code: "en-US", flag: "🇺🇸", name: "Amy (medium)",       voice: "en_US-amy-medium",       gender: "f", quality: "medium" },
  { lang: "en", code: "en-US", flag: "🇺🇸", name: "Ryan (high)",        voice: "en_US-ryan-high",        gender: "m", quality: "high" },
  { lang: "en", code: "en-US", flag: "🇺🇸", name: "Lessac (high)",      voice: "en_US-lessac-high",      gender: "f", quality: "high" },
  // Englisch (GB)
  { lang: "en", code: "en-GB", flag: "🇬🇧", name: "Alan (medium)",      voice: "en_GB-alan-medium",      gender: "m", quality: "medium" },
  { lang: "en", code: "en-GB", flag: "🇬🇧", name: "Alba (medium)",      voice: "en_GB-alba-medium",      gender: "f", quality: "medium" },
  // Französisch
  { lang: "fr", code: "fr-FR", flag: "🇫🇷", name: "Siwis (medium)",     voice: "fr_FR-siwis-medium",     gender: "f", quality: "medium" },
  { lang: "fr", code: "fr-FR", flag: "🇫🇷", name: "Tom (medium)",       voice: "fr_FR-tom-medium",       gender: "m", quality: "medium" },
  { lang: "fr", code: "fr-FR", flag: "🇫🇷", name: "Upmc (medium)",      voice: "fr_FR-upmc-medium",      gender: "f", quality: "medium" },
  // Spanisch
  { lang: "es", code: "es-ES", flag: "🇪🇸", name: "DaveFX (medium)",    voice: "es_ES-davefx-medium",    gender: "m", quality: "medium" },
  { lang: "es", code: "es-ES", flag: "🇪🇸", name: "Carlfm (x_low)",     voice: "es_ES-carlfm-x_low",     gender: "m", quality: "low" },
  { lang: "es", code: "es-MX", flag: "🇲🇽", name: "Ald (medium)",       voice: "es_MX-ald-medium",       gender: "m", quality: "medium" },
  // Italienisch
  { lang: "it", code: "it-IT", flag: "🇮🇹", name: "Paola (medium)",     voice: "it_IT-paola-medium",     gender: "f", quality: "medium" },
  { lang: "it", code: "it-IT", flag: "🇮🇹", name: "Riccardo (x_low)",   voice: "it_IT-riccardo-x_low",   gender: "m", quality: "low" }
];

// piper.js — TTS via Wyoming-Protocol (rhasspy/wyoming-piper Container)
//
// Wyoming = JSONL-Header über TCP, dann optional binärer Payload.
// Für synthesize: schickt {type:"synthesize",data:{text}}, bekommt
// audio-start + audio-chunks + audio-stop zurück.

import { connect } from "node:net";

const HOST = process.env.PIPER_HOST || "piper";
const PORT = Number(process.env.PIPER_PORT || 10200);
const VOICE = process.env.PIPER_VOICE || "de_DE-thorsten-medium";
const TIMEOUT = Number(process.env.PIPER_TIMEOUT_MS) || 15_000;

// Synthesize → returns { pcm: Buffer, format: {rate, width, channels} } oder WAV-Buffer wenn asWav=true
export async function synthesize(text, opts = {}) {
  const voice = opts.voice || VOICE;

  return new Promise((resolve, reject) => {
    const sock = connect({ host: HOST, port: PORT });
    const chunks = [];
    let format = null;
    let buffer = Buffer.alloc(0);
    let phase = "header"; // header | data | payload
    let header = null;
    let dataBytes = 0;
    let payloadBytes = 0;
    let dataBuf = Buffer.alloc(0);

    const timeout = setTimeout(() => {
      sock.destroy();
      reject(new Error(`Piper timeout after ${TIMEOUT}ms`));
    }, TIMEOUT);

    sock.on("connect", () => {
      const synthesize = JSON.stringify({
        type: "synthesize",
        data: { text, voice: { name: voice } }
      });
      sock.write(synthesize + "\n");
    });

    sock.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length > 0) {
        if (phase === "header") {
          const nl = buffer.indexOf(0x0A);
          if (nl < 0) break;
          try {
            header = JSON.parse(buffer.subarray(0, nl).toString("utf8"));
          } catch (e) {
            return cleanup(new Error("Piper: invalid header"));
          }
          buffer = buffer.subarray(nl + 1);
          dataBytes = header.data_length || 0;
          payloadBytes = header.payload_length || 0;
          phase = dataBytes > 0 ? "data" : (payloadBytes > 0 ? "payload" : "header");
          if (phase === "header") handleHeader(header, null, null);
        } else if (phase === "data") {
          if (buffer.length < dataBytes) break;
          dataBuf = buffer.subarray(0, dataBytes);
          buffer = buffer.subarray(dataBytes);
          phase = payloadBytes > 0 ? "payload" : "header";
          if (phase === "header") handleHeader(header, dataBuf, null);
        } else if (phase === "payload") {
          if (buffer.length < payloadBytes) break;
          const payloadBuf = buffer.subarray(0, payloadBytes);
          buffer = buffer.subarray(payloadBytes);
          phase = "header";
          handleHeader(header, dataBuf, payloadBuf);
          dataBuf = Buffer.alloc(0);
        }
      }
    });

    function handleHeader(h, dataObj, payload) {
      const data = dataObj ? JSON.parse(dataObj.toString("utf8")) : null;
      switch (h.type) {
        case "audio-start":
          format = data || {};
          break;
        case "audio-chunk":
          if (payload) chunks.push(payload);
          break;
        case "audio-stop":
          cleanup(null);
          break;
        case "error":
          cleanup(new Error(`Piper: ${data?.text || "unknown error"}`));
          break;
      }
    }

    function cleanup(err) {
      clearTimeout(timeout);
      sock.destroy();
      if (err) return reject(err);
      const pcm = Buffer.concat(chunks);
      const out = opts.asWav ? pcmToWav(pcm, format) : { pcm, format };
      resolve(out);
    }

    sock.on("error", err => cleanup(new Error(`Piper socket: ${err.message}`)));
    sock.on("close", () => clearTimeout(timeout));
  });
}

// PCM → WAV-Wrapper (für direkten Audio-Play im Browser)
export function pcmToWav(pcm, format) {
  const rate = format?.rate || 22050;
  const channels = format?.channels || 1;
  const width = format?.width || 2;
  const dataSize = pcm.length;
  const wavSize = 36 + dataSize;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(wavSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);              // fmt chunk size
  header.writeUInt16LE(1, 20);               // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * width, 28);
  header.writeUInt16LE(channels * width, 32);
  header.writeUInt16LE(width * 8, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}
