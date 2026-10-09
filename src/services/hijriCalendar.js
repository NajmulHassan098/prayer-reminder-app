// Hijri month data for the /hijri calendar page.
//
// One Aladhan call per (Gregorian month, city, country) — /calendarByCity
// returns the Hijri date for every day of the requested month, computed for
// the user's own region and calculation method, so the grid can never
// disagree with their prayer emails. Results are cached in memory for a day
// (Hijri dates for a past/present month never change; even future ones only
// shift if the whole convention changes), and any API hiccup falls back to
// the civil calculator in src/utils/hijri.js so the page always renders.
const axios = require("axios");
const { resolveCalcMethod } = require("./prayerTimes");
const { gregorianToHijri, HIJRI_MONTHS } = require("../utils/hijri");

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 60; // generous for months x cities on one instance; oldest evicted
const cache = new Map();

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Pure fallback: civil (Kuwaiti) Hijri for every day of a Gregorian month. */
function civilMonth(year, month) {
  const days = new Date(year, month, 0).getDate();
  const cells = [];
  for (let d = 1; d <= days; d++) {
    const h = gregorianToHijri(new Date(year, month - 1, d));
    cells.push({
      gregDate: `${year}-${pad2(month)}-${pad2(d)}`,
      hijriDay: h.day,
      hijriMonthNum: h.month,
      hijriMonthName: h.monthName,
      hijriYear: h.year,
      calculated: true,
    });
  }
  return cells;
}

function parseAladhanMonth(data, year, month) {
  if (!Array.isArray(data)) return null;
  const cells = [];
  for (const day of data) {
    const h = day && day.date && day.date.hijri;
    const g = day && day.date && day.date.gregorian;
    if (!h || !g) return null;
    cells.push({
      gregDate: `${year}-${pad2(month)}-${pad2(Number(g.day))}`,
      hijriDay: Number(h.day),
      hijriMonthNum: Number(h.month.number),
      hijriMonthName: h.month.en || HIJRI_MONTHS[Number(h.month.number) - 1] || String(h.month.number),
      hijriYear: String(h.year),
      calculated: false,
    });
  }
  cells.sort((a, b) => a.gregDate.localeCompare(b.gregDate));
  return cells.length ? cells : null;
}

/**
 * Hijri info for every day of a Gregorian month (month = 1..12), preferring
 * Aladhan's regional data for the user's city, falling back to civil
 * calculation. Always resolves to a full month of cells.
 */
async function getMonthHijri(user, year, month) {
  const city = (user.city || "").trim().toLowerCase();
  const country = (user.country || "").trim().toLowerCase();
  const key = `${year}-${pad2(month)}|${city}|${country}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.cells;

  let cells = null;
  if (city && country) {
    try {
      const res = await axios.get(
        `https://api.aladhan.com/v1/calendarByCity/${year}/${month}`,
        {
          params: { city: user.city, country: user.country, method: resolveCalcMethod(user.country) },
          timeout: 10000,
        }
      );
      cells = parseAladhanMonth(res.data && res.data.data, year, month);
    } catch (err) {
      console.warn(`[hijriCalendar] Aladhan month fetch failed for ${key}:`, err.message);
    }
  }
  if (!cells) cells = civilMonth(year, month);

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), cells });
  return cells;
}

module.exports = { getMonthHijri, civilMonth, parseAladhanMonth, _cache: cache };
