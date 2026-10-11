// Unit tests for the pure helpers added by the feature batch: streak math,
// the ICS builder, i18n lookups/fallback, opt-in consent defaults, and the
// seasonal-event anchor computation. All synchronous, no I/O, timezone-safe.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const moment = require("moment-timezone");

// Pin timing config before the scheduler reads process.env.
process.env.PRE_REMINDER_MINUTES = "30";
process.env.SEND_GRACE_MINUTES = "10";

const {
  doneCountsByDate, currentStreak, bestStreakInMonth, monthSummary, shiftDate,
} = require("../src/utils/streaks");
const { t, isRtl, dirAttr, resolveLocale, SUPPORTED } = require("../src/utils/i18n");
const { buildICS, foldLine } = require("../src/routes/calendar")._test;
const { notifPrefsOf, buildSpecialEvents } = require("../src/services/scheduler");

const PRAYERS = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];

// ---- streaks ----------------------------------------------------------------
test("streaks: fast rows are ignored when counting prayer days", () => {
  const resp = [
    { date: "2026-10-01", prayer_name: "Fajr", status: "done" },
    { date: "2026-10-02", prayer_name: "Fast", status: "done" }, // not a salah
  ];
  assert.deepStrictEqual(doneCountsByDate(resp, PRAYERS), { "2026-10-01": 1 });
});

test("streaks: in-progress today does not break the run", () => {
  const done = { "2026-10-06": 3, "2026-10-07": 5, "2026-10-08": 1 };
  // today = 10-09 with nothing yet → streak counts back through 08/07/06 = 3.
  assert.strictEqual(currentStreak(done, "2026-10-09"), 3);
  // The grace only covers TODAY itself: if yesterday (08) is empty the run is over.
  assert.strictEqual(currentStreak({ "2026-10-06": 1, "2026-10-07": 1 }, "2026-10-09"), 0);
  // But ending yesterday (with today still open) counts back through it.
  assert.strictEqual(currentStreak({ "2026-10-07": 1, "2026-10-08": 2 }, "2026-10-09"), 2);
});

test("streaks: best-in-month ignores the future and monthSummary totals", () => {
  const done = { "2026-10-01": 1, "2026-10-02": 5, "2026-10-03": 2, "2026-10-15": 4 };
  assert.strictEqual(bestStreakInMonth(done, "2026-10", "2026-10-09"), 3); // 01-03
  const s = monthSummary(done, "2026-10", "2026-10-09");
  assert.deepStrictEqual(s, { daysActive: 3, fullDays: 1, totalDone: 8 });
  assert.strictEqual(shiftDate("2026-10-31", 1), "2026-11-01");
});

// ---- i18n -------------------------------------------------------------------
test("i18n: every supported locale has the exact same key set as English", () => {
  const dir = path.join(__dirname, "..", "src", "data", "i18n");
  const enKeys = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "en.json"), "utf8"))).sort();
  for (const loc of SUPPORTED.filter((l) => l !== "en")) {
    const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, `${loc}.json`), "utf8"))).sort();
    assert.deepStrictEqual(keys, enKeys, `${loc}.json key set differs from en.json`);
  }
});

test("i18n: interpolation, fallback chain, and RTL detection", () => {
  assert.strictEqual(t("en", "email.subject.followup", { prayer: "Asr" }), "Were you able to pray Asr?");
  // A real locale returns its own (softened) translation, never the raw key.
  assert.strictEqual(t("tr", "email.subject.followup", { prayer: "İkindi" }), "İkindi namazını kılabildin mi?");
  // A totally unknown key returns the key itself (and warns once).
  assert.strictEqual(t("en", "does.not.exist"), "does.not.exist");
  // Unknown locale falls back to English.
  assert.strictEqual(t("zz", "app.name"), "Prayer Times");
  assert.ok(isRtl("ar") && isRtl("ur") && !isRtl("tr") && !isRtl("en"));
  assert.strictEqual(dirAttr("ar"), "rtl");
  assert.strictEqual(dirAttr("en"), "ltr");
});

test("i18n: resolveLocale prefers an explicit supported choice over country", () => {
  const auto = (c) => (c === "Pakistan" ? "ur" : null);
  assert.strictEqual(resolveLocale({ country: "Pakistan" }, auto), "ur");
  assert.strictEqual(resolveLocale({ country: "Pakistan", locale: "en" }, auto), "en");
  assert.strictEqual(resolveLocale({ country: "Pakistan", locale: "xx" }, auto), "ur"); // bad choice ignored
  assert.strictEqual(resolveLocale({ country: "Chad" }, auto), "en"); // unmapped → en
});

// ---- ICS --------------------------------------------------------------------
test("ICS: builds TZID events with a VALARM and folds every line ≤75 octets", () => {
  const ics = buildICS([
    { date: "2026-10-09", timezone: "Asia/Karachi", city: "Karachi", times: { Fajr: "05:00", Asr: "16:00" } },
  ]);
  assert.match(ics, /^BEGIN:VCALENDAR/);
  assert.match(ics, /METHOD:PUBLISH/);
  assert.match(ics, /DTSTART;TZID=Asia\/Karachi:20261009T050000/);
  assert.match(ics, /TRIGGER:-PT\d+M/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
  // RFC5545: no content line may exceed 75 octets (excluding CRLF).
  for (const line of ics.split("\r\n")) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75, `line too long (${Buffer.byteLength(line)}): ${line}`);
  }
});

