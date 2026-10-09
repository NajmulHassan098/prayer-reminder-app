/**
 * Hijri (Islamic lunar) date helper — no dependencies.
 *
 * Uses the Kuwaiti algorithm, the same civil/tabular arithmetic convention
 * Aladhan labels "Hijri (civil)". The app's primary source of the Hijri date
 * stays the value stored with the day's prayer times (migration 0003, which
 * mirrors Aladhan's response for the user's region); this module is the
 * always-available fallback so the date can render app-wide in the nav and
 * on pages whose DB row predates the migration or failed to store it.
 *
 * Civil-day convention: the Hijri date is keyed to the Gregorian calendar
 * day, so it rolls over at local midnight rather than Maghrib — matching
 * how the dashboard already labels todayTimes.hijri_day.
 */

const HIJRI_MONTHS = [
  "Muharram",
  "Safar",
  "Rabi al-Awwal",
  "Rabi al-Thani",
  "Jumada al-Ula",
  "Jumada al-Akhirah",
  "Rajab",
  "Sha'ban",
  "Ramadan",
  "Shawwal",
  "Dhu al-Qi'dah",
  "Dhu al-Hijjah",
];

/** Convert a JS Date (local day) to { day, month, monthName, year }. */
function gregorianToHijri(date) {
  let y = date.getFullYear();
  let m = date.getMonth() + 1;
  const d = date.getDate();
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  // Julian Day Number for the Gregorian date.
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  const jd =
    Math.floor(365.25 * (y + 4716)) +
    Math.floor(30.6001 * (m + 1)) +
    d +
    b -
    1524;
  // Kuwaiti algorithm.
  let l = jd - 1948440 + 10632;
  const n = Math.floor((l - 1) / 10631);
  l = l - 10631 * n + 354;
  const j =
    Math.floor((10985 - l) / 5316) * Math.floor((50 * l) / 17719) +
    Math.floor(l / 5670) * Math.floor((43 * l) / 15238);
  l =
    l -
    Math.floor((30 - j) / 15) * Math.floor((17719 * j) / 50) -
    Math.floor(j / 16) * Math.floor((15238 * j) / 43) +
    29;
  const month = Math.floor((24 * l) / 709);
  const day = l - Math.floor((709 * month) / 24);
  const year = 30 * n + j - 30;
  return {
    day,
    month,
    monthName: HIJRI_MONTHS[month - 1] || String(month),
    year,
  };
}

/** "12 Rabi al-Awwal 1446" — short label used across the UI. */
function formatHijri(date) {
  const h = gregorianToHijri(date || new Date());
  return `${h.day} ${h.monthName} ${h.year}`;
}

// Compact month names for calendar cells (both our civil names and the
// Aladhan spellings it may return for the same month).
const MONTH_SHORT = {
  "Muharram": "Muharram", "Safar": "Safar",
  "Rabi al-Awwal": "Rabi I", "Rabi' al-Awwal": "Rabi I", "Rabiʼ al-Awwal": "Rabi I",
  "Rabi I": "Rabi I", "Rabi al-Thani": "Rabi II", "Rabi II": "Rabi II",
  "Rabi' al-Thani": "Rabi II", "Rabiʼ al-Thani": "Rabi II",
  "Jumada al-Ula": "Jumada I", "Jumada I": "Jumada I",
  "Jumada al-Akhirah": "Jumada II", "Jumada II": "Jumada II", "Jumada al-Thani": "Jumada II",
  "Rajab": "Rajab", "Sha'ban": "Sha'ban", "Shaʼban": "Sha'ban", "Shaban": "Sha'ban",
  "Ramadan": "Ramadan", "Ramadān": "Ramadan",
  "Shawwal": "Shawwal", "Dhu al-Qi'dah": "Qi'dah", "Dhu al-Qiʼdah": "Qi'dah",
  "Dhu al-Hijjah": "Hijjah", "Zul-Hijjah": "Hijjah",
};
function shortMonthName(name) {
  if (!name) return "";
  return MONTH_SHORT[name] || name.split(" ").pop() || name;
}

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * Build the month grid (pure — takes pre-fetched Hijri cells, returns view
 * model). `cells` covers exactly one Gregorian month: [{ gregDate,
 * hijriDay, hijriMonthNum, hijriMonthName, hijriYear, calculated? }].
 *
 * The grid is always keyed to the GREGORIAN month (Hijri months are 29/30
 * days and would make the layout unstable); leading/trailing neighbor days
 * pad to whole weeks and get civil-calculated Hijri dates so their events
 * still show, dimmed. `dayAdjust` shifts event matching only (moon-sighting
 * preference), never the displayed date.
 *
 * Returns { weeks: [[cell x7]], hijriRange, hasCalculated, eventDays }.
 */
function monthGrid(cells, opts = {}) {
  const { eventsFor } = require("../data/hijriEvents");
  const tradition = opts.tradition || "both";
  const dayAdjust = Number(opts.dayAdjust) || 0;
  if (!cells.length) return { weeks: [], hijriRange: "", hasCalculated: false, eventDays: 0 };

  const [y, m] = cells[0].gregDate.split("-").map(Number);
  const byDate = new Map(cells.map((c) => [c.gregDate, c]));
  const firstDow = new Date(y, m - 1, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(y, m, 0).getDate();
  const total = Math.ceil((firstDow + daysInMonth) / 7) * 7;

  let eventDays = 0;
  const gridCells = [];
  for (let i = 0; i < total; i++) {
    const dayNum = i - firstDow + 1;
    const dt = new Date(y, m - 1, dayNum);
    const gregDate = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
    let cell;
    if (byDate.has(gregDate)) {
      cell = { ...byDate.get(gregDate), inMonth: true };
    } else {
      // Neighbor day outside the viewed month: civil calculation, dimmed.
      const h = gregorianToHijri(dt);
      cell = {
        gregDate, hijriDay: h.day, hijriMonthNum: h.month,
        hijriMonthName: h.monthName, hijriYear: h.year,
        calculated: true, inMonth: false,
      };
    }
    const matchDay = Number(cell.hijriDay) - dayAdjust;
    cell.events =
      matchDay >= 1 && matchDay <= 30
        ? eventsFor(cell.hijriMonthNum, matchDay, tradition)
        : [];
    cell.hijriShort = `${cell.hijriDay} ${shortMonthName(cell.hijriMonthName)}`;
    if (cell.events.length) eventDays++;
    gridCells.push(cell);
  }

  const weeks = [];
  for (let i = 0; i < gridCells.length; i += 7) weeks.push(gridCells.slice(i, i + 7));

  const firstIn = gridCells.find((c) => c.inMonth);
  const lastIn = [...gridCells].reverse().find((c) => c.inMonth);
  const sameYear = firstIn.hijriYear === lastIn.hijriYear;
  const start = `${firstIn.hijriDay} ${firstIn.hijriMonthName}${sameYear ? "" : ` ${firstIn.hijriYear}`}`;
  const hijriRange =
    firstIn === lastIn
      ? `${start} ${firstIn.hijriYear}`
      : `${start} – ${lastIn.hijriDay} ${lastIn.hijriMonthName} ${lastIn.hijriYear}`;

  return {
    weeks,
    hijriRange,
    hasCalculated: gridCells.some((c) => c.inMonth && c.calculated),
    eventDays,
  };
}

module.exports = { gregorianToHijri, formatHijri, monthGrid, shortMonthName, HIJRI_MONTHS };
