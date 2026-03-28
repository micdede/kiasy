const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");

const definitions = [
  {
    name: "hw_info",
    description:
      "Zeigt Hardware-Infos des Servers: CPU, RAM, Disk, Temperatur, Uptime, Netzwerk. " +
      "Nutze dies wenn der User nach System-Status, Hardware, Speicher, Temperatur oder Performance fragt.",
    input_schema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: ["all", "cpu", "ram", "disk", "temp", "network", "uptime"],
          description:
            "Welcher Bereich? 'all' für komplette Übersicht (Standard)",
        },
      },
      required: [],
    },
  },
];

function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 10000 }).trim();
  } catch {
    return null;
  }
}

function getCPU() {
  const model =
    run("lscpu | grep 'Model name'")?.replace(/.*:\s+/, "") || "unbekannt";
  const cores = os.cpus().length;
  const loadAvg = os.loadavg().map((l) => l.toFixed(2));
  const usage = run(
    "top -bn1 | grep 'Cpu(s)' | awk '{print 100 - $8}'"
  );
  return [
    `**CPU**: ${model}`,
    `Kerne: ${cores} | Last: ${loadAvg.join(", ")} (1/5/15 min)`,
    usage ? `Auslastung: ${parseFloat(usage).toFixed(1)}%` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function getRAM() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const pct = ((used / total) * 100).toFixed(1);
  const fmt = (b) => (b / 1024 / 1024 / 1024).toFixed(1) + " GB";
  // Swap
  const swap = run("free -b | grep Swap")
    ?.split(/\s+/)
    .slice(1);
  let swapLine = "";
  if (swap && parseInt(swap[0]) > 0) {
    const swapUsed = (parseInt(swap[1]) / 1024 / 1024 / 1024).toFixed(1);
    const swapTotal = (parseInt(swap[0]) / 1024 / 1024 / 1024).toFixed(1);
    swapLine = `\nSwap: ${swapUsed} / ${swapTotal} GB`;
  }
  return `**RAM**: ${fmt(used)} / ${fmt(total)} (${pct}%)${swapLine}`;
}

function getDisk() {
  const df = run("df -h / --output=size,used,avail,pcent | tail -1");
  if (!df) return "**Disk**: nicht verfügbar";
  const parts = df.trim().split(/\s+/);
  return `**Disk**: ${parts[1]} / ${parts[0]} belegt (${parts[3]}), ${parts[2]} frei`;
}

function getTemp() {
  const zones = [];
  try {
    const base = "/sys/class/thermal";
    const dirs = fs.readdirSync(base).filter((d) => d.startsWith("thermal_zone"));
    for (const dir of dirs) {
      const temp = fs
        .readFileSync(`${base}/${dir}/temp`, "utf-8")
        .trim();
      const type = fs
        .readFileSync(`${base}/${dir}/type`, "utf-8")
        .trim();
      zones.push(`${type}: ${(parseInt(temp) / 1000).toFixed(1)}°C`);
    }
  } catch {}
  return zones.length > 0
    ? `**Temperatur**: ${zones.join(", ")}`
    : "**Temperatur**: keine Sensoren gefunden";
}

function getNetwork() {
  const hostname = os.hostname();
  const ips = run(
    "ip -4 addr show | grep 'inet ' | grep -v '127.0.0.1' | awk '{print $NF\": \"$2}'"
  );
  return [`**Netzwerk**: ${hostname}`, ips || "keine IPs gefunden"].join("\n");
}

function getUptime() {
  const upSec = os.uptime();
  const days = Math.floor(upSec / 86400);
  const hours = Math.floor((upSec % 86400) / 3600);
  const mins = Math.floor((upSec % 3600) / 60);
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return `**Uptime**: ${parts.join(" ")}`;
}

const sections = {
  cpu: getCPU,
  ram: getRAM,
  disk: getDisk,
  temp: getTemp,
  network: getNetwork,
  uptime: getUptime,
};

async function execute(name, input) {
  const section = input.section || "all";

  if (section === "all") {
    const results = Object.values(sections).map((fn) => fn());
    return results.join("\n\n");
  }

  if (sections[section]) {
    return sections[section]();
  }

  return `Unbekannte Section: ${section}. Verfügbar: ${Object.keys(sections).join(", ")}`;
}

module.exports = { definitions, execute };
