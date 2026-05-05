// caldav-watcher.js — Cron-Ersatz: pollt CalDAV alle 5 Min,
// feuert Reminder/Aktionen wenn Events oder Task-Due-Dates fällig sind.
//
// Triggers:
//   - Default: Telegram-Reminder mit summary + description
//   - Description beginnt mit ">jarvis ..." → agent.handle(rest)
//   - Description beginnt mit ">tool <name> <json>" → tools.execute direkt
//
// Anti-Doppelfeuer: (uid, occurrence_iso) wird in caldav_fired Tabelle gemerkt.

import ICAL from "ical.js";
import * as db from "./db.js";
import * as agent from "./agent.js";
import * as tools from "./tools.js";
import * as telegram from "./telegram.js";
import * as calendar from "../tools/calendar.js";

const ENABLED       = process.env.CALDAV_WATCHER_ENABLED === "true";
const POLL_SECONDS  = Number(process.env.CALDAV_POLL_SECONDS) || 300;  // 5 Min
const WINDOW_FUTURE = 60_000;  // Events bis 60s in der Zukunft mit-feuern (Tick-Drift)

let timer = null;
let lastCheck = null;  // ISO

export function start() {
  if (!ENABLED) {
    console.log("[caldav-watcher] disabled (CALDAV_WATCHER_ENABLED != true)");
    return;
  }
  // last_check aus letztem Fire ableiten (oder jetzt)
  try {
    const row = db.get().prepare("SELECT MAX(fired_at) AS last FROM caldav_fired").get();
    lastCheck = row?.last ? new Date(row.last + "Z").toISOString() : new Date().toISOString();
  } catch {
    lastCheck = new Date().toISOString();
  }
  console.log(`[caldav-watcher] start, poll=${POLL_SECONDS}s, last=${lastCheck}`);
  // Ersten Tick nach 10s, dann Intervall
  setTimeout(tick, 10_000);
  timer = setInterval(tick, POLL_SECONDS * 1000);
}

export function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

async function tick() {
  const now = new Date();
  const since = new Date(lastCheck);
  const until = new Date(now.getTime() + WINDOW_FUTURE);
  try {
    await checkEvents(since, until);
    await checkTasks(now);
    lastCheck = now.toISOString();
  } catch (err) {
    console.error("[caldav-watcher] tick failed:", err.message);
  }
}

async function checkEvents(since, until) {
  let cal, c;
  try { cal = await calendar.getEventsCalendar(); c = await calendar.getClient(); }
  catch (err) { console.warn("[caldav-watcher] events: kein Kalender:", err.message); return; }
  // Hole Events für die nächsten ~10 min (kompakter Lookahead)
  // Plus seit letztem Check für Catchup
  const fetchStart = new Date(Math.min(since.getTime(), Date.now() - 60_000));
  const fetchEnd   = new Date(Date.now() + 10 * 60_000);
  const objects = await c.fetchCalendarObjects({
    calendar: cal,
    timeRange: { start: fetchStart.toISOString(), end: fetchEnd.toISOString() }
  });
  for (const obj of objects) {
    const ev = parseEvent(obj);
    if (!ev || !ev.start) continue;
    const startMs = new Date(ev.start).getTime();
    if (startMs >= since.getTime() && startMs <= until.getTime()) {
      const occurrence = ev.start;
      if (alreadyFired(ev.uid, occurrence)) continue;
      await fire("event", ev, occurrence);
    }
  }
}

async function checkTasks(now) {
  let cal, c;
  try { cal = await calendar.getTasksCalendar(); c = await calendar.getClient(); }
  catch (err) { console.warn("[caldav-watcher] tasks: kein Kalender:", err.message); return; }
  const objects = await c.fetchCalendarObjects({ calendar: cal });
  for (const obj of objects) {
    const t = calendar.todoToJson(obj);
    if (!t || !t.uid || !t.due) continue;
    if (t.status === "COMPLETED") continue;
    const dueMs = new Date(t.due).getTime();
    if (dueMs <= now.getTime()) {
      if (alreadyFired(t.uid, null)) continue;
      await fire("task", t, null);
    }
  }
}

