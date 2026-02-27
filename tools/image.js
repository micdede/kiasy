const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const ALLOWED_BASE = "/home/mcde";

// Queue wird vom Agent-Loop gelesen und von index.js verarbeitet
let imageQueue = [];

function getQueue() {
  const queue = [...imageQueue];
  imageQueue = [];
  return queue;
}

function validatePath(filePath) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(ALLOWED_BASE + "/") && resolved !== ALLOWED_BASE) {
    throw new Error(`Zugriff verweigert: Pfad muss innerhalb von ${ALLOWED_BASE}/ liegen.`);
  }
  return resolved;
}

const definitions = [
  {
    name: "send_image",
    description:
      "Sendet ein Bild per WhatsApp an Michael. Das Bild muss als Datei unter /home/mcde/ existieren. " +
      "Unterstützte Formate: PNG, JPG, GIF, WEBP. " +
      "Nutze zuerst shell oder file_write um das Bild zu erstellen/herunterzuladen, dann dieses Tool zum Senden.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absoluter Pfad zur Bilddatei",
        },
        caption: {
          type: "string",
          description: "Optionale Bildunterschrift",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "generate_image",
    description:
      "Generiert ein Bild mit DALL-E 3 basierend auf einer Textbeschreibung. " +
      "Das Bild wird automatisch an den Nutzer gesendet. " +
      "Beschreibe das gewünschte Bild möglichst detailliert auf Englisch für beste Ergebnisse.",
    input_schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Bildbeschreibung (am besten auf Englisch für beste Ergebnisse)",
        },
        size: {
          type: "string",
          enum: ["1024x1024", "1024x1792", "1792x1024"],
          description: "Bildgröße: 1024x1024 (Quadrat), 1024x1792 (Hochformat), 1792x1024 (Querformat). Standard: 1024x1024",
        },
        quality: {
          type: "string",
          enum: ["standard", "hd"],
          description: "Bildqualität: standard oder hd. Standard: standard",
        },
      },
      required: ["prompt"],
    },
  },
];

async function execute(name, input) {
  if (name === "send_image") {
    const filePath = validatePath(input.path);

    if (!fs.existsSync(filePath)) {
      return `Datei nicht gefunden: ${filePath}`;
    }

    const ext = path.extname(filePath).toLowerCase();
    const allowed = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];
    if (!allowed.includes(ext)) {
      return `Nicht unterstütztes Format: ${ext}. Erlaubt: ${allowed.join(", ")}`;
    }

    const stats = fs.statSync(filePath);
    if (stats.size > 16 * 1024 * 1024) {
      return "Datei zu groß (max 16MB für WhatsApp).";
    }

    imageQueue.push({
      path: filePath,
      caption: input.caption || "",
    });

    return `Bild "${path.basename(filePath)}" wird gesendet.`;
  }

  if (name === "generate_image") {
    if (!process.env.OPENAI_API_KEY) {
      return "Fehler: OPENAI_API_KEY ist nicht konfiguriert. Bitte in den Einstellungen oder .env hinterlegen.";
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const size = input.size || "1024x1024";
    const quality = input.quality || "standard";

    try {
      const response = await client.images.generate({
        model: "dall-e-3",
        prompt: input.prompt,
        n: 1,
        size,
        quality,
      });

      const imageUrl = response.data[0].url;
      const revisedPrompt = response.data[0].revised_prompt;

      // Bild herunterladen
      const res = await fetch(imageUrl);
      if (!res.ok) throw new Error(`Download fehlgeschlagen: HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());

      const tempDir = path.join(__dirname, "..", "temp");
      fs.mkdirSync(tempDir, { recursive: true });
      const filePath = path.join(tempDir, `dall-e-${Date.now()}.png`);
      fs.writeFileSync(filePath, buffer);

      imageQueue.push({
        path: filePath,
        caption: revisedPrompt || input.prompt,
      });

      return `Bild generiert und wird gesendet. DALL-E Prompt: "${revisedPrompt || input.prompt}"`;
    } catch (err) {
      return `Fehler bei der Bildgenerierung: ${err.message}`;
    }
  }

  return "Unbekannte Image-Operation.";
}

module.exports = { definitions, execute, getQueue };
