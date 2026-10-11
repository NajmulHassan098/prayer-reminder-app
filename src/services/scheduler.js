const moment = require("moment-timezone");
const db = require("../db");
// Service-role client: the scheduler runs outside any user session, so it must
// bypass RLS to read all user profiles and look up each user's auth email.
const { supabaseAdmin: supabase } = require("../supabase");
const { getOrFetchTodayTimes } = require("./prayerTimes");
const { sendMail, reminderEmailHtml, followupEmailHtml, sunnahFastEmailHtml, suhoorEmailHtml, iftarEmailHtml, taraweehEmailHtml } = require("./email");
const { t, resolveLocale } = require("../utils/i18n");
const { resolveLocaleFromCountry } = require("./prayerTimes");
const { createResponseToken } = require("../utils/token");
const { siteOrigin } = require("../utils/siteUrl");

const PRAYERS = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];

// ---- Timing configuration --------------------------------------------------
// Every value is derived from each prayer's ACTUAL time for that day/location
// (never a fixed global interval), so the Asr→Maghrib gap etc. are respected.
// "Before prayer" reminder lead (minutes). Default 30 per product spec.
const PRE_REMINDER_MIN = Number(process.env.PRE_REMINDER_MINUTES || 30);
// "Did you pray?" follow-up delay after the prayer time. Default 30 per spec.
const FOLLOWUP_DELAY_MIN = Number(process.env.FOLLOWUP_DELAY_MINUTES || 30);
// Fixed upper bound for how long to wait for a response before auto-marking
// "Not Prayed". Default 120 (2 hours) per spec.
const MISSED_AFTER_MIN = Number(process.env.MISSED_AFTER_MINUTES || 120);
// Send window for every email: an email is sendable only while
//   scheduledAt <= now < scheduledAt + SEND_GRACE_MIN
// A email whose window has closed is logged 'skipped_stale' and NEVER sent —
// a late tick (restart, downtime, SMTP failure) must not cause catch-up or
// duplicate emails stacking on top of the next prayer's reminders.
//
// 10 minutes per product spec: with a reliable ~1-minute trigger, a reminder
// that is more than 10 min late is no longer useful (the prayer is over or the
// next one is starting) and is dropped rather than caught up.
const SEND_GRACE_MIN = Number(process.env.SEND_GRACE_MINUTES || 10);
// Minimum spacing between ANY two emails to the same user. Two adjacent
// events closer than this (e.g. post(Asr) and pre(Maghrib) when the prayers are
// ~60 min apart) are collapsed at plan time so the user never receives two
// emails back-to-back; the loser is written as 'skipped_superseded'.
const MIN_USER_GAP_MIN = Number(process.env.MIN_EMAIL_GAP_MINUTES || 10);
// Hard per-tick cap on real emails. Protects SMTP rate limits on shared relays
// and lets a large user-base catch up across multiple ticks instead of one.
// Anything past the cap has its claim released so the next tick picks it up
// inside the widened grace window. 0 disables the cap.
const MAX_EMAILS_PER_TICK = Number(process.env.MAX_EMAILS_PER_TICK || 50);
// Keep clear of the next prayer: a follow-up / auto-mark is nudged to finish at
// least this many minutes before the next prayer begins, so two prayers' events
// never stack on top of each other.
const NEXT_PRAYER_BUFFER_MIN = Number(process.env.NEXT_PRAYER_BUFFER_MINUTES || 5);
// Guarantee the user always has at least this long between the follow-up and the
// auto-mark, even when consecutive prayers are unusually close.
const MIN_RESPONSE_WINDOW_MIN = Number(process.env.MIN_RESPONSE_WINDOW_MINUTES || 10);
// If two consecutive prayer times are closer than this, log a warning — it is
// either an extreme-latitude day or bad data, and it is the situation where
// reminders would otherwise appear to "fire together".
const MIN_PRAYER_GAP_WARN_MIN = Number(process.env.MIN_PRAYER_GAP_WARN_MINUTES || 10);
// A freshly fetched day's plan is logged once, for a short window after fetch.
const PLAN_LOG_FRESH_MIN = 6;
// ---- Seasonal (opt-in) email anchors --------------------------------------
// All default-OFF features; nothing here fires unless the user's prefs say so.
// Suhoor email: this many minutes before Imsak (fallback: Fajr).
const SUHOOR_LEAD_MIN = Number(process.env.SUHOOR_REMINDER_MINUTES || 45);
// Iftar email: minutes before Maghrib (the meal begins AT maghrib).
const IFTAR_PREP_MIN = Number(process.env.IFTAR_PREP_MINUTES || 20);
// Taraweeh email: minutes after Isha — deliberately clear of the Isha
// follow-up window (delay + grace) so the two never compete.
const TARAWEEH_DELAY_MIN = Number(process.env.TARAWEEH_DELAY_MINUTES || 45);
// Ayyam al-Biḍʿ email: local hour (09:00) — clear of every prayer window.
const AYYAM_HOUR = Number(process.env.AYYAM_REMINDER_HOUR || 9);

