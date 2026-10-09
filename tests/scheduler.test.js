// Unit tests for the scheduler's send-window logic (npm test).
// Fake clock: every test passes `now` explicitly as a UTC instant, so these
// run identically on any machine in any timezone. No DB / SMTP / Supabase
// calls are made — planTickActions() and buildDayPlan() are pure functions.
const test = require("node:test");
const assert = require("node:assert");
const moment = require("moment-timezone");

// Pin timing config before the scheduler module reads process.env, so tests
// don't depend on the developer's local .env values.
process.env.PRE_REMINDER_MINUTES = "30";
process.env.FOLLOWUP_DELAY_MINUTES = "30";
process.env.MISSED_AFTER_MINUTES = "120";
process.env.SEND_GRACE_MINUTES = "10";

const {
  buildDayPlan,
  planTickActions,
  notifPrefsOf,
} = require("../src/services/scheduler");

// Fixed test day: Asr at 16:00 local in Asia/Karachi (UTC+5).
const ROW = {
  date: "2026-10-09",
  timezone: "Asia/Karachi",
  fajr: "05:00",
  dhuhr: "12:30",
  asr: "16:00",
  maghrib: "18:15",
  isha: "19:45",
};

const ALL_PREFS = notifPrefsOf({}); // missing prefs = everything enabled

// Helper: actions for one tick, deterministic 10-min grace.
function actionsAt(row, nowUtc, prefs = ALL_PREFS, logged = new Set(), grace = 10) {
  const plan = buildDayPlan(row);
  return planTickActions(plan, moment.utc(nowUtc), prefs, logged, grace);
}

function find(actions, prayer, type) {
  return actions.find((a) => a.prayer === prayer && a.type === type);
}

test("Asr 16:00 → pre email ONLY in the 15:30–15:40 window (user-local)", () => {
  // 15:35 PKT = 10:35 UTC → due, inside window
  const inWindow = actionsAt(ROW, "2026-10-09T10:35:00Z");
  const pre = find(inWindow, "Asr", "reminder");
  assert.ok(pre, "Asr reminder should be due at 15:35 PKT");
  assert.strictEqual(pre.action, "send");

  // 15:29 PKT → not due yet (no action at all)
  assert.strictEqual(find(actionsAt(ROW, "2026-10-09T10:29:00Z"), "Asr", "reminder"), undefined);

  // 15:45 PKT → window (15:30–15:40) expired → skipped_stale, never sent
  const expired = find(actionsAt(ROW, "2026-10-09T10:45:00Z"), "Asr", "reminder");
  assert.strictEqual(expired.action, "skipped_stale");
  assert.strictEqual(expired.reason, "window-expired");

  // 16:05 PKT → still expired later in the day; no late catch-up email
  const later = find(actionsAt(ROW, "2026-10-09T11:05:00Z"), "Asr", "reminder");
  assert.strictEqual(later.action, "skipped_stale");
});

test("Asr 16:00 → follow-up ONLY in the 16:30–16:40 window; 2 emails total per prayer", () => {
  const due = find(actionsAt(ROW, "2026-10-09T11:35:00Z"), "Asr", "followup"); // 16:35 PKT
  assert.strictEqual(due.action, "send");

  const early = find(actionsAt(ROW, "2026-10-09T11:25:00Z"), "Asr", "followup"); // 16:25 PKT
  assert.strictEqual(early, undefined);

  const stale = find(actionsAt(ROW, "2026-10-09T11:50:00Z"), "Asr", "followup"); // 16:50 PKT
  assert.strictEqual(stale.action, "skipped_stale");

  // Exactly the two windowed instants per day produce a send for Asr.
  // The logged set accumulates each claim, as the real tick's atomic
  // insert-first claim would, so the second tick inside a window is a no-op.
  const sends = [];
  const logged = new Set();
  const asr = buildDayPlan(ROW).find((e) => e.name === "Asr");
  for (let m = 0; m < 24 * 60; m += 5) {
    const now = moment.utc("2026-10-09T00:00:00Z").add(m, "minutes");
    for (const a of planTickActions([asr], now, ALL_PREFS, logged, 10)) {
      if (a.action === "send") {
        sends.push(a.type);
        logged.add(`${a.prayer}|${a.type}`);
      }
    }
  }
  assert.deepStrictEqual(sends.sort(), ["followup", "reminder"]);
});

test("Server down 12:00–14:00, back at 13:00+ for Dhuhr(12:30): stale follow-up skipped, never sent later", () => {
  // First tick after recovery at 14:00 PKT (09:00 UTC).
  const acts = actionsAt(ROW, "2026-10-09T09:00:00Z");
  // Dhuhr follow-up was scheduled 13:00 PKT, window closed 13:10 → skip.
  const fu = find(acts, "Dhuhr", "followup");
  assert.strictEqual(fu.action, "skipped_stale");
  assert.strictEqual(fu.reason, "window-expired");
  // Dhuhr pre-reminder (12:00 PKT, window to 12:10) → also skipped, not sent late.
  assert.strictEqual(find(acts, "Dhuhr", "reminder").action, "skipped_stale");
  // Nothing at all may be sent this tick.
  assert.ok(acts.every((a) => a.action !== "send"));
  // And because skipped_stale rows persist, a later tick with the key logged sends nothing.
  const logged = new Set(["Dhuhr|followup", "Dhuhr|reminder"]);
  const later = actionsAt(ROW, "2026-10-09T09:05:00Z", ALL_PREFS, logged)
    .filter((a) => a.prayer === "Dhuhr");
  assert.deepStrictEqual(later, []);
});