function alreadyFired(uid, occurrence) {
  try {
    const row = db.get().prepare(
      "SELECT 1 FROM caldav_fired WHERE uid = ? AND COALESCE(occurrence_iso, '') = COALESCE(?, '')"
    ).get(uid, occurrence);
    return !!row;
  } catch { return false; }
}

async function fire(source, item, occurrence) {
  const summary = item.summary || "(ohne Titel)";
  const desc = (item.description || "").trim();
  let action = "reminder";
  let result = "";

  try {
    if (desc.startsWith(">jarvis ")) {
      action = "agent";
      const prompt = desc.substring(8).trim();
      console.log(`[caldav-watcher] agent fire uid=${item.uid} prompt="${prompt.substring(0,60)}"`);
      const chatId = process.env.TELEGRAM_OWNER_CHAT_ID || "system";
      const res = await agent.handle({ chatId, message: prompt });
      result = (res.text || "").substring(0, 500);
      await sendTelegram(`⏰ *${summary}*\n\n${result}`);
    } else if (desc.startsWith(">tool ")) {
      action = "tool";
      const rest = desc.substring(6).trim();
      const sp = rest.indexOf(" ");
      const toolName = sp >= 0 ? rest.substring(0, sp) : rest;
      const argStr = sp >= 0 ? rest.substring(sp + 1).trim() : "{}";
      const args = argStr ? JSON.parse(argStr) : {};
      console.log(`[caldav-watcher] tool fire uid=${item.uid} ${toolName} ${JSON.stringify(args)}`);
      const r = await tools.execute(toolName, args);
      result = JSON.stringify(r).substring(0, 500);
      await sendTelegram(`⏰ *${summary}*\n\n_(${toolName})_\n\`\`\`\n${result.substring(0, 300)}\n\`\`\``);
    } else {
      console.log(`[caldav-watcher] reminder fire uid=${item.uid} ${summary}`);
      const body = desc ? `*${summary}*\n${desc}` : `*${summary}*`;
      await sendTelegram(`⏰ ${body}`);
      result = "ok";
    }
  } catch (err) {
    result = `ERROR: ${err.message}`;
    console.error(`[caldav-watcher] fire failed uid=${item.uid}:`, err.message);
    await sendTelegram(`⚠ Termin-Aktion fehlgeschlagen: ${summary}\n${err.message}`).catch(()=>{});
  }

  try {
    db.get().prepare(
      "INSERT INTO caldav_fired (uid, occurrence_iso, source, summary, action, result) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(item.uid, occurrence, source, summary.substring(0, 200), action, result.substring(0, 500));
    db.logEvent({ type: "caldav-fire", message: `${action}: ${summary}`, meta: { uid: item.uid, source, action } });
  } catch (err) {
    console.error("[caldav-watcher] DB-write failed:", err.message);
  }
}

async function sendTelegram(text) {
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID;
  if (!chatId) return;
  try { await telegram.send(chatId, text); }
  catch (err) { console.error("[caldav-watcher] telegram send failed:", err.message); }
}

function parseEvent(obj) {
  try {
    const jcal = ICAL.parse(calendar.normalizeIcs(obj.data));
    const comp = new ICAL.Component(jcal);
    const vevent = comp.getFirstSubcomponent("vevent");
    if (!vevent) return null;
    const e = new ICAL.Event(vevent);
    return {
      uid: e.uid,
      summary: e.summary || "",
      description: e.description || "",
      location: e.location || "",
      start: e.startDate?.toJSDate()?.toISOString() || null,
      end: e.endDate?.toJSDate()?.toISOString() || null,
      url: obj.url
    };
  } catch (err) {
    console.warn("[caldav-watcher] parseEvent failed:", err.message);
    return null;
  }
}