/**
 * Interpret a user's stored notification_prefs. A missing/NULL value means
 * "everything enabled" so existing users keep receiving all emails until they
 * actively opt out. Each prayer toggle gates BOTH its pre-reminder and its
 * follow-up; `pre`/`post` are global switches for the two email types.
 *
 * Per-user offsets (preMinutes / postMinutes) let someone pick 15 or 45 while
 * the global default stays 30. Invalid values (non-numeric, out of 5–120)
 * silently fall back to the global default so a corrupt blob never produces a
 * reminder in the wrong slot.
 */
function clampOffset(v, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  if (n < 5 || n > 120) return dflt;
  return Math.round(n);
}

function notifPrefsOf(user) {
  const p = user.notification_prefs || {};
  const prayers = p.prayers || {};
  // CONSENT RULE: unlike the original five-prayer prefs (missing = enabled,
  // because that was historical behavior), every NEW email feature must be
  // explicitly opted in: missing prefs mean OFF.
  const ram = p.ramadan || {};
  const ramadanEnabled = ram.enabled === true;
  return {
    pre: p.pre !== false,
    post: p.post !== false,
    preMinutes: clampOffset(p.preMinutes, PRE_REMINDER_MIN),
    postMinutes: clampOffset(p.postMinutes, FOLLOWUP_DELAY_MIN),
    enabled: (name) => prayers[name] !== false,
    // Ayyam al-Biḍʿ monthly sunnah-fast nudge.
    sunnahFast: p.sunnahFast === true,
    ramadanEnabled,
    ramadanSub: (k) => ramadanEnabled && ram[k] !== false,
  };
}

async function upsertPendingResponse(userId, groupId, prayerName, date, extra) {
  try {
    const existing = await db.getResponse(userId, prayerName, date);
    if (!existing) {
      await db.createResponse({
        user_id: userId,
        group_id: groupId,
        prayer_name: prayerName,
        date: date,
        status: 'pending',
        ...(extra || {})
      });
      return true; // created
    }
    return false;
  } catch (error) {
    console.error(`[scheduler] Error upserting response:`, error);
    return false;
  }
}

/**
 * Build the full reminder plan for one user's day from the day's ACTUAL prayer
 * times. This is the single source of truth for scheduling: each prayer gets an
 * independent pre-reminder target (T-PRE) and follow-up target (T+POST), plus an
 * auto-mark cutoff. The targets are clamped so they respect the real gaps:
 *   - a pre-reminder never fires before the previous prayer has begun;
 *   - a follow-up / auto-mark is pulled in to finish before the next prayer,
 *     while still leaving the user a minimum response window.
 * Returns an array (chronological) of:
 *   { name, timeStr, at, preAt, postAt, cutoff }  (all moment objects in the
 *   user's own timezone; compare instants directly).
 *
 * `prefs` is optional and only used to read preMinutes/postMinutes. When absent
 * (or when it comes from a user whose blob predates the per-user offsets) the
 * global defaults PRE_REMINDER_MIN / FOLLOWUP_DELAY_MIN apply, so a caller
 * passing only a row keeps working unchanged.
 */
function buildDayPlan(row, prefs) {
  const tz = row.timezone;
  const preMin = (prefs && Number.isFinite(prefs.preMinutes)) ? prefs.preMinutes : PRE_REMINDER_MIN;
  const postMin = (prefs && Number.isFinite(prefs.postMinutes)) ? prefs.postMinutes : FOLLOWUP_DELAY_MIN;
  const points = PRAYERS.map((name) => {
    const t = row[name.toLowerCase()];
    if (!t) return null;
    const at = moment.tz(`${row.date} ${t}`, "YYYY-MM-DD HH:mm", tz);
    return at.isValid() ? { name, timeStr: t, at } : null;
  }).filter(Boolean);

  return points.map((p, i) => {
    const prev = points[i - 1];
    const next = points[i + 1];

    // Pre-reminder: preMin minutes before the prayer, but never before the
    // previous prayer's own time (+1 min) so consecutive reminders can't pile
    // up. Users who pick a big lead (60+) get clamped to the previous prayer.
    let preAt = p.at.clone().subtract(preMin, "minutes");
    if (prev) {
      const floor = prev.at.clone().add(1, "minutes");
      if (preAt.isBefore(floor)) preAt = floor;
    }

    // Follow-up: postMin minutes after the prayer.
    const postAt = p.at.clone().add(postMin, "minutes");

    // Auto-mark cutoff: the earlier of the fixed cap and (next prayer - buffer),
    // but never sooner than the follow-up + a minimum response window.
    const byFixed = p.at.clone().add(MISSED_AFTER_MIN, "minutes");
    const byNext = next ? next.at.clone().subtract(NEXT_PRAYER_BUFFER_MIN, "minutes") : null;
    let cutoff = byNext && byNext.isBefore(byFixed) ? byNext : byFixed;
    const minCutoff = postAt.clone().add(MIN_RESPONSE_WINDOW_MIN, "minutes");
    if (cutoff.isBefore(minCutoff)) cutoff = minCutoff;

    return { name: p.name, timeStr: p.timeStr, at: p.at, preAt, postAt, cutoff };
  });
}