test("Tick at Dhuhr−30 with a never-sent Fajr follow-up → only Dhuhr pre-reminder sent; Fajr follow-up skipped_stale", () => {
  // 12:00 PKT = 07:00 UTC. This is the exact reported bug: the old code fired
  // both the Dhuhr reminder AND the hours-overdue Fajr follow-up together.
  const acts = actionsAt(ROW, "2026-10-09T07:00:00Z");
  const dhuhrPre = find(acts, "Dhuhr", "reminder");
  assert.strictEqual(dhuhrPre.action, "send");
  const fajrFu = find(acts, "Fajr", "followup");
  assert.strictEqual(fajrFu.action, "skipped_stale");
  assert.strictEqual(fajrFu.reason, "window-expired");
  // Exactly one email goes out this tick.
  assert.strictEqual(acts.filter((a) => a.action === "send").length, 1);
});

test("Running the same tick twice → no duplicate email (dedup via logged keys)", () => {
  const now = "2026-10-09T10:35:00Z"; // Asr pre window
  const first = actionsAt(ROW, now);
  assert.strictEqual(first.filter((a) => a.action === "send").length, 1);

  // Simulate the atomic claim from the first run having inserted the row.
  const logged = new Set(first.filter((a) => a.action === "send").map((a) => `${a.prayer}|${a.type}`));
  const second = actionsAt(ROW, now, ALL_PREFS, logged);
  assert.strictEqual(second.filter((a) => a.action === "send").length, 0);
  assert.strictEqual(find(second, "Asr", "reminder"), undefined);
});

test("User timezone independent of server timezone → emails anchored to user-local instants", () => {
  const plan = buildDayPlan(ROW); // Asia/Karachi (UTC+5)
  const asr = plan.find((e) => e.name === "Asr");
  // Asr 16:00 PKT === 11:00 UTC; pre = 10:30 UTC; follow-up = 11:30 UTC.
  assert.strictEqual(asr.at.toISOString(), "2026-10-09T11:00:00.000Z");
  assert.strictEqual(asr.preAt.toISOString(), "2026-10-09T10:30:00.000Z");
  assert.strictEqual(asr.postAt.toISOString(), "2026-10-09T11:30:00.000Z");

  // Same wall-clock day for a US user shifts the UTC instants by the offset.
  const usRow = { ...ROW, timezone: "America/New_York" }; // EDT = UTC−4 in October
  const usAsr = buildDayPlan(usRow).find((e) => e.name === "Asr");
  // Asr 16:00 EDT = 20:00 UTC → pre at 15:30 EDT = 19:30 UTC.
  assert.strictEqual(usAsr.preAt.toISOString(), "2026-10-09T19:30:00.000Z");
  // A tick at 10:35 UTC is due for Karachi but not yet due for New York.
  const kar = planTickActions([asr], moment.utc("2026-10-09T10:35:00Z"), ALL_PREFS, new Set(), 10);
  const ny = planTickActions([usAsr], moment.utc("2026-10-09T10:35:00Z"), ALL_PREFS, new Set(), 10);
  assert.strictEqual(kar[0].action, "send");
  assert.deepStrictEqual(ny, []);

  // Cross-midnight: Fajr 05:00 PKT on local 2026-10-09 is 2026-10-08 in UTC.
  const fajr = plan.find((e) => e.name === "Fajr");
  assert.strictEqual(fajr.preAt.toISOString(), "2026-10-08T23:30:00.000Z");
});

test("Prayer toggle off, or pre/post switch off → no email of that kind", () => {
  const now = "2026-10-09T10:35:00Z"; // Asr pre window open
  const asrOff = notifPrefsOf({ notification_prefs: { prayers: { Asr: false } } });
  const acts = actionsAt(ROW, now, asrOff);
  assert.strictEqual(find(acts, "Asr", "reminder"), undefined);
  assert.strictEqual(find(acts, "Asr", "followup"), undefined);
  // Other prayers are unaffected by the Asr toggle.
  assert.strictEqual(find(acts, "Fajr", "followup").action, "skipped_stale");

  const preOff = notifPrefsOf({ notification_prefs: { pre: false } });
  assert.strictEqual(find(actionsAt(ROW, now, preOff), "Asr", "reminder"), undefined);

  const postOff = notifPrefsOf({ notification_prefs: { post: false } });
  const fuNow = "2026-10-09T11:35:00Z"; // Asr follow-up window open
  assert.strictEqual(find(actionsAt(ROW, fuNow, postOff), "Asr", "followup"), undefined);
  // pre still works when post is off
  assert.strictEqual(find(actionsAt(ROW, now, postOff), "Asr", "reminder").action, "send");
});

test("Missing prefs → everything enabled", () => {
  const prefs = notifPrefsOf({ notification_prefs: null });
  assert.ok(prefs.pre && prefs.post);
  for (const name of ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"]) assert.ok(prefs.enabled(name));
});

test("Two emails due in one tick → later scheduledAt is sent, older marked skipped_stale (one-email cap)", () => {
  // Compressed day where Asr's pre window and Dhuhr's follow-up window overlap:
  // Dhuhr 12:30 (follow-up 13:00–13:10 PKT) and Asr at 13:35 (pre 13:05–13:15).
  const tight = { ...ROW, asr: "13:35" };
  const acts = actionsAt(tight, "2026-10-09T08:07:00Z"); // 13:07 PKT: both due
  const dhuhrFu = find(acts, "Dhuhr", "followup");  // scheduled 13:00
  const asrPre = find(acts, "Asr", "reminder");     // scheduled 13:05
  assert.strictEqual(asrPre.action, "send");        // later scheduledAt wins
  assert.strictEqual(dhuhrFu.action, "skipped_stale");
  assert.strictEqual(dhuhrFu.reason, "tick-cap-older-due");
  assert.strictEqual(acts.filter((a) => a.action === "send").length, 1);
});
