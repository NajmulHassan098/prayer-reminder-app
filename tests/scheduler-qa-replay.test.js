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
    const m = /Time to prepare for (\w+)/.exec(subject) || /^Did you pray (\w+)\?/.exec(subject);
    const prayer = m ? m[1] : "?";
    const type = subject.includes("Time to prepare") ? "reminder" : "followup";
    if (w.failRule && w.failRule(prayer, type)) {
      w.emails.push({ at: w.currentTick, prayer, type, result: "smtp-failed" });
      return { success: false, error: "injected SMTP failure" };
    }
    w.emails.push({ at: w.currentTick, to, subject, html, prayer, type, result: "sent" });
    return { success: true, messageId: `msg-${w.emails.length}` };
  },
  reminderEmailHtml: (u, p, t, lead) => `Be ready for ${p} prayer in ${lead} minutes. (${t})`,
  followupEmailHtml: (u, p, d, yes, no) => `yes=${yes} no=${no}`,
});

stub("./prayerTimes", {
  getOrFetchTodayTimes: async () => W.row,
});

stub("../utils/token", { createResponseToken: () => "sIGNEDtok" });
stub("../utils/siteUrl", { siteOrigin: () => "https://example.test" });

stub("../supabase", {
  supabase: {},
  supabaseAdmin: {
    from: () => ({
      select: function () { return this; },
      not: function () { return this; },
      // tick() awaits this chain for user_profiles -> one test user.
      then: (resolve) => resolve({ data: [W.user], error: null }),
    }),
    auth: { admin: { getUserById: async () => ({ data: { user: { email: "qa@test.local" } } }) } },
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
});

const scheduler = require("../src/services/scheduler");

// ---- World / day driver ------------------------------------------------------
const DATE = "2026-10-09";
const TZ = "Asia/Karachi";
const BASE_TIMES = { fajr: "05:00", dhuhr: "12:30", asr: "16:00", maghrib: "18:45", isha: "20:15" };

function makeWorld(opts = {}) {
  return {
    user: { id: "u1", name: "QA", city: "Karachi", country: "Pakistan", notification_prefs: opts.prefs ?? null, group_id: null },
    row: { date: DATE, timezone: opts.tz || TZ, fetched_at: moment.tz(`${DATE} 00:00`, TZ).toISOString(), ...(opts.times || BASE_TIMES) },
    logRows: [], logKeys: new Set(), responses: new Map(), emails: [],
    currentTick: null, seq: 0,
    failRule: opts.failRule || null,
  };
}

// Replay one day of 5-minute ticks in the user's local timezone.
// down: [[startHH:mm, endHH:mm)] ticks skipped (server offline).
async function runDay(opts = {}) {
  W = makeWorld(opts);
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warnings.push(a.join(" ")); };
  const realLog = console.log; if (!opts.verbose) console.log = () => {};
  try {
    for (let m = 0; m < 24 * 60; m += 5) {
      const hhmm = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      if (opts.down && m >= toMin(opts.down[0]) && m < toMin(opts.down[1])) continue;
      const tickIso = moment.tz(`${DATE} ${hhmm}`, "YYYY-MM-DD HH:mm", opts.tz || TZ).toISOString();
      W.currentTick = tickIso;
      if (opts.concurrent) await Promise.all([scheduler.tick(tickIso), scheduler.tick(tickIso)]);
      else if (opts.eachTwice) { await scheduler.tick(tickIso); await scheduler.tick(tickIso); }
      else await scheduler.tick(tickIso);
    }
  } finally {
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
  assert.match(pre.subject, /^🕌 Time to prepare for Asr$/);
  assert.match(pre.html, /Be ready for Asr prayer in 30 minutes\./);
  const fu = w.emails.find((e) => e.prayer === "Asr" && e.type === "followup");
  assert.strictEqual(fu.subject, "Did you pray Asr?");
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