// Machine keys used as prayer_name in notifications_log / responses for the
// seasonal emails. They are TEXT columns, so new types need no schema change —
// the unique key + send window + atomic claim protect them for free.
const SPECIAL_KEYS = { ayyam: "Ayyam", suhoor: "Fast", iftar: "Fast", taraweeh: "Taraweeh" };

/**
 * Build the day's OPT-IN seasonal email candidates from the cached row.
 * Everything is gated on the Hijri fields stored by migration 0003; rows
 * without them (pre-migration cache) simply produce no specials.
 * Returns [{ key, prayer, type, at (Moment), group:'special' }].
 */
function buildSpecialEvents(row, prefs) {
  const out = [];
  const tz = row.timezone;
  if (!tz) return out;

  const hDay = Number(row.hijri_day);
  const hMonth = Number(row.hijri_month_num);

  // Ayyam al-Biḍʿ: 13/14/15 of any lunar month. Suppressed inside Ramadan —
  // the Ramadan fast already covers it, and we don't stack nudges.
  if (prefs.sunnahFast && hDay >= 13 && hDay <= 15 && hMonth !== 9) {
    const at = moment.tz(`${row.date} ${String(AYYAM_HOUR).padStart(2, "0")}:00`, "YYYY-MM-DD HH:mm", tz);
    if (at.isValid()) out.push({ key: "ayyam", prayer: SPECIAL_KEYS.ayyam, type: "sunnah_fast", at });
  }

  // Ramadan trio — only when the user opted in AND the day is actually in
  // the user's own city's Hijri calendar (±1 day regional differences are
  // automatically consistent per user because each row is fetched locally).
  if (prefs.ramadanEnabled && hMonth === 9) {
    const imsakRef = row.imsak && row.imsak !== "00:00" ? row.imsak : row.fajr;
    if (prefs.ramadanSub("suhoor") && imsakRef) {
      let at = moment.tz(`${row.date} ${imsakRef}`, "YYYY-MM-DD HH:mm", tz).subtract(SUHOOR_LEAD_MIN, "minutes");
      // Never before dawn-ish sanity line: if Imsak is missing and the Fajr
      // lead lands inside the Fajr pre-reminder window, the group cap decides.
      if (at.isValid()) out.push({ key: "suhoor", prayer: SPECIAL_KEYS.suhoor, type: "suhoor", at });
    }
    if (prefs.ramadanSub("iftar") && row.maghrib) {
      const at = moment.tz(`${row.date} ${row.maghrib}`, "YYYY-MM-DD HH:mm", tz).subtract(IFTAR_PREP_MIN, "minutes");
      if (at.isValid()) out.push({ key: "iftar", prayer: SPECIAL_KEYS.iftar, type: "iftar", at });
    }
    if (prefs.ramadanSub("taraweeh") && row.isha) {
      const at = moment.tz(`${row.date} ${row.isha}`, "YYYY-MM-DD HH:mm", tz).add(TARAWEEH_DELAY_MIN, "minutes");
      if (at.isValid()) out.push({ key: "taraweeh", prayer: SPECIAL_KEYS.taraweeh, type: "taraweeh", at });
    }
  }
  return out;
}

