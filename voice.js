// voice.js – Shared TTS/STT Modul für Telegram und Monitor-Dashboard
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const WHISPER_MODEL = process.env.WHISPER_MODEL || "tiny";
const TTS_VOICE = process.env.TTS_VOICE || "de-DE-KillianNeural";
// edge-tts Rate: "+0%" = normal, "+15%" = etwas schneller. Werte: -100% bis +100%.
const TTS_RATE = process.env.TTS_RATE || "+15%";
const TEMP_DIR = path.join(__dirname, "temp");

fs.mkdirSync(TEMP_DIR, { recursive: true });

/**
 * Transkribiert eine Audio-Datei per Whisper.
 * @param {string} audioFilePath – Pfad zur Audio-Datei (beliebiges Format, ffmpeg konvertiert)
 * @returns {string|null} – Transkribierter Text oder null
 */
function transcribe(audioFilePath) {
  try {
    // Nach WAV konvertieren (16kHz mono – Whisper arbeitet zuverlässiger damit)
    const wavFile = path.join(TEMP_DIR, `whisper_${Date.now()}.wav`);
    try {
      execSync(
        `ffmpeg -i "${audioFilePath}" -ar 16000 -ac 1 "${wavFile}" -y`,
        { timeout: 15000, stdio: ["pipe", "pipe", "pipe"] }
      );
    } catch (ffErr) {
      console.error("[voice] ffmpeg-Fehler:", ffErr.stderr?.toString() || ffErr.message);
      throw ffErr;
    }

    const whisperBin = path.join(__dirname, "venv", "bin", "whisper");
    try {
      execSync(
        `"${whisperBin}" "${wavFile}" --model ${WHISPER_MODEL} --language de --output_format txt --output_dir "${TEMP_DIR}"`,
        { timeout: 300000, stdio: ["pipe", "pipe", "pipe"] }
      );
    } catch (wErr) {
      console.error("[voice] whisper-Fehler:", wErr.stderr?.toString() || wErr.message);
      try { fs.unlinkSync(wavFile); } catch {}
      throw wErr;
    }

    const txtFile = wavFile.replace(/\.[^.]+$/, ".txt");
    let text = null;
    if (fs.existsSync(txtFile)) {
      text = fs.readFileSync(txtFile, "utf-8").trim();
      try { fs.unlinkSync(txtFile); } catch {}
    }

    if (!text) {
      // Diagnose: WAV-Datei aufheben, damit wir sie analysieren können
      const debugFile = path.join(TEMP_DIR, `whisper_debug_last.wav`);
      try { fs.copyFileSync(wavFile, debugFile); } catch {}
      console.error(`[voice] Whisper hat keinen Text geliefert. Debug-WAV: ${debugFile}`);
    }

    try { fs.unlinkSync(wavFile); } catch {}
    return text || null;
  } catch (error) {
    console.error("Transkriptions-Fehler:", error.message);
    return null;
  }
}

/**
 * Wandelt Text in eine Sprachdatei um (edge-tts CLI + ffmpeg).
 * @param {string} text – Eingabetext (darf Markdown/Emojis enthalten)
 * @param {string} format – "ogg" (default, Opus für Telegram) oder "mp3" (für Clients ohne Opus-Support, z.B. macOS)
 * @returns {string|null} – Pfad zur Audio-Datei oder null
 */
