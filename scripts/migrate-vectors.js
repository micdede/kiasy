#!/usr/bin/env node
// Einmalige Migration: Bestehende Daten in Qdrant vektorisieren
// Migriert: Memory, KB-Notizen, Chat-Nachrichten

const db = require("../lib/db");
const vm = require("../lib/vector-memory");
const fs = require("fs");
const path = require("path");

async function migrate() {
  console.log("=== Vector-Memory Migration ===\n");

  // Prüfe Qdrant
  if (!(await vm.isAvailable())) {
    console.error("Qdrant nicht erreichbar!");
    process.exit(1);
  }
  await vm.ensureCollection();

  let total = 0;

  // --- 1. Memory (facts, notes) ---
  console.log("1. Memory-Einträge...");
  const memAll = db.memory.getAll();
  const memItems = [];

  for (const category of ["facts", "notes"]) {
    for (const entry of memAll[category] || []) {
      const text = [entry.key, entry.value].filter(Boolean).join(": ");
      if (text.length < 5) continue; // Zu kurz, kein Wert
      memItems.push({
        id: `memory_${entry.id}`,
        text,
        payload: {
          type: "memory",
          category,
          source_id: String(entry.id),
          date: entry.added || "",
        },
      });
    }
  }

  if (memItems.length > 0) {
    await vm.upsertBatch(memItems);
    console.log(`   ${memItems.length} Memory-Einträge vektorisiert`);
    total += memItems.length;
  }

  // --- 2. KB-Notizen ---
  console.log("2. Wissensbasis-Notizen...");
  const notesDir = path.join(__dirname, "..", "notes");
  const kbItems = [];

  if (fs.existsSync(notesDir)) {
    const { parseFrontmatter } = require("../lib/notes-utils");
    const files = fs.readdirSync(notesDir).filter(f => f.endsWith(".md"));

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(notesDir, file), "utf-8");
        const { meta, body } = parseFrontmatter(content);
        const title = meta.title || file.replace(/\.md$/, "");

        // Große Notizen in Chunks aufteilen (~500 Zeichen)
        const chunks = chunkText(body, 500);
        for (let i = 0; i < chunks.length; i++) {
          const chunkText = chunks[i].trim();
          if (chunkText.length < 20) continue;
          kbItems.push({
            id: `kb_${file}_${i}`,
            text: `${title}: ${chunkText}`,
            payload: {
              type: "kb",
              source_id: file,
              title,
              chunk: i,
              date: meta.updated || meta.created || "",
            },
          });
        }
      } catch (e) {
        console.warn(`   Fehler bei ${file}: ${e.message}`);
      }
    }
  }

  if (kbItems.length > 0) {
    await vm.upsertBatch(kbItems);
    console.log(`   ${kbItems.length} KB-Chunks vektorisiert`);
    total += kbItems.length;
  }

  // --- 3. Chat-Nachrichten ---
  console.log("3. Chat-Nachrichten...");
  // Nur User-Nachrichten und wichtige Assistant-Antworten
  const allMsgs = db.db
    .prepare(
      `SELECT id, chat_id, role, text_preview, created_at
       FROM messages
       WHERE role IN ('user', 'assistant')
         AND msg_type = 'text'
         AND length(text_preview) > 20
       ORDER BY id`
    )
    .all();

  const chatItems = [];
  for (const msg of allMsgs) {
    // Tool-Aufrufe und sehr kurze Nachrichten skippen
    const text = msg.text_preview || "";
    if (text.startsWith("[Tool:") || text.startsWith("[Result]")) continue;
    if (text.length < 30) continue;

    // Problematische Zeichen entfernen die JSON kaputt machen
    const cleanText = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ");
    chatItems.push({
      id: `chat_${msg.id}`,
      text: `[${msg.role}] ${cleanText}`,
      payload: {
        type: "chat",
        source_id: String(msg.id),
        role: msg.role,
        chat_id: msg.chat_id,
        date: msg.created_at || "",
      },
    });
  }

  if (chatItems.length > 0) {
    // Große Menge → in kleineren Batches
    const BATCH = 20;
    for (let i = 0; i < chatItems.length; i += BATCH) {
      const batch = chatItems.slice(i, i + BATCH);
      try {
        await vm.upsertBatch(batch);
      } catch (e) {
        // Einzeln versuchen bei Batch-Fehler
        console.warn(`\n   Batch-Fehler bei ${i}, versuche einzeln...`);
        for (const item of batch) {
          try { await vm.upsert(item.id, item.text, item.payload); } catch (e2) {
            console.warn(`   Skip ${item.id}: ${e2.message.substring(0, 60)}`);
          }
        }
      }
      process.stdout.write(`   ${Math.min(i + BATCH, chatItems.length)}/${chatItems.length} Chat-Nachrichten...\r`);
    }
    console.log(`   ${chatItems.length} Chat-Nachrichten vektorisiert       `);
    total += chatItems.length;
  }

  // --- Statistik ---
  const stats = await vm.stats();
  console.log(`\n=== Migration abgeschlossen ===`);
  console.log(`Gesamt vektorisiert: ${total}`);
  console.log(`Punkte in Qdrant: ${stats.points}`);
  console.log(`Collection Status: ${stats.status}`);
}

// Text in Chunks aufteilen (an Absätzen/Sätzen)
function chunkText(text, maxLen = 500) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length > maxLen && current.length > 0) {
      chunks.push(current);
      current = "";
    }
    if (para.length > maxLen) {
      // Langen Absatz an Sätzen splitten
      const sentences = para.match(/[^.!?]+[.!?]+/g) || [para];
      for (const s of sentences) {
        if (current.length + s.length > maxLen && current.length > 0) {
          chunks.push(current);
          current = "";
        }
        current += s;
      }
    } else {
      current += (current ? "\n\n" : "") + para;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

migrate().catch(e => {
  console.error("Migration fehlgeschlagen:", e);
  process.exit(1);
});
