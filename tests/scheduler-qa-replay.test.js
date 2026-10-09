// QA replay harness — proves (or disproves) the stale-email fix by running the
// REAL scheduler.tick() over a full simulated day with a mocked clock, SMTP,
// and database. Nothing here touches prod code; every stub mirrors a documented
// contract of the real module (unique-key claim = ON CONFLICT DO NOTHING, etc).
//
// Fake clock: each 5-minute tick passes nowOverride directly to tick(); the
// "DB" timestamps every row with that same tick instant.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const moment = require("moment-timezone");

// Pin timing config BEFORE the scheduler module reads process.env.
process.env.PRE_REMINDER_MINUTES = "30";
process.env.FOLLOWUP_DELAY_MINUTES = "30";
process.env.MISSED_AFTER_MINUTES = "120";
process.env.SEND_GRACE_MINUTES = "10";

// ---- Module stubs (installed into require.cache before loading scheduler) --
const SERVICES = path.join(__dirname, "..", "src", "services");
let W = null; // current world; stubs close over this

function stub(spec, exports) {
  const p = require.resolve(spec, { paths: [SERVICES] });
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

stub("./email", {
  sendMail: async ({ to, subject, html }) => {
    const w = W;
    // Subjects are now localized; these tests run the user at locale "en"
    // (see the prayerTimes stub below), so we parse the English templates.
    const mReminder = /🕌 (.+?) in about (\d+) minutes/.exec(subject);
    const mFollow = /^Did you (get to )?pray (.+?)\?/.exec(subject);
    let prayer, type;
    if (mReminder) { prayer = mReminder[1]; type = "reminder"; }
    else if (mFollow) { prayer = mFollow[2]; type = "followup"; }
    else if (subject.includes("Suhoor")) { prayer = "Fast"; type = "suhoor"; }
    else if (subject.includes("Iftar")) { prayer = "Fast"; type = "iftar"; }
    else if (subject.includes("Taraweeh")) { prayer = "Taraweeh"; type = "taraweeh"; }
    else if (subject.includes("Ayy")) { prayer = "Ayyam"; type = "sunnah_fast"; }
    else { prayer = "?"; type = "other"; }
    if (w.failRule && w.failRule(prayer, type)) {
      w.emails.push({ at: w.currentTick, prayer, type, result: "smtp-failed" });
      return { success: false, error: "injected SMTP failure" };
    }
    w.emails.push({ at: w.currentTick, to, subject, html, prayer, type, result: "sent" });
    return { success: true, messageId: `msg-${w.emails.length}` };
  },
  reminderEmailHtml: (u, p, t, lead) => `Be ready for ${p} prayer in ${lead} minutes. (${t})`,
  followupEmailHtml: (u, p, d, yes, no) => `yes=${yes} no=${no}`,
  sunnahFastEmailHtml: () => `ayyam`,
  suhoorEmailHtml: () => `suhoor`,
  iftarEmailHtml: () => `iftar`,
  taraweehEmailHtml: () => `taraweeh`,
});

stub("./prayerTimes", {
  getOrFetchTodayTimes: async (user) => (W.rowsByUser && W.rowsByUser[user.id]) || W.row,
  // Force English so the stub's subject regex is deterministic (subject
  // localization is covered by the i18n parity unit test instead).
  resolveLocaleFromCountry: () => "en",
});

stub("../utils/token", { createResponseToken: () => "sIGNEDtok" });
stub("../utils/siteUrl", { siteOrigin: () => "https://example.test" });

stub("../supabase", {
  supabase: {},
  supabaseAdmin: {
    from: () => ({
      select: function () { return this; },
      not: function () { return this; },
      // tick() awaits this chain for user_profiles -> the world's user list.
      then: (resolve) => resolve({ data: W.users || [W.user], error: null }),
    }),
    auth: { admin: { getUserById: async (uid) => ({ data: { user: { email: `qa+${uid}@test.local` } } }) } },
  },
});

const keyOf = (r) => `${r.user_id}|${r.prayer_name}|${r.date}|${r.type}`;

stub("../db", {
  // notifications_log: enforces UNIQUE(user_id, prayer_name, date, type).
  getNotificationLogKeys: async (userId, date) =>
    new Set(W.logRows.filter((r) => r.user_id === userId && r.date === date).map((r) => `${r.prayer_name}|${r.type}`)),
  claimNotificationLog: async (entry) => {
    const w = W;
    const k = keyOf(entry);
    if (w.logKeys.has(k)) return null; // ON CONFLICT DO NOTHING
    const row = { ...entry, id: `log-${++w.seq}`, sent_at: w.currentTick };
    w.logRows.push(row); w.logKeys.add(k);
    return row;
  },
  markNotificationLogSent: async (id) => {
    const row = W.logRows.find((r) => r.id === id);
    if (row) { row.status = "sent"; row.sent_at = W.currentTick; }
  },
  deleteNotificationLog: async (id) => {
    const w = W;
    const i = w.logRows.findIndex((r) => r.id === id && r.status === "sending");
    if (i >= 0) { const k = keyOf(w.logRows[i]); w.logRows.splice(i, 1); w.logKeys.delete(k); }
  },
  // responses: UNIQUE(user_id, prayer_name, date) — insert throws on conflict.
  getResponse: async (u, p, d) => W.responses.get(`${u}|${p}|${d}`) || null,
  createResponse: async (r) => {
    const k = `${r.user_id}|${r.prayer_name}|${r.date}`;
    if (W.responses.has(k)) throw new Error("duplicate key value violates unique constraint");
    const row = { ...r, id: `res-${++W.seq}`, markUpdatedAt: null };
    W.responses.set(k, row);
    return row;
  },
  updateResponse: async (id, updates) => {
    for (const row of W.responses.values()) {
      if (row.id === id) {
        Object.assign(row, updates);
        if (updates.status === "missed") row.markUpdatedAt = W.currentTick;
        return row;
      }
    }
    return null;
  },
  // Heartbeat stub — scheduler.tick() writes a single summary row in its
  // finally block. Tests don't assert on it directly (S20 covers that), but
  // they MUST have the function or the `db.upsertCronHeartbeat is not a
  // function` noise floods stdout every replay.
  upsertCronHeartbeat: async (fields) => {
    W.heartbeats = W.heartbeats || [];
    W.heartbeats.push({ ...fields, at: W.currentTick });
  },
});

const scheduler = require("../src/services/scheduler");

// ---- World / day driver ------------------------------------------------------
const DATE = "2026-10-09";
const TZ = "Asia/Karachi";
const BASE_TIMES = { fajr: "05:00", dhuhr: "12:30", asr: "16:00", maghrib: "18:45", isha: "20:15" };

function makeWorld(opts = {}) {
  const base = {
    user: { id: "u1", name: "QA", city: "Karachi", country: "Pakistan", notification_prefs: opts.prefs ?? null, group_id: null },
    row: { date: opts.date || DATE, timezone: opts.tz || TZ, fetched_at: moment.tz(`${opts.date || DATE} 00:00`, opts.tz || TZ).toISOString(), ...(opts.times || BASE_TIMES), ...(opts.rowExtra || {}) },
    logRows: [], logKeys: new Set(), responses: new Map(), emails: [],
    heartbeats: [],
    currentTick: null, seq: 0,
    failRule: opts.failRule || null,
  };
  // Multi-user worlds (S18 rate cap): opts.users = [{ id, prefs, tz, times, rowExtra }, ...].
  // Each entry becomes its own profile and its own prayer-times row.
  if (opts.users) {
    base.users = opts.users.map((u) => ({
      id: u.id, name: u.id, city: u.city || "Karachi", country: u.country || "Pakistan",
      notification_prefs: u.prefs ?? null, group_id: null,
    }));
    base.rowsByUser = {};
    for (const u of opts.users) {
      const date = u.date || opts.date || DATE;
      const tz = u.tz || opts.tz || TZ;
      base.rowsByUser[u.id] = {
        date, timezone: tz,
        fetched_at: moment.tz(`${date} 00:00`, tz).toISOString(),
        ...(u.times || opts.times || BASE_TIMES),
        ...(u.rowExtra || opts.rowExtra || {}),
      };
    }
    // Back-compat: W.user / W.row still resolve to the first entry so any
    // existing assertion continues to work.
    base.user = base.users[0];
    base.row = base.rowsByUser[base.users[0].id];
  }
  return base;
}

// Replay one day of 5-minute ticks in the user's local timezone.
// down: [[startHH:mm, endHH:mm)] ticks skipped (server offline).
// untilMin: end of the loop (default 24*60). Bump to 25*60+ for a case where
// a follow-up lands after local midnight of the plan's own date (S15).
// env: { KEY: value } overrides applied for the duration of the run (S18/S19).
// seedResponses: [{ user_id, prayer_name, status }] pre-populates W.responses
// so the followup already-logged skip (S17) triggers on the first tick.
async function runDay(opts = {}) {
  W = makeWorld(opts);
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warnings.push(a.join(" ")); };
  const realLog = console.log; if (!opts.verbose) console.log = () => {};
  // Snapshot / restore any env overrides so they don't leak across tests.
  const envKeys = Object.keys(opts.env || {});
  const envBackup = {};
  for (const k of envKeys) { envBackup[k] = process.env[k]; process.env[k] = String(opts.env[k]); }
  // Optional pre-seeded responses (S17 already-logged skip).
  for (const r of (opts.seedResponses || [])) {
    const uid = r.user_id || "u1";
    const key = `${uid}|${r.prayer_name}|${opts.date || DATE}`;
    W.responses.set(key, { id: `seed-${++W.seq}`, user_id: uid, prayer_name: r.prayer_name, date: opts.date || DATE, status: r.status, mark_source: r.mark_source || "manual" });
  }
  const untilMin = opts.untilMin || 24 * 60;
  const anchorDate = opts.date || DATE;
  const anchorTz = opts.tz || TZ;
  try {
    for (let m = 0; m < untilMin; m += 5) {
      const hour = Math.floor(m / 60);
      const minute = m % 60;
      if (opts.down && m >= toMin(opts.down[0]) && m < toMin(opts.down[1])) continue;
      // For hour >= 24 (cross-midnight cases like S15), roll the anchorDate
      // forward by that many days; keeps the wall-clock format valid.
      const dayShift = Math.floor(hour / 24);
      const dateStr = dayShift === 0 ? anchorDate : moment.tz(anchorDate, "YYYY-MM-DD", anchorTz).add(dayShift, "days").format("YYYY-MM-DD");
      const hhmm = `${String(hour % 24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      const tickIso = moment.tz(`${dateStr} ${hhmm}`, "YYYY-MM-DD HH:mm", anchorTz).toISOString();
      W.currentTick = tickIso;
      if (opts.concurrent) await Promise.all([scheduler.tick(tickIso), scheduler.tick(tickIso)]);
      else if (opts.eachTwice) { await scheduler.tick(tickIso); await scheduler.tick(tickIso); }
      else await scheduler.tick(tickIso);
    }
  } finally {
    for (const k of envKeys) { if (envBackup[k] === undefined) delete process.env[k]; else process.env[k] = envBackup[k]; }
    console.warn = realWarn; if (!opts.verbose) console.log = realLog;
  }
  return { w: W, warnings };
}
function toMin(hhmm) { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; }

const local = (iso) => moment.utc(iso).tz(TZ).format("HH:mm");
const sentEmails = (w) => w.emails.filter((e) => e.result === "sent");
const timelineTable = (w) => {
  const rows = [
    ...sentEmails(w).map((e) => ({ time: local(e.at), prayer: e.prayer, type: e.type, outcome: "SENT" })),
    ...w.logRows.filter((r) => r.status === "skipped_stale").map((r) => ({ time: local(r.sent_at), prayer: r.prayer_name, type: r.type, outcome: `skipped_stale (due ${local(r.scheduled_at)})` })),
  ].sort((a, b) => a.time.localeCompare(b.time));
  return rows;
};
function printTable(title, rows) {
  console.log(`\n== ${title} ==`);
  console.log("time(local) | prayer  | type     | outcome");
  for (const r of rows) console.log(`${r.time.padEnd(11)} | ${r.prayer.padEnd(7)} | ${r.type.padEnd(8)} | ${r.outcome}`);
}

function assertPassCriteria(w, expectedSends) {
  const sent = sentEmails(w);
  assert.strictEqual(sent.length, expectedSends, `expected ${expectedSends} emails, got ${sent.length}: ${JSON.stringify(sent.map(e => [local(e.at), e.prayer, e.type]))}`);
  // never two emails to the same user in the same tick
  const perTick = {};
  for (const e of sent) perTick[e.at] = (perTick[e.at] || 0) + 1;
  assert.ok(Object.values(perTick).every((n) => n <= 1), "two emails sent in one tick");
  // no email later than scheduledAt + grace
  for (const r of w.logRows.filter((x) => x.status === "sent")) {
    const late = moment.utc(r.sent_at).diff(moment.utc(r.scheduled_at), "minutes");
    assert.ok(late < 10, `late send ${r.prayer_name}/${r.type}: +${late}min`);
  }
}

// ---- S1 Normal day -----------------------------------------------------------
test("S1 normal day: exactly 10 emails at the right local times", async () => {
  const { w } = await runDay();
  const table = timelineTable(w);
  printTable("S1 timeline", table);
  assertPassCriteria(w, 10);
  const expect = [
    ["04:30", "Fajr", "reminder"], ["05:30", "Fajr", "followup"],
    ["12:00", "Dhuhr", "reminder"], ["13:00", "Dhuhr", "followup"],
    ["15:30", "Asr", "reminder"], ["16:30", "Asr", "followup"],
    ["18:15", "Maghrib", "reminder"], ["19:15", "Maghrib", "followup"],
    ["19:45", "Isha", "reminder"], ["20:45", "Isha", "followup"],
  ];
  const got = sentEmails(w).map((e) => [local(e.at), e.prayer, e.type]);
  assert.deepStrictEqual(got, expect);
  // wording + signed links
  const pre = w.emails.find((e) => e.prayer === "Asr" && e.type === "reminder");
  assert.match(pre.subject, /^🕌 Asr in about 30 minutes$/);
  assert.match(pre.html, /Be ready for Asr prayer in 30 minutes\./);
  const fu = w.emails.find((e) => e.prayer === "Asr" && e.type === "followup");
  // Subject softened to "Did you get to pray ...?" (see i18n en.json).
  assert.strictEqual(fu.subject, "Did you get to pray Asr?");
  assert.match(fu.html, /yes=https:\/\/example\.test\/respond\?token=sIGNEDtok&action=yes/);
  assert.match(fu.html, /no=https:\/\/example\.test\/respond\?token=sIGNEDtok&action=no/);
});

// ---- S2 Server down 05:00–12:20 ----------------------------------------------
test("S2 down 05:00-12:20: NO stale Fajr follow-up at 12:25/12:30; expired emails skipped_stale", async () => {
  const { w } = await runDay({ down: ["05:00", "12:20"] });
  printTable("S2 timeline", timelineTable(w));
  assert.strictEqual(sentEmails(w).some((e) => e.prayer === "Fajr" && e.type === "followup"), false, "Fajr follow-up must never be sent");
  assert.strictEqual(sentEmails(w).some((e) => e.prayer === "Dhuhr" && e.type === "reminder"), false, "Dhuhr pre-reminder window closed at 12:10, must be skipped");
  const skipped = w.logRows.filter((r) => r.status === "skipped_stale").map((r) => `${r.prayer_name}|${r.type}`);
  assert.ok(skipped.includes("Fajr|followup") && skipped.includes("Dhuhr|reminder"), "expected skipped_stale rows: " + skipped);
  assert.strictEqual(sentEmails(w).length, 8); // Fajr reminder + everything from Asr onward
});

// ---- S3 Duplicate (sequential) ticks ----------------------------------------
test("S3 each tick run twice sequentially: zero duplicates, still 10 emails", async () => {
  const { w } = await runDay({ eachTwice: true });
  printTable("S3 timeline", timelineTable(w));
  assertPassCriteria(w, 10);
});

// ---- S4 Two overlapping ticks in parallel ------------------------------------
test("S4 two concurrent ticks (Promise.all): exactly one email per event", async () => {
  const { w } = await runDay({ concurrent: true });
  printTable("S4 timeline", timelineTable(w));
  assertPassCriteria(w, 10);
});

// ---- S5 Timezone ----------------------------------------------------------------
test("S5 user in Asia/Karachi, ticks supplied as UTC instants: fires at user-local times", async () => {
  const { w } = await runDay({ tz: "Asia/Karachi" });
  const got = sentEmails(w).map((e) => [local(e.at), e.prayer]);
  printTable("S5 timeline", timelineTable(w));
  assert.deepStrictEqual(got.map((g) => g[0])[0], "04:30"); // Fajr pre = 04:30 PKT = 23:30Z previous day
  assert.strictEqual(w.emails.length, 10);
  // All scheduled_at instants round-trip to the user's wall clock, e.g. Asr pre:
  const asrPre = w.logRows.find((r) => r.prayer_name === "Asr" && r.type === "reminder");
  assert.strictEqual(moment.utc(asrPre.scheduled_at).tz("Asia/Karachi").format("HH:mm"), "15:30");
});

// ---- S6 Prefs -----------------------------------------------------------------
test("S6 prefs: per-prayer / pre / post toggles suppress correctly; missing = all enabled", async () => {
  let { w } = await runDay({ prefs: { prayers: { Asr: false } } });
  assert.strictEqual(sentEmails(w).some((e) => e.prayer === "Asr"), false);
  assert.strictEqual(sentEmails(w).length, 8);

  ({ w } = await runDay({ prefs: { pre: false } }));
  assert.strictEqual(sentEmails(w).length, 5);
  assert.ok(sentEmails(w).every((e) => e.type === "followup"));

  ({ w } = await runDay({ prefs: { post: false } }));
  assert.strictEqual(sentEmails(w).length, 5);
  assert.ok(sentEmails(w).every((e) => e.type === "reminder"));

  ({ w } = await runDay({ prefs: null })); // missing prefs
  assert.strictEqual(sentEmails(w).length, 10);
});

// ---- S7 Ignored follow-ups auto-mark 'missed' with NO email --------------------
test("S7 user ignores all follow-ups: status=missed, mark_source=auto, correct cutoff, 0 extra emails", async () => {
  const { w } = await runDay();
  assert.strictEqual(sentEmails(w).length, 10); // auto-mark added no emails
  const marks = {};
  for (const [k, r] of w.responses) {
    const prayer = k.split("|")[1];
    marks[prayer] = r;
    assert.strictEqual(r.status, "missed", `${prayer} should be auto-missed`);
    assert.strictEqual(r.mark_source, "auto");
  }
  // cutoff = min(prayer+120, nextPrayer-5), never before followup+10:
  // Fajr: min(07:00, 12:25)=07:00 ; Maghrib: min(20:45, 20:10)=20:10 ; Isha: 22:15
  assert.strictEqual(local(marks.Fajr.markUpdatedAt), "07:00");
  assert.strictEqual(local(marks.Maghrib.markUpdatedAt), "20:10");
  assert.strictEqual(local(marks.Isha.markUpdatedAt), "22:15");
});

// ---- S8 SMTP failure ----------------------------------------------------------
test("S8 SMTP failure: transient → retry inside window; persistent → no sent row, no late email", async () => {
  // (a) fail only the FIRST Asr reminder attempt: 15:30 fails, 15:35 succeeds.
  let failedOnce = false;
  let { w } = await runDay({ failRule: (p, t) => (p === "Asr" && t === "reminder" && !failedOnce ? (failedOnce = true, true) : false) });
  printTable("S8a timeline", timelineTable(w));
  assert.strictEqual(sentEmails(w).length, 10, "retry inside the window must deliver");

  // (b) fail EVERY Asr reminder attempt: window closes, nothing after.
  ({ w } = await runDay({ failRule: (p, t) => p === "Asr" && t === "reminder" }));
  printTable("S8b timeline", timelineTable(w));
  assert.strictEqual(sentEmails(w).filter((e) => e.prayer === "Asr" && e.type === "reminder").length, 0);
  assert.strictEqual(w.logRows.some((r) => r.prayer_name === "Asr" && r.type === "reminder" && r.status === "sent"), false, "no 'sent' row may exist");
  // after the window, a permanent skipped_stale row was written instead
  const stale = w.logRows.find((r) => r.prayer_name === "Asr" && r.type === "reminder" && r.status === "skipped_stale");
  assert.ok(stale, "expected a skipped_stale row for Asr reminder");
  assert.strictEqual(sentEmails(w).length, 9);
});

// ---- S9 Close prayers ---------------------------------------------------------
test("S9 close prayers (40 min and 8 min gaps): ≤1 email/tick, warning for <10-min gap", async () => {
  // (a) Maghrib 18:45 / Isha 19:25 → 40-min gap: no overlap conflict.
  let { w, warnings } = await runDay({ times: { ...BASE_TIMES, isha: "19:25" } });
  printTable("S9a timeline", timelineTable(w));
  assertPassCriteria(w, 10);
  // (b) 8-min gap (extreme latitude) → close-prayer warning + still ≤1/tick.
  ({ w, warnings } = await runDay({ times: { ...BASE_TIMES, maghrib: "18:45", isha: "18:53" } }));
  printTable("S9b timeline", timelineTable(w));
  assert.ok(warnings.some((x) => x.includes("close-prayer-times")), "expected close-prayer-times warning");
  const perTick = {};
  for (const e of sentEmails(w)) perTick[e.at] = (perTick[e.at] || 0) + 1;
  assert.ok(Object.values(perTick).every((n) => n <= 1), "two emails in one tick");
  // Isha pre is clamped to Maghrib+1 and its follow-up lands close to Maghrib's:
  // every skipped row must carry a valid skip reason.
  const skipped = w.logRows.filter((r) => r.status === "skipped_stale");
  for (const r of skipped) assert.ok(["window-expired", "tick-cap-older-due"].includes(r.reason) || r.reason === undefined, `bad skip reason on ${r.prayer_name}/${r.type}`);
});

// ---- S10 The original bug -----------------------------------------------------
test("S10 REGRESSION: first tick at Dhuhr−30 with unsent Fajr follow-up → ONLY Dhuhr pre-reminder", async () => {
  // Simulate everything before 12:00 being offline: Fajr follow-up was NEVER sent.
  const { w } = await runDay({ down: ["00:00", "12:00"] });
  printTable("S10 timeline (first ticks)", timelineTable(w).slice(0, 6));
  const at1200 = sentEmails(w).filter((e) => e.at === moment.tz(`${DATE} 12:00`, "YYYY-MM-DD HH:mm", TZ).toISOString());
  assert.strictEqual(at1200.length, 1, "exactly one email at 12:00");
  assert.strictEqual(at1200[0].prayer, "Dhuhr");
  assert.strictEqual(at1200[0].type, "reminder");
  const fajrFu = w.logRows.find((r) => r.prayer_name === "Fajr" && r.type === "followup");
  assert.ok(fajrFu && fajrFu.status === "skipped_stale", "Fajr follow-up must be skipped_stale, never sent");
  assert.strictEqual(sentEmails(w).some((e) => e.prayer === "Fajr" && e.type === "followup"), false);
});

// ---- Step 3: DB invariant checks over the replayed rows (S1 day) --------------
test("DB checks on replayed notifications_log: no dupes, no late sends, ≤10/day, auto-miss has no email", async () => {
  const { w } = await runDay();
  const rows = w.logRows; // simulate: SELECT ... FROM notifications_log

  // Q1 duplicates: GROUP BY (user, prayer, date, type) HAVING COUNT(*) > 1 → 0 rows
  const counts = {};
  for (const r of rows) counts[keyOf(r)] = (counts[keyOf(r)] || 0) + 1;
  const dupes = Object.entries(counts).filter(([, n]) => n > 1);
  assert.deepStrictEqual(dupes, []);

  // Q2 late sends: sent_at > scheduled_at + 10 min → 0 rows
  const late = rows.filter((r) => r.status === "sent" && moment.utc(r.sent_at).diff(moment.utc(r.scheduled_at), "minutes") >= 10);
  assert.deepStrictEqual(late, []);

  // Q3 same-tick doubles: >1 'sent' row per user in one 5-min bucket → 0
  const buckets = {};
  for (const r of rows.filter((x) => x.status === "sent")) {
    const b = moment.utc(r.sent_at).startOf("hour").add(Math.floor(moment.utc(r.sent_at).minute() / 5) * 5, "minutes").toISOString();
    buckets[b] = (buckets[b] || 0) + 1;
  }
  assert.ok(Object.values(buckets).every((n) => n <= 1), JSON.stringify(buckets));

  // Q4 daily count per user ≤ 10 'sent'
  assert.ok(rows.filter((r) => r.status === "sent").length <= 10);

  // Q5 auto-missed responses produced no email rows: every prayer has ≤2 rows
  for (const p of ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"]) {
    assert.ok(rows.filter((r) => r.prayer_name === p).length <= 2, `${p} has >2 log rows`);
  }
  console.log(`\n== Step3 DB checks (over ${rows.length} replayed rows) ==`);
  console.log(`duplicates=0, late-sends=0, same-tick-doubles=0, sent-today=${rows.filter((r) => r.status === "sent").length}, skipped_stale=${rows.filter((r) => r.status === "skipped_stale").length}`);
});

// ---- S11 Ramadan mode (opt-in) ------------------------------------------------
test("S11 Ramadan day: suhoor/iftar/taraweeh emails + a Fast pending row, Ayyam suppressed, ≤1 per group per tick", async () => {
  const { w } = await runDay({
    prefs: { ramadan: { enabled: true } },
    rowExtra: { hijri_month_num: 9, hijri_day: 15, hijri_month: "Ramadan", imsak: "04:50", sunrise: "06:10" },
  });
  printTable("S11 timeline", timelineTable(w));
  const types = sentEmails(w).map((e) => e.type);
  for (const t of ["suhoor", "iftar", "taraweeh"]) assert.ok(types.includes(t), `expected a ${t} email`);
  assert.ok(!types.includes("sunnah_fast"), "Ayyam must be suppressed inside Ramadan");
  // 10 daily + 3 seasonal = 13.
  assert.strictEqual(sentEmails(w).length, 13, JSON.stringify(sentEmails(w).map((e) => [local(e.at), e.type])));
  // Two independent per-tick caps: at most one daily AND at most one special.
  const daily = {}, special = {};
  for (const e of sentEmails(w)) {
    const bag = ["reminder", "followup"].includes(e.type) ? daily : special;
    bag[e.at] = (bag[e.at] || 0) + 1;
  }
  assert.ok(Object.values(daily).every((n) => n <= 1), "two daily emails in one tick");
  assert.ok(Object.values(special).every((n) => n <= 1), "two special emails in one tick");
  // A Fast response row is created for the day and NEVER auto-marked missed.
  const fast = [...w.responses.values()].find((r) => r.prayer_name === "Fast");
  assert.ok(fast, "expected a Fast tracker row");
  assert.notStrictEqual(fast.status, "missed", "a fast must never be auto-marked missed");
});

// ---- S12 Ayyam al-Biḍʿ (opt-in, non-Ramadan) ---------------------------------
test("S12 Ayyam day: exactly one sunnah_fast email, no Ramadan trio, 11 total", async () => {
  const { w } = await runDay({
    prefs: { sunnahFast: true },
    rowExtra: { hijri_month_num: 6, hijri_day: 14, hijri_month: "Dhu al-Qi'dah", imsak: "04:50" },
  });
  printTable("S12 timeline", timelineTable(w));
  const types = sentEmails(w).map((e) => e.type);
  assert.strictEqual(types.filter((t) => t === "sunnah_fast").length, 1);
  assert.ok(!types.includes("suhoor") && !types.includes("taraweeh") && !types.includes("iftar"), "Ramadan trio must not fire outside Ramadan");
  assert.strictEqual(sentEmails(w).length, 11); // 10 daily + 1 Ayyam
});

// ---- S13 seasonal features default OFF without opt-in -------------------------
test("S13 Ramadan calendar but NOT opted in → no seasonal emails, still 10", async () => {
  const { w } = await runDay({
    prefs: { prayers: {} }, // established prefs, but no ramadan/sunnahFast opt-in
    rowExtra: { hijri_month_num: 9, hijri_day: 15, hijri_month: "Ramadan", imsak: "04:50" },
  });
  const types = sentEmails(w).map((e) => e.type);
  assert.ok(!types.includes("suhoor") && !types.includes("iftar") && !types.includes("taraweeh"), "no seasonal email without opt-in");
  assert.strictEqual(sentEmails(w).length, 10);
});

// ---- S14 DST spring-forward (Europe/London 2026-03-29) ------------------------
// Clocks jump 01:00 GMT → 02:00 BST. Every prayer time in this test day is on
// the BST side of the shift, so buildDayPlan must anchor them to absolute UTC
// instants that are exactly 30 min away from the prayer — not to a wall-clock
// arithmetic that would silently drop an hour.
test("S14 DST spring-forward London 2026-03-29: pre/post instants are exactly ±30 min of the prayer in UTC", async () => {
  const LON_TIMES = { fajr: "05:00", dhuhr: "12:00", asr: "15:00", maghrib: "18:30", isha: "20:00" };
  const { w } = await runDay({ date: "2026-03-29", tz: "Europe/London", times: LON_TIMES });
  // BST is UTC+1 on 2026-03-29 → prayer instants in UTC are 1 h behind wall clock.
  const asrReminder = w.logRows.find((r) => r.prayer_name === "Asr" && r.type === "reminder");
  const asrFollowup = w.logRows.find((r) => r.prayer_name === "Asr" && r.type === "followup");
  assert.strictEqual(asrReminder.scheduled_at, "2026-03-29T13:30:00.000Z"); // 14:30 BST
  assert.strictEqual(asrFollowup.scheduled_at, "2026-03-29T14:30:00.000Z"); // 15:30 BST
  // Fajr sits on the GMT→BST boundary morning: 05:00 BST = 04:00 UTC.
  const fajrReminder = w.logRows.find((r) => r.prayer_name === "Fajr" && r.type === "reminder");
  assert.strictEqual(fajrReminder.scheduled_at, "2026-03-29T03:30:00.000Z"); // 04:30 BST
  // Every prayer got both emails; DST shift did not cause a duplicate/skip.
  assert.strictEqual(sentEmails(w).length, 10);
  const sentKeys = new Set(sentEmails(w).map((e) => `${e.prayer}|${e.type}`));
  for (const p of ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"]) {
    assert.ok(sentKeys.has(`${p}|reminder`) && sentKeys.has(`${p}|followup`), `${p} missing on DST day`);
  }
});

// ---- S15 Midnight-crossing Isha (Auckland NZDT) -------------------------------
// Auckland summer: Isha 23:45 NZDT → follow-up at 00:15 next civil day. The
// plan is anchored to the prayer's own civil date (2026-01-15) so the
// notifications_log row must still carry date=2026-01-15 even though the email
// is delivered after local midnight.
test("S15 midnight-crossing Isha follow-up: still one email, dated to the plan's civil day", async () => {
  const AKL_TIMES = { fajr: "05:30", dhuhr: "13:15", asr: "17:00", maghrib: "20:30", isha: "23:45" };
  const { w } = await runDay({
    date: "2026-01-15", tz: "Pacific/Auckland", times: AKL_TIMES,
    untilMin: 26 * 60, // iterate past local midnight so the 00:15 tick actually happens
  });
  const ishaFollow = w.logRows.find((r) => r.prayer_name === "Isha" && r.type === "followup");
  assert.ok(ishaFollow, "Isha follow-up must have a notifications_log row");
  assert.strictEqual(ishaFollow.status, "sent");
  // scheduled_at is exactly 30 min after Isha 23:45 NZDT. NZDT = UTC+13 in Jan,
  // so Isha = 2026-01-15T10:45:00Z → postAt = 2026-01-15T11:15:00Z (= 00:15
  // local on the 16th, still dated to the plan's civil day 2026-01-15).
  assert.strictEqual(ishaFollow.scheduled_at, "2026-01-15T11:15:00.000Z");
  // The email is delivered on the tick that hits 00:15 local (well inside the
  // 10-minute window) — never duplicated.
  const ishaFollowEmails = sentEmails(w).filter((e) => e.prayer === "Isha" && e.type === "followup");
  assert.strictEqual(ishaFollowEmails.length, 1, "Isha follow-up must fire exactly once, even crossing local midnight");
});

// ---- S16 Missing prayer time (high latitude / Aladhan null) -------------------
// When the API returns null for one prayer (extreme-latitude days do this),
// buildDayPlan filters it out; the day must produce 8 emails, not 10, and must
// NOT leave a stale placeholder row for the missing prayer.
test("S16 Isha=null: 8 emails go out, no isha row (sent or skipped_stale) in notifications_log", async () => {
  const { w } = await runDay({ times: { ...BASE_TIMES, isha: null } });
  assert.strictEqual(sentEmails(w).length, 8, JSON.stringify(sentEmails(w).map((e) => [local(e.at), e.prayer, e.type])));
  assert.strictEqual(w.logRows.filter((r) => r.prayer_name === "Isha").length, 0, "missing prayer must not appear in notifications_log at all");
  // The other 4 prayers still fire normally on their own anchors.
  for (const p of ["Fajr", "Dhuhr", "Asr", "Maghrib"]) {
    assert.ok(sentEmails(w).some((e) => e.prayer === p && e.type === "reminder"), `${p} reminder missing`);
    assert.ok(sentEmails(w).some((e) => e.prayer === p && e.type === "followup"), `${p} follow-up missing`);
  }
});

// ---- S17 Already-logged skip ---------------------------------------------------
// Plan Section D: a follow-up for a prayer the user already marked done must
// not go out. The tick writes a permanent skipped_stale row and logs a
// structured SKIP-EMAIL line with reason=already-logged.
test("S17 Asr marked done at 15:00 → Asr follow-up at 16:30 becomes skipped_stale(already-logged), no email", async () => {
  const { w, warnings } = await runDay({
    seedResponses: [{ prayer_name: "Asr", status: "done" }],
  });
  // No Asr follow-up email was sent.
  assert.strictEqual(sentEmails(w).some((e) => e.prayer === "Asr" && e.type === "followup"), false, "Asr follow-up must not be sent");
  // The claim exists as skipped_stale so no later tick can resurrect it.
  const asrFu = w.logRows.find((r) => r.prayer_name === "Asr" && r.type === "followup");
  assert.ok(asrFu && asrFu.status === "skipped_stale", "Asr follow-up row must be skipped_stale");
  // Structured log line carries the new reason.
  assert.ok(warnings.some((x) => /SKIP-EMAIL user=u1 prayer=Asr type=followup .* reason=already-logged/.test(x)),
    `expected already-logged SKIP-EMAIL warning, got: ${warnings.filter(x => x.includes('Asr')).join(' | ')}`);
  // Every other email still fires: 10 minus 1 Asr follow-up = 9 sent.
  assert.strictEqual(sentEmails(w).length, 9);
  // Asr reminder (pre) still sends because it doesn't gate on responses.
  assert.ok(sentEmails(w).some((e) => e.prayer === "Asr" && e.type === "reminder"));
});

// ---- S18 Per-tick rate cap -----------------------------------------------------
// MAX_EMAILS_PER_TICK=1 across 2 users with the same prayer times: the tick
// must never emit more than one real sendMail, but every user still gets
// their full daily set inside the widened 10-min grace window (the second
// user's slot simply slides to the next tick).
test("S18 rate cap 1/tick × 2 users: ≤1 email per tick, both users still get 10 each", async () => {
  const { w } = await runDay({
    env: { MAX_EMAILS_PER_TICK: "1" },
    users: [
      { id: "u1", prefs: null },
      { id: "u2", prefs: null },
    ],
  });
  const perTick = {};
  for (const e of sentEmails(w)) perTick[e.at] = (perTick[e.at] || 0) + 1;
  assert.ok(Object.values(perTick).every((n) => n <= 1), `rate cap breached: ${JSON.stringify(perTick)}`);
  // Both users still got 10 emails (no missed slots because the widened
  // grace covers the 5-min delay).
  const u1Sent = w.logRows.filter((r) => r.user_id === "u1" && r.status === "sent").length;
  const u2Sent = w.logRows.filter((r) => r.user_id === "u2" && r.status === "sent").length;
  assert.strictEqual(u1Sent, 10, `u1 got ${u1Sent}/10`);
  assert.strictEqual(u2Sent, 10, `u2 got ${u2Sent}/10`);
});

// ---- S19 Dry-run mode ----------------------------------------------------------
// SCHEDULER_DRY_RUN=1 exercises the claim+log pipeline without ever calling
// SMTP. sendMail stub is untouched; log rows still flip to 'sent' so the
// dedup and auto-mark logic sees the same state as a live send. The heartbeat
// row must carry dry_run: true so /api/health exposes the mode to ops.
test("S19 dry-run: 0 sendMail calls, 10 notifications_log rows marked 'sent', heartbeat.dry_run=true", async () => {
  const { w } = await runDay({ env: { SCHEDULER_DRY_RUN: "1" } });
  assert.strictEqual(w.emails.length, 0, "no email must reach the sendMail stub in dry-run mode");
  const sent = w.logRows.filter((r) => r.status === "sent");
  assert.strictEqual(sent.length, 10, "dry-run must still mark all 10 rows sent for dedup");
  assert.ok(w.heartbeats.length > 0, "heartbeat rows must still be written");
  const last = w.heartbeats[w.heartbeats.length - 1];
  assert.strictEqual(last.dry_run, true, "heartbeat.dry_run flag must be true");
});