/**
 * Pure decision function: for one user's day plan, decide the exact email
 * actions for THIS tick. No I/O — the tick executes whatever this returns.
 *
 * Daily (five-prayer) rules — this is the anti-"two arrive together" core:
 *   - prefs must allow the prayer AND the type;
 *   - a handled key (sent | skipped_stale | skipped_superseded |
 *     skipped_already_logged | fresh 'sending') → no action. A 'failed' or
 *     abandoned row is NOT passed in loggedSet, so it re-enters as retryable;
 *   - MINIMUM-GAP collapse: two daily emails within MIN_USER_GAP (10 min) of
 *     each other are resolved once, deterministically, at plan time — the
 *     follow-up loses to a neighbouring pre-reminder, else the earlier loses.
 *     The loser is 'skipped_superseded' (permanent), so post(N) never lands on
 *     top of pre(N+1) no matter how ticks are timed.
 *   - a kept event that is overdue → 'skipped_stale' (window-expired, or
 *     prayer-time-passed when a pre-reminder's window would run past the
 *     prayer itself — a pre is never sent after T);
 *   - at most ONE daily email per tick: newest still-fresh due wins ('send'),
 *     any other kept-due is 'skipped_superseded' (tick-cap).
 * Seasonal (special) emails keep their own independent single-per-tick cap so
 * this fix never changes Ramadan / Ayyam behaviour.
 *
 * @param loggedSet Set of "Prayer|type" keys already handled (see above)
 * @returns array of { prayer, type, group, scheduledAt, windowEndsAt, action, reason, now }
 */
function planTickActions(plan, nowIn, prefs, loggedSet, graceMin = SEND_GRACE_MIN, specials = []) {
  const now = moment.isMoment(nowIn) ? nowIn : moment(nowIn);
  const actions = [];
  const isHandled = (prayer, type) => loggedSet && loggedSet.has(`${prayer}|${type}`);

  // --- Daily (the five prayers) candidates --------------------------------
  // precedence: a pre-reminder outranks a follow-up when the two collide, so
  // post(N) is the one dropped in favour of pre(N+1) (product rule).
  const daily = [];
  for (const ev of plan) {
    const allowed = (type) => (type === "reminder" ? prefs.pre : prefs.post) && prefs.enabled(ev.name);
    if (allowed("reminder")) daily.push({ prayer: ev.name, type: "reminder", scheduledAt: ev.preAt, notAfter: ev.at, precedence: 2, group: "daily" });
    if (allowed("followup")) daily.push({ prayer: ev.name, type: "followup", scheduledAt: ev.postAt, notAfter: null, precedence: 1, group: "daily" });
  }
  // Drop anything already handled (sent / skipped_* / in-flight) before the
  // gap pass, so a retried 'failed' event (NOT in loggedSet) still participates.
  const live = daily.filter((c) => !isHandled(c.prayer, c.type));

  // --- Minimum-gap collapse (chronological) --------------------------------
  // Sort ascending; walk and keep the more-relevant of any two emails that fall
  // within MIN_USER_GAP of each other. The superseded one is a permanent
  // 'skipped_superseded' — never resent, so a backstop/clustered tick can never
  // emit two emails that were supposed to be spaced apart.
  live.sort((a, b) => a.scheduledAt.valueOf() - b.scheduledAt.valueOf());
  const kept = [];
  for (const c of live) {
    const prev = kept[kept.length - 1];
    if (prev && c.scheduledAt.diff(prev.scheduledAt, "minutes") < MIN_USER_GAP_MIN) {
      if (c.precedence >= prev.precedence) {
        // current wins (equal → later is more current): supersede prev
        actions.push({ ...prev, action: "skipped_superseded", reason: "gap-superseded", windowEndsAt: prev.scheduledAt.clone().add(graceMin, "minutes"), now });
        kept[kept.length - 1] = c;
      } else {
        actions.push({ ...c, action: "skipped_superseded", reason: "gap-superseded", windowEndsAt: c.scheduledAt.clone().add(graceMin, "minutes"), now });
      }
      continue;
    }
    kept.push(c);
  }

  // --- Window classification for the kept daily events --------------------
  const due = [];
  for (const c of kept) {
    // A pre-reminder is only useful up to the prayer time itself: the window is
    // capped at T so it can never go out after the prayer has begun.
    const graceEnd = c.scheduledAt.clone().add(graceMin, "minutes");
    const windowEndsAt = c.notAfter && c.notAfter.isBefore(graceEnd) ? c.notAfter : graceEnd;
    if (now.isBefore(c.scheduledAt)) continue; // not due yet
    if (now.isBefore(windowEndsAt)) {
      due.push({ ...c, windowEndsAt });
    } else if (c.notAfter && !now.isBefore(c.notAfter)) {
      actions.push({ ...c, action: "skipped_stale", reason: "prayer-time-passed", windowEndsAt, now });
    } else {
      actions.push({ ...c, action: "skipped_stale", reason: "window-expired", windowEndsAt, now });
    }
  }

  // At most ONE daily email per tick: newest still-fresh due wins; the rest are
  // superseded (never caught up on a later tick).
  due.sort((a, b) => b.scheduledAt.valueOf() - a.scheduledAt.valueOf());
  due.forEach((d, i) => {
    if (i === 0) actions.push({ ...d, action: "send", reason: "", now });
    else actions.push({ ...d, action: "skipped_superseded", reason: "tick-cap", now });
  });

  // --- Seasonal (opt-in) emails: unchanged, independent per-tick cap --------
  // Ramadan / Ayyam are out of this fix's scope; they keep their own single
  // email-per-tick group so the daily collapse above never suppresses them.
  const sDue = [];
  for (const s of specials || []) {
    if (isHandled(s.prayer, s.type)) continue;
    const c = { prayer: s.prayer, type: s.type, scheduledAt: s.at, group: "special", precedence: 1 };
    const windowEndsAt = s.at.clone().add(graceMin, "minutes");
    if (now.isBefore(s.at)) continue;
    if (now.isBefore(windowEndsAt)) sDue.push({ ...c, windowEndsAt });
    else actions.push({ ...c, action: "skipped_stale", reason: "window-expired", windowEndsAt, now });
  }
  sDue.sort((a, b) => b.scheduledAt.valueOf() - a.scheduledAt.valueOf());
  sDue.forEach((d, i) => {
    if (i === 0) actions.push({ ...d, action: "send", reason: "", now });
    else actions.push({ ...d, action: "skipped_stale", reason: "tick-cap-older-due", now });
  });

  return actions;
}

