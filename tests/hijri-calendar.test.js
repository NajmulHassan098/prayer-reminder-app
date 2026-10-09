// Unit tests for the Hijri calendar feature: dataset schema + matching, the
// pure month-grid builder (neighbor padding, moon-sighting adjustment,
// month-boundary safety), and the month service (Aladhan parsing, cache,
// civil fallback). The service test stubs axios.get in place — same module
// instance — and counts calls.
const test = require("node:test");
const assert = require("node:assert");

const axios = require("axios");
const { EVENTS, validateEvents, eventsFor } = require("../src/data/hijriEvents");
const { monthGrid, shortMonthName } = require("../src/utils/hijri");

// ---- dataset ---------------------------------------------------------------
test("hijri dataset: passes schema validation", () => {
  assert.deepStrictEqual(validateEvents(), []);
});

test("hijri dataset: tradition filtering", () => {
  const ashura = eventsFor(1, 10, "both");
  assert.ok(ashura.some((e) => e.id === "ashura"));
  assert.ok(eventsFor(1, 10, "sunni").some((e) => e.id === "ashura"));
  assert.ok(eventsFor(1, 10, "shia").some((e) => e.id === "ashura"));
  // Ghadir is Shia-only: absent under the Sunni filter, present under both.
  assert.deepStrictEqual(eventsFor(12, 18, "sunni"), []);
  assert.ok(eventsFor(12, 18, "shia").some((e) => e.id === "ghadir-khumm"));
  assert.ok(eventsFor(12, 18, "both").some((e) => e.id === "ghadir-khumm"));
  // Mawlid differs by tradition: 12 Rabi I Sunni, 17 Rabi I Shia.
  assert.ok(eventsFor(3, 12, "sunni").some((e) => e.id === "mawlid-sunni"));
  assert.ok(eventsFor(3, 17, "shia").some((e) => e.id === "mawlid-shia"));
});

test("hijri dataset: Ayyam al-Biḍ lands on 13-15 of EVERY month", () => {
  for (let m = 1; m <= 12; m++) {
    for (const d of [13, 14, 15]) {
      assert.ok(eventsFor(m, d, "both").some((e) => e.id === "ayyam-al-bid"), `${m}/${d}`);
    }
    assert.ok(!eventsFor(m, 16, "both").some((e) => e.id === "ayyam-al-bid"));
  }
});

test("hijri dataset: Laylat al-Qadr is a search, not one date", () => {
  const qadr = EVENTS.find((e) => e.id === "qadr-sunni");
  assert.deepStrictEqual(qadr.hijriDays, [21, 23, 25, 27, 29]); // odd nights only
  assert.ok(qadr.hijriDays.every((d) => d % 2 === 1));
});