test("ICS: foldLine wraps long lines and keeps multi-byte chars intact", () => {
  const long = "DESCRIPTION:" + "karachi—ﷺ".repeat(20); // non-ASCII, definitely > 74
  const folded = foldLine(long);
  const parts = folded.split("\r\n");
  assert.ok(parts.length > 1, "should have folded into multiple physical lines");
  assert.ok(parts.slice(1).every((p) => p.startsWith(" ")), "continuation lines start with a space");
  // Rejoining (strip CRLF + the leading space of continuations) reproduces input.
  const rejoined = parts[0] + parts.slice(1).map((p) => p.slice(1)).join("");
  assert.strictEqual(rejoined, long);
  assert.ok(parts.every((p) => Buffer.byteLength(p, "utf8") <= 74));
});

// ---- consent defaults + seasonal anchors ------------------------------------
test("prefs: legacy prayers default ON; every new seasonal feature defaults OFF", () => {
  const p = notifPrefsOf({}); // no stored prefs at all
  for (const name of PRAYERS) assert.ok(p.enabled(name));
  assert.ok(p.pre && p.post);
  assert.strictEqual(p.sunnahFast, false);
  assert.strictEqual(p.ramadanEnabled, false);
  assert.strictEqual(p.ramadanSub("suhoor"), false);
});

test("buildSpecialEvents: Ayyam on 13–15 (not Ramadan) and the Ramadan trio anchors", () => {
  const row = { date: "2026-10-09", timezone: "Asia/Karachi", fajr: "05:00", maghrib: "18:45", isha: "20:15", imsak: "04:50" };

  const ayyamPrefs = notifPrefsOf({ notification_prefs: { sunnahFast: true } });
  const ayyam = buildSpecialEvents({ ...row, hijri_day: 14, hijri_month_num: 6 }, ayyamPrefs);
  assert.strictEqual(ayyam.length, 1);
  assert.strictEqual(ayyam[0].type, "sunnah_fast");
  // 09:00 local (default AYYAM_HOUR) = 04:00 UTC.
  assert.strictEqual(ayyam[0].at.toISOString(), "2026-10-09T04:00:00.000Z");

  const ramPrefs = notifPrefsOf({ notification_prefs: { ramadan: { enabled: true } } });
  const ram = buildSpecialEvents({ ...row, hijri_day: 15, hijri_month_num: 9 }, ramPrefs);
  assert.deepStrictEqual(ram.map((s) => s.type).sort(), ["iftar", "suhoor", "taraweeh"]);
  const suhoor = ram.find((s) => s.type === "suhoor");
  const iftar = ram.find((s) => s.type === "iftar");
  const taraweeh = ram.find((s) => s.type === "taraweeh");
  // suhoor = imsak(04:50)−45 = 04:05 PKT = 23:05Z prev day; iftar = maghrib−20; taraweeh = isha+45.
  assert.strictEqual(suhoor.at.tz("Asia/Karachi").format("HH:mm"), "04:05");
  assert.strictEqual(iftar.at.tz("Asia/Karachi").format("HH:mm"), "18:25");
  assert.strictEqual(taraweeh.at.tz("Asia/Karachi").format("HH:mm"), "21:00");
  // Ayyam is suppressed inside Ramadan even if sunnahFast were also on.
  const both = notifPrefsOf({ notification_prefs: { sunnahFast: true, ramadan: { enabled: true } } });
  assert.ok(!buildSpecialEvents({ ...row, hijri_day: 15, hijri_month_num: 9 }, both).some((s) => s.type === "sunnah_fast"));
});

test("buildSpecialEvents: pre-migration rows (no hijri fields) produce nothing", () => {
  const p = notifPrefsOf({ notification_prefs: { sunnahFast: true, ramadan: { enabled: true } } });
  assert.deepStrictEqual(buildSpecialEvents({ date: "2026-10-09", timezone: "Asia/Karachi", fajr: "05:00", maghrib: "18:45", isha: "20:15" }, p), []);
});

// ---- hijri helper (nav chip + fallbacks) -------------------------------------
const { gregorianToHijri, formatHijri, HIJRI_MONTHS } = require("../src/utils/hijri");

test("hijri: civil anchors land on the expected tabular dates", () => {
  // Kuwaiti/civil calendar: 1 Ramadan 1446 = 1 March 2025.
  const ramadan = gregorianToHijri(new Date(2025, 2, 1));
  assert.deepStrictEqual([ramadan.day, ramadan.month, ramadan.year], [1, 9, 1446]);
  // Mawlid 1446: observed 15 Sep 2024, civil calendar is within ±1 day.
  const mawlid = gregorianToHijri(new Date(2024, 8, 15));
  assert.strictEqual(mawlid.month, 3);
  assert.strictEqual(mawlid.year, 1446);
  assert.ok([11, 12].includes(mawlid.day), `unexpected civil day ${mawlid.day}`);
});

test("hijri: date advances by one day across a Gregorian midnight", () => {
  const a = gregorianToHijri(new Date(2026, 9, 9));
  const b = gregorianToHijri(new Date(2026, 9, 10));
  if (a.month === b.month) {
    assert.strictEqual(b.day, a.day + 1);
  } else {
    // month rolled over: new month must start at day 1 or 2 (30-day cap)
    assert.ok(b.day <= 2, `unexpected rollover to day ${b.day}`);
    assert.strictEqual(b.month, a.month === 12 ? 1 : a.month + 1);
  }
  assert.strictEqual(formatHijri(new Date(2026, 9, 9)), `${a.day} ${a.monthName} ${a.year}`);
  assert.ok(HIJRI_MONTHS.includes(a.monthName));
});

