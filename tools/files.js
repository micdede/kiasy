const fs = require("fs");
const path = require("path");

const ALLOWED_BASE = process.env.HOME || require("os").homedir();
const MAX_READ_SIZE = 50000;

function validatePath(filePath) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(ALLOWED_BASE + "/") && resolved !== ALLOWED_BASE) {
    throw new Error(
      `Zugriff verweigert: Pfad muss innerhalb von ${ALLOWED_BASE}/ liegen.`
    );
  }
  return resolved;
}

const definitions = [
  {
    name: "file_read",
    description:
      `Liest eine Datei (Text, Code, PDF). Pfad muss innerhalb ${ALLOWED_BASE}/ liegen.`,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absoluter Dateipfad" },
      },
      required: ["path"],
    },
  },
  {
    name: "file_write",
    description:
      "Schreibt Inhalt in eine Datei. Erstellt Verzeichnisse automatisch. " +
      `Pfad muss innerhalb ${ALLOWED_BASE}/ liegen.`,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absoluter Dateipfad" },
        content: { type: "string", description: "Dateiinhalt" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "file_list",
    description:
      `Listet Dateien und Verzeichnisse auf. Pfad muss innerhalb ${ALLOWED_BASE}/ liegen.`,
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Verzeichnispfad",
          default: ALLOWED_BASE,
        },
      },
      required: ["path"],
    },
  },
];

async function execute(name, input) {
  switch (name) {
    case "file_read": {
      const filePath = validatePath(input.path);

      if (!fs.existsSync(filePath)) {
        return `Datei nicht gefunden: ${filePath}`;
      }

      if (filePath.endsWith(".pdf")) {
        try {
          const pdfParse = require("pdf-parse");
          const buffer = fs.readFileSync(filePath);
          const data = await pdfParse(buffer);
          return data.text.substring(0, MAX_READ_SIZE);
        } catch (error) {
          return `PDF-Fehler: ${error.message}. Tipp: shell tool nutzen um "cd ${path.join(__dirname, "..")} && npm install pdf-parse" auszuführen.`;
        }
      }

      const stats = fs.statSync(filePath);
      if (stats.size > MAX_READ_SIZE * 2) {
        return `Datei zu groß (${(stats.size / 1024).toFixed(0)} KB). Maximal ${MAX_READ_SIZE / 1000} KB.`;
      }

      const content = fs.readFileSync(filePath, "utf-8");
      if (content.length > MAX_READ_SIZE) {
        return content.substring(0, MAX_READ_SIZE) + "\n\n[... gekürzt]";
      }
      return content || "(leere Datei)";
    }

    case "file_write": {
      const filePath = validatePath(input.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, input.content, "utf-8");
      return `Geschrieben: ${filePath} (${input.content.length} Zeichen)`;
    }

    case "file_list": {
      const dirPath = validatePath(input.path);

      if (!fs.existsSync(dirPath)) {
        return `Verzeichnis nicht gefunden: ${dirPath}`;
      }

      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      if (entries.length === 0) return "(leeres Verzeichnis)";

      return entries
        .sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        })
        .map((e) => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`)
        .join("\n");
    }

    default:
      return "Unbekannte Datei-Operation.";
  }
}

module.exports = { definitions, execute };
