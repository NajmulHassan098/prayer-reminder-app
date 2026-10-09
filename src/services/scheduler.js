const cron = require("node-cron");
const moment = require("moment-timezone");
const db = require("../db");
// Service-role client: the scheduler runs outside any user session, so it must
// bypass RLS to read all user profiles and look up each user's auth email.
const { supabaseAdmin: supabase } = require("../supabase");
const { getOrFetchTodayTimes } = require("./prayerTimes");
const { sendMail, reminderEmailHtml, followupEmailHtml } = require("./email");
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
const SEND_GRACE_MIN = Number(process.env.SEND_GRACE_MINUTES || 10);
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

/**
 * Interpret a user's stored notification_prefs. A missing/NULL value means
 * "everything enabled" so existing users keep receiving all emails until they
 * actively opt out. Each prayer toggle gates BOTH its pre-reminder and its
 * follow-up; `pre`/`post` are global switches for the two email types.
 */
function notifPrefsOf(user) {
  const p = user.notification_prefs || {};
  const prayers = p.prayers || {};
  return {
    pre: p.pre !== false,
    post: p.post !== false,
    enabled: (name) => prayers[name] !== false,
  };
}

async function upsertPendingResponse(userId, groupId, prayerName, date) {
  try {
    const existing = await db.getResponse(userId, prayerName, date);
    if (!existing) {
      await db.createResponse({
        user_id: userId,
        group_id: groupId,
        prayer_name: prayerName,
        date: date,
        status: 'pending'
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
 */
function buildDayPlan(row) {
  const tz = row.timezone;
  const points = PRAYERS.map((name) => {
    const t = row[name.toLowerCase()];
    if (!t) return null;
    const at = moment.tz(`${row.date} ${t}`, "YYYY-MM-DD HH:mm", tz);
    return at.isValid() ? { name, timeStr: t, at } : null;
  }).filter(Boolean);

  return points.map((p, i) => {
    const prev = points[i - 1];
    const next = points[i + 1];

    // Pre-reminder: PRE minutes before the prayer, but never before the previous
    // prayer's own time (+1 min) so consecutive reminders can't pile up.
    let preAt = p.at.clone().subtract(PRE_REMINDER_MIN, "minutes");
    if (prev) {
      const floor = prev.at.clone().add(1, "minutes");
      if (preAt.isBefore(floor)) preAt = floor;
    }

    // Follow-up: POST minutes after the prayer.
    const postAt = p.at.clone().add(FOLLOWUP_DELAY_MIN, "minutes");

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

/**
 * Pure decision function: for one user's day plan, decide the exact email
 * actions for THIS tick. No I/O — the tick executes whatever this returns.
 *
 * Rules (per email type, reminder/followup):
 *   - prefs must allow the prayer AND the type;
 *   - the (user, prayer, date, type) notification-log row, if any (sent OR
 *     skipped_stale), makes the event permanently handled → no action;
 *   - now < scheduledAt                      → not due yet, no action;
 *   - scheduledAt <= now < scheduledAt+grace → send candidate;
 *   - now >= scheduledAt+grace               → 'skipped_stale' (never sent).
 * Safeguard: at most ONE email per user per tick — when several are due, the
 * one with the LATER scheduledAt (the more relevant one) is sent and every
 * other candidate is marked 'skipped_stale' with a warn-level reason.
 *
 * @param plan      buildDayPlan() output (moment instants, user's tz-anchored)
 * @param nowIn     current time (Moment or UTC-parseable)
 * @param prefs     notifPrefsOf(user)
 * @param loggedSet Set of "Prayer|type" keys already in notifications_log
 * @param graceMin  send-window width in minutes (defaults to SEND_GRACE_MIN)
 * @returns array of { prayer, type, scheduledAt, windowEndsAt, action, reason }
 */
function planTickActions(plan, nowIn, prefs, loggedSet, graceMin = SEND_GRACE_MIN) {
  const now = moment.isMoment(nowIn) ? nowIn : moment(nowIn);
  const actions = [];
  const due = [];

  for (const ev of plan) {
    const specs = [
      { type: "reminder", scheduledAt: ev.preAt, allowed: prefs.pre },
      { type: "followup", scheduledAt: ev.postAt, allowed: prefs.post },
    ];
    for (const s of specs) {
      if (!s.allowed || !prefs.enabled(ev.name)) continue;
      if (loggedSet && loggedSet.has(`${ev.name}|${s.type}`)) continue;
      const windowEndsAt = s.scheduledAt.clone().add(graceMin, "minutes");
      if (now.isBefore(s.scheduledAt)) continue; // not due yet
      if (now.isBefore(windowEndsAt)) {
        due.push({ prayer: ev.name, type: s.type, scheduledAt: s.scheduledAt, windowEndsAt });
      } else {
        actions.push({
          prayer: ev.name, type: s.type, action: "skipped_stale",
          reason: "window-expired", scheduledAt: s.scheduledAt, windowEndsAt,
        });
      }
    }
  }

  // One-email-per-tick cap: newest scheduledAt wins; older due emails are
  // stale-by-policy and must not be retried on a later tick.
  due.sort((a, b) => b.scheduledAt.valueOf() - a.scheduledAt.valueOf());
  due.forEach((d, i) => {
    if (i === 0) actions.push({ ...d, action: "send", reason: "" });
    else actions.push({ ...d, action: "skipped_stale", reason: "tick-cap-older-due" });
  });

  return actions.map((a) => ({ ...a, now }));
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
 * Core tick: runs every few minutes. For every user with a city set, it rebuilds
 * the day's plan from THEIR actual, freshly-fetched prayer times (in their own
 * timezone) and asks planTickActions() which emails are due THIS tick. Each due
 * email is claimed atomically in notifications_log (insert-first, on-conflict do
 * nothing) before sending, so overlapping ticks can never double-send; every
 * expired email is permanently marked 'skipped_stale' and never caught up.
 */
async function tick(nowOverride) {
  const now = nowOverride ? moment(nowOverride) : moment();

  // Get all users with city and country set from Supabase
  const { data: profiles, error: userError } = await supabase
    .from('user_profiles')
    .select('*')
    .not('city', 'is', null)
    .not('country', 'is', null);

  if (userError) {
    console.error('[scheduler] Error fetching users:', userError);
    return;
  }

  for (const user of profiles) {
    try {
      const row = await getOrFetchTodayTimes(user);
      if (!row || !row.timezone) continue;

      const date = row.date;
      const prefs = notifPrefsOf(user);
      const plan = buildDayPlan(row);

      // Validation logging: dump the plan once, right after the day's times are
      // fetched/updated, so we can confirm each reminder's scheduled timestamp.
      if (row.fetched_at && now.diff(moment(row.fetched_at), "minutes") <= PLAN_LOG_FRESH_MIN) {
        logDayPlan(user, row, plan);
      }

      // One query builds the handled-set: every (prayer, type) that already has
      // a log row — sent or skipped_stale — is never touched again.
      const loggedSet = await db.getNotificationLogKeys(user.id, date);
      const actions = planTickActions(plan, now, prefs, loggedSet);

      for (const a of actions) {
        const base = {
          user_id: user.id, prayer_name: a.prayer, date,
          type: a.type, scheduled_at: a.scheduledAt.toISOString(),
        };

        // Expired or capped-out email: write a permanent 'skipped_stale' row so
        // no later tick can reconsider it, then warn. NEVER send.
        if (a.action === "skipped_stale") {
          const claimed = await db.claimNotificationLog({ ...base, status: "skipped_stale" });
          if (claimed) logSkip(user, a);
          continue;
        }

        // Due email: claim FIRST (ON CONFLICT DO NOTHING on the unique key).
        // A conflicting insert means another tick already handled this email.
        const claimed = await db.claimNotificationLog({ ...base, status: "sending" });
        if (!claimed) continue;

        const ev = plan.find((p) => p.name === a.prayer);
        let result = { success: false, error: "auth user lookup failed" };
        const { data: authUser } = await supabase.auth.admin.getUserById(user.id);
        if (authUser && authUser.user) {
          if (a.type === "reminder") {
            result = await sendMail({
              to: authUser.user.email,
              subject: `🕌 Time to prepare for ${a.prayer}`,
              html: reminderEmailHtml(user, a.prayer, ev.timeStr, PRE_REMINDER_MIN),
            });
          } else {
            // Follow-up inputs are ONLY: prayer time + FOLLOWUP_DELAY, prefs,
            // dedup. It never depends on the pre-reminder or the next prayer.
            const token = createResponseToken(user.id, a.prayer, date);
            const yesUrl = `${siteOrigin()}/respond?token=${token}&action=yes`;
            const noUrl = `${siteOrigin()}/respond?token=${token}&action=no`;
            result = await sendMail({
              to: authUser.user.email,
              subject: `Did you pray ${a.prayer}?`,
              html: followupEmailHtml(user, a.prayer, date, yesUrl, noUrl),
            });
          }
        }

        if (result.success) {
          await db.markNotificationLogSent(claimed.id);
          if (a.type === "reminder") {
            await upsertPendingResponse(user.id, user.group_id, a.prayer, date);
            console.log(`[scheduler] sent reminder user=${user.id} ${a.prayer} at=${ev.at.toISOString()} target=${a.scheduledAt.toISOString()}`);
          } else {
            const existing = await db.getResponse(user.id, a.prayer, date);
            if (existing) {
              await db.updateResponse(existing.id, { followup_sent_at: new Date().toISOString() });
            }
            console.log(`[scheduler] sent followup user=${user.id} ${a.prayer} at=${ev.at.toISOString()} target=${a.scheduledAt.toISOString()}`);
          }
        } else {
          // Send failed: release the claim so the next tick can retry inside the
          // remaining window. Once the window closes it becomes skipped_stale.
          await db.deleteNotificationLog(claimed.id);
          console.error(`[scheduler] send failed, claim released user=${user.id} ${a.prayer} type=${a.type}: ${result.error}`);
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
            console.log(`[scheduler] auto-marked missed user=${user.id} ${name} date=${date} cutoff=${cutoff.toISOString()}`);
          }
        }
      }
    } catch (err) {
      console.error(`[scheduler] error for user ${user.id}:`, err.message);
    }
  }
}

function start() {
  // Every 5 minutes. Adjust the cron expression if you want it more/less frequent.
  cron.schedule("*/5 * * * *", () => {
    tick().catch((e) => console.error("[scheduler] tick failed:", e));
  });

  // Also run once shortly after startup so today's data populates immediately.
  setTimeout(() => tick().catch((e) => console.error("[scheduler] initial tick failed:", e)), 5000);

  console.log("[scheduler] started — checking every 5 minutes");
}

// Export both start and tick for flexibility, plus internals for testing.
module.exports = { start, tick, buildDayPlan, planTickActions, notifPrefsOf, SEND_GRACE_MIN };