/**
 * Statuses that mean "this event is finished — never reconsider it". 'failed'
 * and an in-flight 'sending'/'pending' are deliberately NOT here: a 'failed'
 * row is retryable, and an abandoned claim (sending/pending older than 2 min)
 * is treated as retryable too, so a crashed invocation cannot permanently stall
 * an email. Everything else (a fresh in-flight claim or any terminal outcome)
 * is handled for this tick.
 */
const TERMINAL_STATUSES = new Set(["sent", "skipped_stale", "skipped_superseded", "skipped_already_logged"]);
const ABANDON_MIN = 2;

// Convert a notifications_log status map (key -> {status, claimed_at}) into the
// handled-set consumed by planTickActions. See TERMINAL_STATUSES for the rule.
function handledSetFrom(statuses, now) {
  const set = new Set();
  for (const [key, row] of statuses) {
    if (TERMINAL_STATUSES.has(row.status)) { set.add(key); continue; }
    // A failed send is always retryable (the window check in planTickActions
    // still stops it once the window closes), so leave it out of the set.
    if (row.status === "failed") continue;
    // pending / sending = in-flight unless abandoned (claimed > 2 min ago).
    const claimed = row.claimed_at ? moment(row.claimed_at) : null;
    const abandoned = claimed && now.diff(claimed, "minutes") >= ABANDON_MIN;
    if (!abandoned) set.add(key); // fresh in-flight claim → handled this tick
  }
  return set;
}

/**
 * Log a freshly-computed day plan once per day so ops can confirm every reminder
 * job is anchored to the correct timestamp for that day's real schedule.
 */
function logDayPlan(user, row, plan) {
  const detail = plan.map((p) => ({
    prayer: p.name,
    at: p.at.toISOString(),
    preAt: p.preAt.toISOString(),
    postAt: p.postAt.toISOString(),
    autoMarkAt: p.cutoff.toISOString(),
  }));
  console.log(`[scheduler] day-plan user=${user.id} date=${row.date} tz=${row.timezone}`, JSON.stringify(detail));

  // Short-gap monitor: flag consecutive prayers that are suspiciously close, as
  // that is the only case where two prayers' reminders can look like they fire
  // together even though each is anchored to its own real time.
  for (let i = 0; i < plan.length - 1; i++) {
    const gap = plan[i + 1].at.diff(plan[i].at, "minutes");
    if (gap < MIN_PRAYER_GAP_WARN_MIN) {
      console.warn(
        `[scheduler] WARN close-prayer-times user=${user.id} ${plan[i].name}→${plan[i + 1].name} gap=${gap}min (check location/calc method)`
      );
    }
  }
}

/**
 * Log a skipped email: user, prayer, type, scheduled target, now, reason.
 */
function logSkip(user, a) {
  console.warn(
    `[scheduler] SKIP-EMAIL user=${user.id} prayer=${a.prayer} type=${a.type} ` +
    `scheduledAt=${a.scheduledAt.toISOString()} windowEndsAt=${a.windowEndsAt.toISOString()} ` +
    `now=${a.now.toISOString()} reason=${a.reason}`
  );
}

