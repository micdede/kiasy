const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ALLOWED_BASE = process.env.HOME || require("os").homedir();
const LOG_FILE = path.join(__dirname, "..", "logs", "actions.log");
const TIMEOUT = 30000;

function logAction(command, output) {
  const ts = new Date().toISOString();
  const short = output.substring(0, 500).replace(/\n/g, " ");
  fs.appendFileSync(LOG_FILE, `[${ts}] SHELL: ${command} → ${short}\n`);
}

const definitions = [
  {
    name: "shell",
    description:
      "Führt einen Bash-Befehl aus. " +
      "Timeout: 30 Sekunden. Nutze dies für: Systembefehle, npm/pip install, " +
      "Skripte starten, Git-Operationen, Prozesse prüfen.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Der auszuführende Bash-Befehl",
        },
      },
      required: ["command"],
    },
  },
];

async function execute(name, input) {
  const { command } = input;

  // Sicherheitscheck: kein Verlassen des Home-Verzeichnisses
  const dangerous = ["rm -rf /", "mkfs", "dd if=", "> /dev/", ":(){ :|:& };:"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Befehl aus Sicherheitsgründen blockiert.";
  }

  try {
    const output = execSync(command, {
      cwd: ALLOWED_BASE,
      timeout: TIMEOUT,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
      env: { ...process.env, HOME: ALLOWED_BASE },
    });

    const result = output.trim() || "(kein Output)";
    logAction(command, result);
    return result.substring(0, 3000);
  } catch (error) {
    const stderr = error.stderr?.trim() || "";
    const msg = stderr || error.message || "Unbekannter Fehler";
    logAction(command, `FEHLER: ${msg}`);
    return `Fehler: ${msg.substring(0, 2000)}`;
  }
}

module.exports = { definitions, execute };
