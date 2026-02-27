const fs = require("fs");
const path = require("path");

const NOTES_DIR = path.join(__dirname, "..", "notes");

function ensureNotesDir() {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
}

function slugify(title) {
  let slug = title
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 80);

  if (!slug) slug = "notiz";

  // Kollisionsprüfung
  let filename = slug + ".md";
  let counter = 2;
  while (fs.existsSync(path.join(NOTES_DIR, filename))) {
    filename = slug + "-" + counter + ".md";
    counter++;
  }
  return filename;
}

function parseFrontmatter(content) {
  if (!content.startsWith("---\n")) {
    return { meta: {}, body: content };
  }

  const endIdx = content.indexOf("\n---\n", 4);
  if (endIdx === -1) {
    return { meta: {}, body: content };
  }

  const yamlBlock = content.substring(4, endIdx);
  const meta = {};
  for (const line of yamlBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim();
    let value = line.substring(colonIdx + 1).trim();
    // Tags als Array parsen: "tag1, tag2, tag3"
    if (key === "tags" && value) {
      value = value.split(",").map(t => t.trim()).filter(Boolean);
    }
    if (key && value !== undefined) {
      meta[key] = value;
    }
  }

  const body = content.substring(endIdx + 5);
  return { meta, body };
}

function buildFrontmatter(meta) {
  let yaml = "---\n";
  for (const [key, value] of Object.entries(meta)) {
    if (Array.isArray(value)) {
      yaml += key + ": " + value.join(", ") + "\n";
    } else {
      yaml += key + ": " + value + "\n";
    }
  }
  yaml += "---\n";
  return yaml;
}

function getAllNotes() {
  ensureNotesDir();
  const files = fs.readdirSync(NOTES_DIR).filter(f => f.endsWith(".md"));
  const notes = [];

  for (const file of files) {
    try {
      const filePath = path.join(NOTES_DIR, file);
      const content = fs.readFileSync(filePath, "utf-8");
      const stat = fs.statSync(filePath);
      const { meta, body } = parseFrontmatter(content);

      notes.push({
        filename: file,
        title: meta.title || file.replace(/\.md$/, ""),
        tags: Array.isArray(meta.tags) ? meta.tags : (meta.tags ? [meta.tags] : []),
        created: meta.created || stat.birthtime.toISOString().split("T")[0],
        updated: meta.updated || stat.mtime.toISOString().split("T")[0],
        size: stat.size,
        preview: body.trim().substring(0, 150),
      });
    } catch {}
  }

  // Sortiert nach updated desc
  notes.sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
  return notes;
}

function validateNoteFilename(filename) {
  if (!filename) return false;
  if (!filename.endsWith(".md")) return false;
  // Path-Traversal-Schutz
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) return false;
  if (filename.startsWith(".")) return false;
  return true;
}

module.exports = {
  NOTES_DIR,
  ensureNotesDir,
  slugify,
  parseFrontmatter,
  buildFrontmatter,
  getAllNotes,
  validateNoteFilename,
};