/**
 * Core tick: called externally every 5 minutes (GitHub Actions workflow or
 * Vercel Cron hitting POST /api/cron/prayer-scheduler). For every user with a
 * city set, it rebuilds the day's plan from THEIR actual, freshly-fetched
 * prayer times (in their own timezone) and asks planTickActions() which emails
 * are due THIS tick. Each due email is claimed atomically in notifications_log
 * (insert-first, on-conflict do nothing) before sending, so overlapping ticks
 * can never double-send; every expired email is permanently marked
 * 'skipped_stale' and never caught up.
 *
 * This function no longer self-schedules. Serverless invocations return before
 * any in-process timer would fire, so the ONLY correct trigger path is an
 * external HTTP request. For local development, run `npm run tick-once`.
 *
 * Options on `process.env`:
 *   SCHEDULER_DRY_RUN=1       Skip SMTP; log every email that WOULD have been
 *                             sent and still mark the notification_log row as
 *                             'sent' so the pipeline is exercised end-to-end.
 *   MAX_EMAILS_PER_TICK=<n>   Hard cap on real emails per invocation. Any
 *                             claim beyond the cap is released so the next
 *                             tick picks it up inside the widened grace window.
 */
async function tick(nowOverride) {
  const now = nowOverride ? moment(nowOverride) : moment();
  const startTs = new Date().toISOString();
  const DRY_RUN = process.env.SCHEDULER_DRY_RUN === 'true' || process.env.SCHEDULER_DRY_RUN === '1';
  const capEnv = Number(process.env.MAX_EMAILS_PER_TICK || MAX_EMAILS_PER_TICK);
  const cap = Number.isFinite(capEnv) && capEnv > 0 ? capEnv : Infinity;

  // Heartbeat counters persisted to cron_heartbeat in the finally block, no
  // matter how the tick exits (throw, rate-cap release, per-user error).
  let usersSeen = 0, emailsSent = 0, emailsSkippedStale = 0, emailsSuperseded = 0, emailsFailed = 0, userErrors = 0, tickError = null;

  try {
    // Get all users with city and country set from Supabase
    const { data: profiles, error: userError } = await supabase
      .from('user_profiles')
      .select('*')
      .not('city', 'is', null)
      .not('country', 'is', null);

    if (userError) {
      console.error('[scheduler] Error fetching users:', userError);
      tickError = `fetch-users: ${userError.message}`;
      return;
    }
    usersSeen = (profiles || []).length;

    for (const user of profiles) {
      try {
        const row = await getOrFetchTodayTimes(user);
        if (!row || !row.timezone) continue;

        // Aladhan-down detection: a fresh fetch stamps fetched_at within the
        // last few minutes. Anything older than 26 hours means today's fetch
        // failed and we are working from a stale cache. Surface it as a
        // single structured line so ops can grep without reading HTTP logs.
        if (row.fetched_at) {
          const ageHours = now.diff(moment(row.fetched_at), 'hours', true);
          if (ageHours > 26) {
            console.warn(`[scheduler] aladhan-unavailable user=${user.id} using-cache date=${row.date} ageHours=${Math.round(ageHours)}`);
          }
        }

        const date = row.date;
        const prefs = notifPrefsOf(user);
        const plan = buildDayPlan(row, prefs);
        const specials = buildSpecialEvents(row, prefs);

        // Validation logging: dump the plan once, right after the day's times are
        // fetched/updated, so we can confirm each reminder's scheduled timestamp.
        if (row.fetched_at && now.diff(moment(row.fetched_at), "minutes") <= PLAN_LOG_FRESH_MIN) {
          logDayPlan(user, row, plan);
        }

        // Build the handled-set from the row STATUS, not mere existence: a
        // 'failed' or abandoned ('sending' > 2 min old) row is left OUT so
        // planTickActions can re-offer it for retry while the window is open;
        // every other terminal status and a fresh in-flight claim stay handled.
        const statuses = await db.getNotificationLogStatuses(user.id, date);
        const loggedSet = handledSetFrom(statuses, now);
        const actions = planTickActions(plan, now, prefs, loggedSet, SEND_GRACE_MIN, specials);

        for (const a of actions) {
          const base = {
            user_id: user.id, prayer_name: a.prayer, date,
            type: a.type, scheduled_at: a.scheduledAt.toISOString(),
          };
          const decision = `user=${user.id} prayer=${a.prayer} type=${a.type} due_at=${a.scheduledAt.toISOString()} now=${now.toISOString()} decision=${a.action}${a.reason ? ` reason=${a.reason}` : ""}`;

          // Expired or superseded email: write a permanent terminal row so no
          // later tick reconsiders it, then log. NEVER send. resolveSkipped...
          // only writes when there is no 'sent' row already (never clobbers a
          // real delivery) and converts a leftover 'failed'/'sending' to skipped.
          if (a.action === "skipped_stale" || a.action === "skipped_superseded") {
            const wrote = await db.resolveSkippedNotificationLog({ ...base, status: a.action });
            if (wrote) {
              if (a.action === "skipped_superseded") emailsSuperseded++; else emailsSkippedStale++;
              logSkip(user, a);
            }
            continue;
          }

          // Gentle-tone skip: the follow-up is only for someone who has NOT
          // already logged the prayer. A 'done' response => skipped_already_logged.
          if (a.type === "followup") {
            const existing = await db.getResponse(user.id, a.prayer, date);
            if (existing && existing.status === "done") {
              const wrote = await db.resolveSkippedNotificationLog({ ...base, status: "skipped_already_logged" });
              if (wrote) { emailsSkippedStale++; logSkip(user, { ...a, reason: "already-logged" }); }
              continue;
            }
          }

          // Per-tick rate cap: stop claiming at the ceiling so a large user-base
          // spreads across ticks rather than one SMTP flood. Unclaimed now → the
          // next tick picks it up while the window is still open.
          if (emailsSent >= cap) {
            console.warn(`[scheduler] rate-cap ${decision} cap=${cap}`);
            continue;
          }

          // Claim the send atomically. Fresh event => insert-as-'sending' wins
          // the unique key. Retry event => the row already exists as
          // 'failed'/abandoned, so claim it with an UPDATE guarded on that status
          // that returns the row to exactly one concurrent tick.
          let claimed = await db.claimNotificationLog({ ...base, status: "sending", claimed_at: now.toISOString() });
          if (!claimed) claimed = await db.retryClaimNotificationLog(base, now.toISOString());
          if (!claimed) continue;

          const ev = plan.find((p) => p.name === a.prayer);
          let result = { success: false, error: "auth user lookup failed" };
          const { data: authUser } = await supabase.auth.admin.getUserById(user.id);
          if (authUser && authUser.user) {
            const to = authUser.user.email;
            if (DRY_RUN) {
              // Emit the exact subject the real pipeline would send, but do
              // nothing on the wire. Same shape as sendMail's success object.
              const subj = a.type === "reminder"
                ? t(resolveLocale(user, resolveLocaleFromCountry), "email.subject.prayer_soon", { prayer: a.prayer, mins: prefs.preMinutes })
                : a.type === "followup"
                  ? t(resolveLocale(user, resolveLocaleFromCountry), "email.subject.followup", { prayer: a.prayer })
                  : `[dry-run ${a.type}]`;
              result = { success: true, dryRun: true, subject: subj, to };
            } else if (a.type === "reminder") {
              result = await sendMail({
                to,
                subject: t(resolveLocale(user, resolveLocaleFromCountry), "email.subject.prayer_soon", { prayer: a.prayer, mins: prefs.preMinutes }),
                html: reminderEmailHtml(user, a.prayer, ev.timeStr, prefs.preMinutes),
              });
            } else if (a.type === "followup") {
              // Follow-up inputs are ONLY: prayer time + user's postMinutes,
              // prefs, dedup. It never depends on the pre-reminder or the next
              // prayer.
              const token = createResponseToken(user.id, a.prayer, date);
              const yesUrl = `${siteOrigin()}/respond?token=${token}&action=yes`;
              const noUrl = `${siteOrigin()}/respond?token=${token}&action=no`;
              result = await sendMail({
                to,
                subject: t(resolveLocale(user, resolveLocaleFromCountry), "email.subject.followup", { prayer: a.prayer }),
                html: followupEmailHtml(user, a.prayer, date, yesUrl, noUrl, prefs.postMinutes),
              });
            } else if (a.type === "sunnah_fast") {
              result = await sendMail({
                to,
                subject: t(resolveLocale(user, resolveLocaleFromCountry), "email.subject.ayyam"),
                html: sunnahFastEmailHtml(user, row),
              });
            } else if (a.type === "suhoor") {
              result = await sendMail({
                to,
                subject: t(resolveLocale(user, resolveLocaleFromCountry), "email.subject.suhoor"),
                html: suhoorEmailHtml(user, row),
              });
            } else if (a.type === "iftar") {
              result = await sendMail({
                to,
                subject: t(resolveLocale(user, resolveLocaleFromCountry), "email.subject.iftar"),
                html: iftarEmailHtml(user, row),
              });
            } else if (a.type === "taraweeh") {
              result = await sendMail({
                to,
                subject: t(resolveLocale(user, resolveLocaleFromCountry), "email.subject.taraweeh"),
                html: taraweehEmailHtml(user, row),
              });
            }
          }

          if (result.success) {
            await db.markNotificationLogSent(claimed.id);
            emailsSent++;
            const mode = DRY_RUN ? "dry-run-sent" : "sent";
            if (a.type === "reminder") {
              await upsertPendingResponse(user.id, user.group_id, a.prayer, date);
              console.log(`[scheduler] ${mode} ${decision} at=${ev ? ev.at.toISOString() : ""}`);
            } else if (a.type === "followup") {
              const existing = await db.getResponse(user.id, a.prayer, date);
              if (existing) {
                await db.updateResponse(existing.id, { followup_sent_at: new Date().toISOString() });
              }
              console.log(`[scheduler] ${mode} ${decision} at=${ev ? ev.at.toISOString() : ""}`);
            } else {
              console.log(`[scheduler] ${mode} ${decision}`);
            }
          } else {
            // Send failed: KEEP the row and mark it 'failed' with the provider
            // error, so the next tick can retry it while the window is open. The
            // row is never deleted — a real delivery that raced a crash stays
            // deduped, and a genuine failure is auditable. Past the window it is
            // converted to skipped_stale by the normal skip path.
            await db.markNotificationLogFailed(claimed.id, result.error);
            emailsFailed++;
            console.error(`[scheduler] send-failed ${decision} error=${result.error}`);
          }
        }

        for (const ev of plan) {
          const { name, at, cutoff } = ev;

          // Tracking (not email): once the prayer time has passed, make sure a
          // response row exists so the user's taps and the auto-mark below have
          // something to update — regardless of the user's email preferences.
          if (now.isSameOrAfter(at)) {
            await upsertPendingResponse(user.id, user.group_id, name, date);
          }

          // Auto-mark "Not Prayed" once the cutoff passes with no response.
          // Logged separately (mark_source='auto') from a user's own tap.
          // This step NEVER sends an email.
          if (now.isSameOrAfter(cutoff)) {
            const existing = await db.getResponse(user.id, name, date);
            if (existing && existing.status === 'pending') {
              await db.updateResponse(existing.id, { status: 'missed', mark_source: 'auto' });
              console.log(`[scheduler] auto-marked missed user=${user.id} prayer=${name} date=${date} cutoff=${cutoff.toISOString()}`);
            }
          }
        }

        // Ramadan fast tracking — independent of the Ramadan EMAILS: if the
        // user's day is in Ramadan (per their own city's Hijri calendar) we open
        // a 'Fast' pending row at Imsak/Fajr so the dashboard chip can mark it.
        // Fast rows are kind='fast' and are NEVER auto-marked missed: no one
        // gets a red "missed fast". The tracking email prefs do not gate this.
        if (Number(row.hijri_month_num) === 9) {
          const fastAnchor = moment.tz(`${row.date} ${row.imsak && row.imsak !== "00:00" ? row.imsak : row.fajr}`, "YYYY-MM-DD HH:mm", row.timezone);
          if (fastAnchor.isValid() && now.isSameOrAfter(fastAnchor)) {
            await upsertPendingResponse(user.id, user.group_id, "Fast", date, { kind: "fast" });
          }
        }
      } catch (err) {
        userErrors++;
        console.error(`[scheduler] error for user ${user.id}:`, err.message);
      }
    }

    // One compact summary line so ops can grep the tick's total effect without
    // parsing every per-email log.
    console.log(`[scheduler] tick-complete now=${now.toISOString()} users=${usersSeen} sent=${emailsSent} skipped_stale=${emailsSkippedStale} superseded=${emailsSuperseded} failed=${emailsFailed} user_errors=${userErrors} dry_run=${DRY_RUN}`);
  } catch (err) {
    tickError = err && err.message ? err.message : String(err);
    throw err;
  } finally {
    // Persist the heartbeat AFTER the tick, in its own try so a heartbeat-write
    // failure never masks or turns a successful tick into a failure.
    try {
      await db.upsertCronHeartbeat({
        last_started_at: startTs,
        last_finished_at: new Date().toISOString(),
        last_error: tickError,
        users_seen: usersSeen,
        emails_sent: emailsSent,
        emails_skipped_stale: emailsSkippedStale,
        emails_superseded: emailsSuperseded,
        emails_failed: emailsFailed,
        user_errors: userErrors,
        dry_run: DRY_RUN,
      });
    } catch (hbErr) {
      console.error('[scheduler] heartbeat write failed:', hbErr.message);
    }
  }
}

// Expose tick() and the pure internals for testing. `start()` used to run an
// in-process node-cron here; that path was deleted because serverless hosts
// exit before the first timer callback — see migration 0007 and README.
module.exports = {
  tick,
  buildDayPlan,
  buildSpecialEvents,
  planTickActions,
  notifPrefsOf,
  handledSetFrom,
  SEND_GRACE_MIN,
  MIN_USER_GAP_MIN,
  SPECIAL_KEYS,
};
