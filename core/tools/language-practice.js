// language-practice.js — Übersetze + Sprachausgabe via Telegram
// Wird vom Agent aufgerufen wenn User fragt "wie sagt man auf X ...",
// "übersetz das ins italienische und sprich es vor", o.ä.

import * as piper from "../lib/piper.js";
import { getProvider } from "../lib/providers.js";

const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT  = process.env.TELEGRAM_OWNER_CHAT_ID;

const LANG_NAMES = { en: "Englisch", fr: "Französisch", es: "Spanisch", it: "Italienisch", de: "Deutsch" };

// Default-Voice pro Sprache wählen
function pickVoice(lang) {
  const found = piper.VOICES.find(v => v.lang === lang);
  return found ? found.voice : process.env.PIPER_VOICE || "de_DE-thorsten-medium";
}

export const definitions = [{
  name: "translate_and_speak",
  description:
    "PFLICHT-Tool für ALLE Übersetzungs-Anfragen in andere Sprachen. " +
    "Übersetzt einen deutschen Satz und schickt das Ergebnis als Voice-Message in der ZIELSPRACHE-Stimme an Michael. " +
    "MUSST du IMMER nutzen wenn der User folgendes fragt:\n" +
    "  - 'Wie sagt man auf <Sprache>: ...'\n" +
    "  - 'Übersetz das ins <Sprache>'\n" +
    "  - 'Auf <Sprache>: ...'\n" +
    "  - 'Sag mir auf <Sprache> wie...'\n" +
    "  - 'Sprich mir das auf <Sprache> vor'\n" +
    "Niemals nur Text antworten — IMMER dieses Tool aufrufen, damit der User die korrekte Aussprache hört. " +
    "Sprachen: en (Englisch), fr (Französisch), es (Spanisch), it (Italienisch), de (Deutsch).",
  input_schema: {
    type: "object",
    properties: {
      text:        { type: "string", description: "Der deutsche Originaltext" },
      target_lang: { type: "string", enum: ["en","fr","es","it","de"], description: "Zielsprache (en/fr/es/it/de)" },
      voice:       { type: "string", description: "Optional: spezifische Piper-Voice (z.B. en_US-amy-medium). Default: passende für Sprache." }
    },
    required: ["text", "target_lang"]
  }
}];

export async function execute(name, input) {
  if (name !== "translate_and_speak") throw new Error(`unknown: ${name}`);
  if (!input?.text)        throw new Error("text erforderlich");
  if (!input?.target_lang) throw new Error("target_lang erforderlich");
  if (!TG_TOKEN || !TG_CHAT) throw new Error("TELEGRAM_TOKEN/CHAT_ID nicht gesetzt — Voice kann nicht geschickt werden");

  const langName = LANG_NAMES[input.target_lang] || input.target_lang;
  const voice    = input.voice || pickVoice(input.target_lang);

  // 1. Übersetzen — chat-Modell für bessere Qualität
  let translated = input.text;
  if (input.target_lang !== "de") {
    const llm = getProvider("chat");
    const trRes = await llm.chat({
      messages: [{ role: "user", content:
        `Übersetze WORTGETREU nach ${langName}. Behalte alle Substantive 1:1 bei. ` +
        `Gib NUR die Übersetzung als einen Satz zurück — kein Kommentar, keine Anführungszeichen, kein Markdown.\n\n` +
        `Deutsch: ${input.text}\n${langName}:` }],
      tools: [],
      system: `Du bist ein muttersprachlicher Übersetzer DE → ${langName}. Übersetze WÖRTLICH und korrekt.`
    });
    translated = (trRes.text || "").trim()
      .replace(/^["„»“]|["«»"]$/g, "")
      .replace(/^\*+|\*+$/g, "")
      .split("\n")[0].trim();
  }

  // 2. Synthesize via Piper → WAV
  const wav = await piper.synthesize(translated, { voice, asWav: true });

  // 3. Via Telegram als Voice-Message senden (multipart upload)
  const form = new FormData();
  form.append("chat_id", String(TG_CHAT));
  form.append("caption", `🇩🇪 ${input.text}\n\n${flagFor(input.target_lang)} ${translated}\n\n_Stimme: ${voice}_`);
  form.append("parse_mode", "Markdown");
  form.append("voice", new Blob([wav], { type: "audio/ogg" }), "translation.ogg");

  const tgRes = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendVoice`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30_000)
  });
  if (!tgRes.ok) {
    // Fallback: als Audio-Datei (WAV) wenn sendVoice mit WAV nicht akzeptiert
    const formA = new FormData();
    formA.append("chat_id", String(TG_CHAT));
    formA.append("caption", `🇩🇪 ${input.text}\n\n${flagFor(input.target_lang)} ${translated}`);
    formA.append("audio", new Blob([wav], { type: "audio/wav" }), "translation.wav");
    const r2 = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendAudio`, {
      method: "POST", body: formA, signal: AbortSignal.timeout(30_000)
    });
    if (!r2.ok) throw new Error(`Telegram-Send: HTTP ${tgRes.status}/${r2.status}: ${(await r2.text()).substring(0,200)}`);
    return { sent: true, fallback: "audio", original: input.text, translated, voice, lang: input.target_lang };
  }

  return {
    sent: true,
    original: input.text,
    translated,
    voice,
    lang: input.target_lang,
    bytes: wav.length
  };
}

function flagFor(lang) {
  return { en: "🇺🇸", fr: "🇫🇷", es: "🇪🇸", it: "🇮🇹", de: "🇩🇪" }[lang] || "🌐";
}