// ---- month grid ------------------------------------------------------------
function fakeCells(year, month, days, hijriStart) {
  const cells = [];
  for (let d = 1; d <= days; d++) {
    let hd = hijriStart.day + d - 1, hm = hijriStart.month;
    while (hd > 30) { hd -= 30; hm = (hm % 12) + 1; } // toy 30-day months
    cells.push({
      gregDate: `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
      hijriDay: hd, hijriMonthNum: hm, hijriMonthName: "Muharram", hijriYear: "1448",
      calculated: false,
    });
  }
  return cells;
}

test("monthGrid: pads to whole weeks and matches events", () => {
  // October 2026 starts Thursday (dow 4) and has 31 days → 5 weeks = 35 cells.
  const cells = fakeCells(2026, 10, 31, { day: 1, month: 1 });
  const grid = monthGrid(cells, { tradition: "both", dayAdjust: 0 });
  assert.strictEqual(grid.weeks.length, 5);
  assert.strictEqual(grid.weeks.flat().length, 35);
  assert.strictEqual(grid.weeks[0][0].inMonth, false); // 4 leading neighbor days
  assert.strictEqual(grid.weeks[0][4].inMonth, true);
  assert.strictEqual(grid.weeks[0][4].gregDate, "2026-10-01");
  // Hijri 10 Muharram = day 10 of this toy month → Ashura marked.
  const ashuraCell = grid.weeks.flat().find((c) => c.gregDate === "2026-10-10");
  assert.ok(ashuraCell.events.some((e) => e.id === "ashura"));
  assert.ok(grid.eventDays >= 1);
});

test("monthGrid: dayAdjust shifts event matching only, never the date", () => {
  const cells = fakeCells(2026, 10, 31, { day: 1, month: 1 });
  const g1 = monthGrid(cells, { tradition: "both", dayAdjust: 1 });
  // adjust +1: the marker moves one day LATER (day 11 now matches 10).
  const day11 = g1.weeks.flat().find((c) => c.gregDate === "2026-10-11");
  const day10 = g1.weeks.flat().find((c) => c.gregDate === "2026-10-10");
  assert.ok(day11.events.some((e) => e.id === "ashura"));
  assert.ok(!day10.events.some((e) => e.id === "ashura"));
  assert.strictEqual(day11.hijriDay, 11); // displayed Hijri date untouched
});

test("monthGrid: adjustment at the month edge yields no match, never a crash", () => {
  const cells = fakeCells(2026, 10, 31, { day: 1, month: 1 });
  const g = monthGrid(cells, { tradition: "both", dayAdjust: 1 });
  const first = g.weeks.flat().find((c) => c.gregDate === "2026-10-01"); // hijri day 1
  assert.deepStrictEqual(first.events.filter((e) => e.id === "islamic-new-year"), []);
});

test("monthGrid: hijri range spans the month and short names work", () => {
  const cells = fakeCells(2026, 10, 31, { day: 18, month: 6 });
  const g = monthGrid(cells, { tradition: "both", dayAdjust: 0 });
  assert.match(g.hijriRange, /18 .* – .* 1448/);
  assert.strictEqual(shortMonthName("Rabi al-Awwal"), "Rabi I");
  assert.strictEqual(shortMonthName("Dhu al-Hijjah"), "Hijjah");
  assert.strictEqual(shortMonthName("Ramadān"), "Ramadan");
});

// ---- month service ---------------------------------------------------------
const { getMonthHijri, civilMonth, parseAladhanMonth, _cache } = require("../src/services/hijriCalendar");

test("civilMonth: full Gregorian month of calculated cells", () => {
  const cells = civilMonth(2026, 2); // Feb 2026 = 28 days
  assert.strictEqual(cells.length, 28);
  assert.ok(cells.every((c) => c.calculated && c.hijriDay >= 1 && c.hijriDay <= 30));
  assert.strictEqual(cells[0].gregDate, "2026-02-01");
});

test("parseAladhanMonth: maps and sorts the API shape", () => {
  const data = [
    { date: { gregorian: { day: "2" }, hijri: { day: "20", month: { number: "1" }, year: "1448" } } },
    { date: { gregorian: { day: "1" }, hijri: { day: "19", month: { number: "1" }, year: "1448" } } },
  ];
  const cells = parseAladhanMonth(data, 2026, 1);
  assert.strictEqual(cells.length, 2);
  assert.strictEqual(cells[0].gregDate, "2026-01-01");
  assert.strictEqual(cells[0].hijriDay, 19);
  assert.strictEqual(cells[0].calculated, false);
  assert.strictEqual(parseAladhanMonth({ not: "an array" }, 2026, 1), null);
});

test("getMonthHijri: caches per month, falls back to civil on failure", async () => {
  _cache.clear();
  const realGet = axios.get;
  let calls = 0;
  try {
    axios.get = async (url, cfg) => {
      calls++;
      const days = [];
      for (let d = 1; d <= 30; d++) {
        days.push({ date: { gregorian: { day: String(d) }, hijri: { day: String(d), month: { number: "5", en: "Jumada al-Akhirah" }, year: "1448" } } });
      }
      return { data: { data: days } };
    };
    const user = { city: "Karachi", country: "Pakistan" };
    const a = await getMonthHijri(user, 2026, 5);
    const b = await getMonthHijri(user, 2026, 5);
    assert.strictEqual(calls, 1); // second request served from cache
    assert.strictEqual(a.length, 30);
    assert.strictEqual(a[0].hijriMonthNum, 5);
  } finally {
    axios.get = realGet;
    _cache.clear();
  }
});

test("getMonthHijri: API hiccup or missing city → civil calendar, page still renders", async () => {
  _cache.clear();
  const realGet = axios.get;
  try {
    axios.get = async () => { throw new Error("network down"); };
    const cells = await getMonthHijri({ city: "Nowhere", country: "Land" }, 2026, 7);
    assert.strictEqual(cells.length, 31);
    assert.ok(cells.every((c) => c.calculated));
    // No location at all: no HTTP attempt, straight to civil.
    let attempted = false;
    axios.get = async () => { attempted = true; return { data: {} }; };
    const noCity = await getMonthHijri({ city: null, country: null }, 2026, 8);
    assert.strictEqual(attempted, false);
    assert.strictEqual(noCity.length, 31);
  } finally {
    axios.get = realGet;
    _cache.clear();
  }
});