function cleanForTTS(text) {
  return text
    .replace(/\*+([^*]+)\*+/g, "$1")
    .replace(/_+([^_]+)_+/g, "$1")
    .replace(/`{1,3}[^`]*`{1,3}/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/^[-•]\s*/gm, "")
    .replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{1F900}-\u{1F9FF}]/gu, "")
    .trim();
}

async function textToSpeech(text, format = "ogg") {
  const cleanText = cleanForTTS(text);
  if (!cleanText) return null;
  const piper = require("./lib/piper-client");
  if (piper.isEnabled()) {
    const out = await textToSpeechPiper(cleanText, format);
    if (out) return out;
    console.warn("[tts] Piper-Fallback auf Edge-TTS");
  }
  return textToSpeechEdge(cleanText, format);
}

async function textToSpeechPiper(cleanText, format) {
  const piper = require("./lib/piper-client");
  const id = Date.now();
  const wavFile = path.join(TEMP_DIR, `tts_piper_${id}.wav`);
  const outFile = path.join(TEMP_DIR, `tts_piper_${id}.${format}`);
  try {
    const { pcm, format: fmt } = await piper.synthesizePCM(cleanText);
    fs.writeFileSync(wavFile, piper.pcmToWav(pcm, fmt));
    const codec = format === "mp3" ? "libmp3lame -b:a 96k" : "libopus -b:a 48k";
    execSync(
      `ffmpeg -i "${wavFile}" -c:a ${codec} "${outFile}" -y`,
      { timeout: 15000, stdio: "ignore" }
    );
    return outFile;
  } catch (err) {
    console.error("[piper-tts] Fehler:", err.message);
    return null;
  } finally {
    try { fs.unlinkSync(wavFile); } catch {}
  }
}

function textToSpeechEdge(cleanText, format) {
  const id = Date.now();
  const txtFile = path.join(TEMP_DIR, `tts_${id}.txt`);
  const mp3File = path.join(TEMP_DIR, `tts_${id}.mp3`);
  const oggFile = path.join(TEMP_DIR, `tts_${id}.ogg`);
  try {
    fs.writeFileSync(txtFile, cleanText, "utf-8");
    const edgeTtsBin = path.join(__dirname, "venv", "bin", "edge-tts");
    execSync(
      `"${edgeTtsBin}" --voice "${TTS_VOICE}" --rate "${TTS_RATE}" --file "${txtFile}" --write-media "${mp3File}"`,
      { timeout: 30000 }
    );
    if (format === "mp3") return mp3File;
    execSync(
      `ffmpeg -i "${mp3File}" -c:a libopus -b:a 48k "${oggFile}" -y`,
      { timeout: 15000, stdio: "ignore" }
    );
    return oggFile;
  } catch (error) {
    console.error("TTS-Fehler:", error.message);
    try { fs.unlinkSync(oggFile); } catch {}
    return null;
  } finally {
    try { fs.unlinkSync(txtFile); } catch {}
    if (format !== "mp3") {
      try { fs.unlinkSync(mp3File); } catch {}
    }
  }
}

// --- Chatterbox-Variante (auskommentiert — lokal auf Unraid, für später wenn Deutsch besser wird) ---
//
// function textToSpeechChatterbox(text) {
//   const TTS_API_URL = process.env.TTS_API_URL || "http://localhost:8004";
//   const TTS_VOICE_CB = process.env.TTS_VOICE || "de-DE-KillianNeural.wav";
//   const id = Date.now();
//   const mp3File = path.join(TEMP_DIR, `tts_${id}.mp3`);
//   const oggFile = path.join(TEMP_DIR, `tts_${id}.ogg`);
//   try {
//     const cleanText = text
//       .replace(/\*+([^*]+)\*+/g, "$1").replace(/_+([^_]+)_+/g, "$1")
//       .replace(/`{1,3}[^`]*`{1,3}/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
//       .replace(/^#+\s*/gm, "").replace(/^[-•]\s*/gm, "")
//       .replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{1F900}-\u{1F9FF}]/gu, "")
//       .trim();
//     if (!cleanText) return null;
//     execSync(
//       `curl -s -X POST "${TTS_API_URL}/tts" -H "Content-Type: application/json" -d @- --output "${mp3File}"`,
//       { input: JSON.stringify({ text: cleanText, language: "de", voice_mode: "predefined",
//         predefined_voice_id: TTS_VOICE_CB, output_format: "mp3", split_text: true }), timeout: 60000 }
//     );
//     if (!fs.existsSync(mp3File) || fs.statSync(mp3File).size === 0) return null;
//     execSync(`ffmpeg -i "${mp3File}" -c:a libopus -b:a 48k "${oggFile}" -y`, { timeout: 15000, stdio: "ignore" });
//     return oggFile;
//   } catch (error) {
//     console.error("TTS-Chatterbox-Fehler:", error.message);
//     try { fs.unlinkSync(oggFile); } catch {}
//     return null;
//   } finally {
//     try { fs.unlinkSync(mp3File); } catch {}
//   }
// }

module.exports = { transcribe, textToSpeech };
