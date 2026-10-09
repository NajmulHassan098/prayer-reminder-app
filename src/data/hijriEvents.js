// Loader + matcher for the curated Hijri event dataset (hijri-events.json).
//
// Same "static curated content" pattern as reminders.js: the JSON file is the
// single source of event data, this module only validates and queries it.
// validateEvents() runs inside the unit tests so a hand-edit that breaks the
// schema (bad month, day 31, unknown tradition/type) fails loudly instead of
// silently dropping an observance from the calendar.
//
// IMPORTANT (like reminders.js): dates here were compiled from common
// chronology references, not live scholarly review. Anything carrying a
// `disputed` note varies by source or scholarly opinion — verify against
// primary sources before treating the page as authoritative, and remember
// local moon sighting always takes precedence for worship.

const EVENTS = require("./hijri-events.json");

const TRADITIONS = ["sunni", "shia"];
const TYPES = ["festival", "solemn", "night", "observance", "sunnah"];

function validateEvents(events = EVENTS) {
  const errors = [];
  const ids = new Set();
  for (const e of events) {
    const where = e.id || JSON.stringify(e).slice(0, 40);
    if (!e.id || ids.has(e.id)) errors.push(`duplicate/missing id: ${where}`);
    ids.add(e.id);
    if (!e.everyMonth && !(Number(e.hijriMonth) >= 1 && Number(e.hijriMonth) <= 12))
      errors.push(`${e.id}: hijriMonth must be 1..12 (or everyMonth)`);
    if (!Array.isArray(e.hijriDays) || !e.hijriDays.length)
      errors.push(`${e.id}: hijriDays must be a non-empty array`);
    else if (e.hijriDays.some((d) => !(Number(d) >= 1 && Number(d) <= 30)))
      errors.push(`${e.id}: hijriDays must all be 1..30`);
    if (!Array.isArray(e.traditions) || !e.traditions.length ||
        e.traditions.some((t) => !TRADITIONS.includes(t)))
      errors.push(`${e.id}: traditions must be a non-empty subset of sunni/shia`);
    if (!TYPES.includes(e.type)) errors.push(`${e.id}: unknown type ${e.type}`);
    if (!e.name || !e.description) errors.push(`${e.id}: name and description required`);
  }
  return errors;
}

/**
 * Events observed on a given Hijri date, filtered by tradition.
 * `tradition`: "both" | "sunni" | "shia". An event matches when its
 * traditions list intersects the filter (shared events list both).
 */
function eventsFor(hijriMonth, hijriDay, tradition = "both") {
  const m = Number(hijriMonth);
  const d = Number(hijriDay);
  if (!Number.isFinite(m) || !Number.isFinite(d)) return [];
  return EVENTS.filter((e) => {
    if (e.everyMonth ? false : e.hijriMonth !== m) return false;
    if (e.hijriDays.indexOf(d) === -1) return false;
    if (tradition === "both") return true;
    return e.traditions.includes(tradition);
  });
}

/**
 * Which Hijri (month, day) an event marker "belongs" to after the user's
 * moon-sighting adjustment: matching happens against `hijriDay - dayAdjust`
 * wrapped inside the displayed Hijri month. We never invent month lengths,
 * so a wrap off either end of the month simply yields no match for that day
 * (the neighboring day picks it up) — the grid shows at most a ±1-day shift.
 */
function adjustedLookup(hijriMonth, hijriDay, dayAdjust) {
  let d = Number(hijriDay) - Number(dayAdjust || 0);
  let m = Number(hijriMonth);
  if (d < 1) return null; // would need day 0/−x of the previous month: skip
  if (d > 30) return null;
  return { month: m, day: d };
}

module.exports = { EVENTS, validateEvents, eventsFor, adjustedLookup, TRADITIONS, TYPES };
