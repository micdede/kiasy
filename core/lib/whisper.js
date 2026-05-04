// whisper.js — STT via faster-whisper-asr-webservice (Container)

const URL = (process.env.WHISPER_URL || "http://whisper:9000").replace(/\/$/, "");

// Transkribiert ein Audio-Buffer (mp4/m4a/wav/mp3/ogg) → { text, language, duration }
export async function transcribe(audioBuffer, opts = {}) {
  const lang = opts.language || "de";
  const params = new URLSearchParams({
    language: lang,
    output:   "json",
    encode:   "true",
    task:     "transcribe"
  });

  const form = new FormData();
  form.append("audio_file", new Blob([audioBuffer]), "audio." + (opts.ext || "m4a"));

  const r = await fetch(`${URL}/asr?${params}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120_000)
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Whisper HTTP ${r.status}: ${txt.substring(0, 200)}`);
  }
  return r.json();
}
