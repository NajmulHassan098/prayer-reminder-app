const express = require("express");
const db = require("../db");
const { requireLogin, requireGroupAdmin } = require("../middleware/auth");
const { getOrFetchTodayTimes, getOrFetchTimesForDate, localDateStrFor, todayStr, computeNextPrayer, getQiblaInfo, getTahajjudWindow } = require("../services/prayerTimes");
const { REMINDERS, reminderOfTheDay } = require("../data/reminders");
const { hadithOfTheDay } = require("../data/hadiths");
const { doneCountsByDate, currentStreak, bestStreakInMonth, monthSummary } = require("../utils/streaks");

const router = express.Router();
const PRAYERS = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];

router.get("/", (req, res) => {
  if (req.session.userId) return res.redirect("/dashboard");
  res.render("landing", { reminders: REMINDERS });
});

router.get("/dashboard", requireLogin, async (req, res) => {
  const user = req.user;
  // Use the user's LOCAL calendar day (not UTC) so the shown "today", the status
  // maps, and the hidden date in the mark-prayer forms all line up with what the
  // scheduler records for reminders/follow-ups.
  const date = await localDateStrFor(user);

  let group = null;
  let memberCount = 0;
  // Shared, visible-to-every-member view of the whole group's prayers.
  let groupRows = [];      // one row per member: { member, statusMap } for today
  let weekly = [];         // one row per member: { member, days:[{date,done}], totalDone }
  let weekDates = [];      // last 7 calendar days ending today: { date, label, day }

  if (user.group_id) {
    group = await db.getGroupById(user.group_id);
    const members = await db.getGroupMembers(user.group_id);
    memberCount = members.length;

    const nameById = {};
    members.forEach((m) => (nameById[m.id] = m.name));

    // Fetch every member's responses once, reuse for both the today matrix
    // and the combined activity log.
    const perMember = await Promise.all(
      members.map(async (m) => ({ member: m, responses: await db.getResponsesByUser(m.id) }))
    );

    groupRows = perMember.map(({ member, responses }) => {
      const statusMap = {};
      responses.filter((r) => r.date === date)
        .forEach((r) => (statusMap[r.prayer_name] = r.status));
      return { member: { id: member.id, name: member.name }, statusMap };
    });

    // Weekly progress: the last 7 calendar days (ending today), counting prayers
    // marked done per day (out of 5) for each member. Visible to every member.
    const base = new Date(`${date}T00:00:00Z`);
    for (let i = 6; i >= 0; i--) {
      const dt = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() - i));
      weekDates.push({
        date: dt.toISOString().slice(0, 10),
        label: dt.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }),
        day: dt.getUTCDate(),
      });
    }
    weekly = perMember.map(({ member, responses }) => {
      const days = weekDates.map((d) => ({
        date: d.date,
        done: responses.filter((r) => r.date === d.date && r.status === "done" && PRAYERS.includes(r.prayer_name)).length,
      }));
      const totalDone = days.reduce((s, x) => s + x.done, 0);
      return { member: { id: member.id, name: member.name }, days, totalDone };
    });
  }

  let todayTimes = null;
  let apiError = null;
  try {
    todayTimes = await getOrFetchTimesForDate(user, date);
  } catch (err) {
    apiError = "Could not fetch prayer times right now. Try again shortly.";
  }

  const todayResponses = await db.getResponsesByUser(user.id);
  // Only the five salāh rows drive the grid/progress — Ramadan fast rows
  // (prayer_name 'Fast', kind 'fast') share the table but are not prayers.
  const todayResponsesFiltered = todayResponses.filter(r => r.date === date && PRAYERS.includes(r.prayer_name));
  const statusMap = {};
  const sourceMap = {};
  todayResponsesFiltered.forEach((r) => {
    statusMap[r.prayer_name] = r.status;
    sourceMap[r.prayer_name] = r.mark_source || null;
  });
  
  // Calculate completed prayers for progress indicator
  const completedCount = Object.values(statusMap).filter(status => status === 'done').length;

  // Ramadan fast row + private qaḍā state for today's missed prayers. Both live
  // on the personal dashboard only — they are never shown in group/admin views.
  const fastRow = todayResponses.find(r => r.prayer_name === "Fast" && r.date === date) || null;
  const isRamadan = !!(todayTimes && Number(todayTimes.hijri_month_num) === 9);
  // Eid al-Fitr: 1 Shawwal (hijri month 10, day 1). Drives a celebratory link.
  const isEid = !!(todayTimes && Number(todayTimes.hijri_month_num) === 10 && Number(todayTimes.hijri_day) === 1);
  const qadaMap = {};
  todayResponsesFiltered.forEach((r) => { qadaMap[r.prayer_name] = !!r.made_up_at; });

  const recentHistory = await db.getResponsesByUser(user.id);
  const recentHistoryLimited = recentHistory.slice(0, 25);

  const isAdmin = !!(group && group.created_by === user.id);

  // Jummah is Friday in the user's own locale (the `date` string is already their
  // local calendar day, so reading it as a UTC midnight keeps the weekday correct).
  const isJummah = new Date(`${date}T00:00:00Z`).getUTCDay() === 5;

  res.render("dashboard", {
    user,
    group,
    memberCount,
    todayTimes,
    apiError,
    statusMap,
    sourceMap,
    PRAYERS,
    recentHistory: recentHistoryLimited,
    isAdmin,
    reminder: reminderOfTheDay(),
    hadith: hadithOfTheDay(),
    today: date,
    isJummah,
    completedCount,
    isRamadan,
    fastRow,
    isEid,
    qadaMap,
    groupRows,
    weekly,
    weekDates,
  });
});

// Dedicated "group prayer log" page — the day-by-day timeline of every member's
// responses, extracted off the dashboard so the dashboard stays lightweight.
router.get("/group/activity", requireLogin, async (req, res) => {
  const user = req.user;
  if (!user.group_id) return res.redirect("/dashboard");

  const group = await db.getGroupById(user.group_id);
  const members = await db.getGroupMembers(user.group_id);

  const perMember = await Promise.all(
    members.map(async (m) => ({ member: m, responses: await db.getResponsesByUser(m.id) }))
  );

  // Fast rows are personal Ramadan trackers — keep them out of the shared log.
  const groupHistory = perMember
    .flatMap(({ member, responses }) =>
      responses.filter((r) => PRAYERS.includes(r.prayer_name)).map((r) => ({ ...r, memberName: member.name }))
    )
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (b.responded_at || "") < (a.responded_at || "") ? -1 : 1;
    })
    .slice(0, 60);

  res.render("group_activity", { user, group, groupHistory, PRAYERS, isAdmin: !!(group && group.created_by === user.id) });
});

// Dedicated weekly prayer table for the whole group (last 7 calendar days).
router.get("/weekly", requireLogin, async (req, res) => {
  const user = req.user;
  const date = await localDateStrFor(user);

  let group = null;
  let memberCount = 0;
  let weekly = [];
  let weekDates = [];
  let isAdmin = false;

  if (user.group_id) {
    group = await db.getGroupById(user.group_id);
    const members = await db.getGroupMembers(user.group_id);
    memberCount = members.length;
    isAdmin = !!(group && group.created_by === user.id);

    const perMember = await Promise.all(
      members.map(async (m) => ({ member: m, responses: await db.getResponsesByUser(m.id) }))
    );

    const base = new Date(`${date}T00:00:00Z`);
    for (let i = 6; i >= 0; i--) {
      const dt = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() - i));
      weekDates.push({
        date: dt.toISOString().slice(0, 10),
        label: dt.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }),
        day: dt.getUTCDate(),
      });
    }

    weekly = perMember.map(({ member, responses }) => {
      const days = weekDates.map((d) => ({
        date: d.date,
        done: responses.filter((r) => r.date === d.date && r.status === "done" && PRAYERS.includes(r.prayer_name)).length,
      }));
      const totalDone = days.reduce((s, x) => s + x.done, 0);
      return { member: { id: member.id, name: member.name }, days, totalDone };
    });
  }

  // Personal istiqāmah card (shown whether or not the user is in a group).
  // Fast rows share the responses table but are not prayers — excluded.
  const myResponses = await db.getResponsesByUser(user.id);
  const doneByDate = doneCountsByDate(myResponses, PRAYERS);
  const streak = {
    current: currentStreak(doneByDate, date),
    bestThisMonth: bestStreakInMonth(doneByDate, date.slice(0, 7), date),
    month: monthSummary(doneByDate, date.slice(0, 7), date),
  };

  // Private qaḍā figures for this month — a restorative summary, shown only on
  // the user's own weekly page and never in group views or emails.
  const monthMissed = myResponses.filter(r =>
    r.status === "missed" && PRAYERS.includes(r.prayer_name) && r.date.slice(0, 7) === date.slice(0, 7));
  const qada = {
    madeUp: monthMissed.filter(r => r.made_up_at).length,
    remaining: monthMissed.filter(r => !r.made_up_at).length,
  };

  res.render("weekly", { user, group, memberCount, weekly, weekDates, isAdmin, today: date, PRAYERS, streak, qada });
});

// Focused "today" page: the animated next-prayer ring, the day's schedule, and
// tonight's Tahajjud window. Kept off the dashboard so the dashboard stays light.
router.get("/times", requireLogin, async (req, res) => {
  const user = req.user;
  const date = await localDateStrFor(user);
  let todayTimes = null;
  let nextPrayer = null;
  let tahajjud = null;
  let apiError = null;
  try {
    todayTimes = await getOrFetchTimesForDate(user, date);
    nextPrayer = await computeNextPrayer(user);
    tahajjud = await getTahajjudWindow(user);
  } catch (err) {
    apiError = "Could not fetch prayer times right now. Try again shortly.";
  }

  const responses = await db.getResponsesByUser(user.id);
  const statusMap = {};
  responses.filter((r) => r.date === date && PRAYERS.includes(r.prayer_name)).forEach((r) => (statusMap[r.prayer_name] = r.status));

  res.render("times", { user, todayTimes, nextPrayer, tahajjud, apiError, statusMap, today: date, PRAYERS, hadith: hadithOfTheDay(), isAdmin: false });
});

// Eid al-Fitr celebration — only meaningful on 1 Shawwal. We gate it on the
// user's own cached hijri fields (so it stays consistent with their region's
// Ramadan length) and gently count the fasts they logged that month.
router.get("/eid", requireLogin, async (req, res) => {
  const user = req.user;
  const date = await localDateStrFor(user);
  let todayTimes = null;
  try { todayTimes = await getOrFetchTimesForDate(user, date); } catch (err) { /* fall through */ }

  const isEidDay = !!(todayTimes && Number(todayTimes.hijri_month_num) === 10 && Number(todayTimes.hijri_day) === 1);
  const responses = await db.getResponsesByUser(user.id);
  // Count fasts marked done over the last 32 days (a safe superset of Ramadan).
  const cutoff = new Date(`${date}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 32);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const fastsDone = responses.filter(r => r.prayer_name === "Fast" && r.status === "done" && r.date > cutoffStr).length;

  res.render("eid", { user, isEidDay, fastsDone, hijriMonth: todayTimes && todayTimes.hijri_month, isAdmin: false });
});

// Qibla direction + compass for the user's saved city/country.
router.get("/qibla", requireLogin, async (req, res) => {
  const user = req.user;
  let qibla = null;
  let error = null;
  if (!user.city || !user.country) {
    error = "Set your city and country in your profile to find the Qibla direction.";
  } else {
    try {
      qibla = await getQiblaInfo(user.city, user.country);
      if (!qibla) error = "We couldn't resolve your location. Double-check your city and country in your profile.";
    } catch (err) {
      console.error("[qibla]", err.message);
      error = "Could not reach the prayer-times service right now. Please try again shortly.";
    }
  }
  res.render("qibla", { user, qibla, error, isAdmin: false });
});

// Let a logged-in user mark their own prayer as done/missed directly from the dashboard.
router.post("/prayer/mark", requireLogin, async (req, res) => {
  const { prayer_name, date, status } = req.body;

  // Fast rows are Ramadan trackers, not salah: only "done" is valid and the
  // row must already exist (the scheduler creates it at imsak for the day).
  const isFast = prayer_name === "Fast";
  if (!PRAYERS.includes(prayer_name) && !isFast) return res.status(400).send("Unknown prayer.");
  if (!isFast && !["done", "missed"].includes(status)) return res.status(400).send("Invalid status.");
  if (isFast && status !== "done") return res.status(400).send("A fast can only be marked as completed.");
  if (!date) return res.status(400).send("Missing date.");

  try {
    // Check if response already exists
    const existing = await db.getResponse(req.user.id, prayer_name, date);
    if (isFast && !existing) return res.status(400).send("No fast row for this day yet.");
    
    if (existing) {
      // Update existing response
      await db.updateResponse(existing.id, {
        status: status,
        mark_source: 'manual',
        responded_at: new Date().toISOString()
      });
    } else {
      // Create new response
      await db.createResponse({
        user_id: req.user.id,
        group_id: req.user.group_id,
        prayer_name: prayer_name,
        date: date,
        status: status,
        mark_source: 'manual',
        ...(isFast ? { kind: 'fast' } : {}),
        responded_at: new Date().toISOString()
      });
    }

    res.redirect("/dashboard");
  } catch (error) {
    console.error(`[prayer-mark] Error:`, error);
    res.status(500).send("Failed to mark prayer.");
  }
});

// Discreet qaḍā chip: the user notes a past missed prayer as made up later.
// Only allowed on their own 'missed' rows, toggles idempotently, and the field
// is never emailed or shown in any group/admin view — it is a private aid.
router.post("/prayer/qada", requireLogin, async (req, res) => {
  const { prayer_name, date } = req.body;
  if (!PRAYERS.includes(prayer_name)) return res.status(400).send("Unknown prayer.");
  if (!date) return res.status(400).send("Missing date.");

  try {
    const existing = await db.getResponse(req.user.id, prayer_name, date);
    if (!existing || existing.status !== "missed") {
      return res.status(400).send("Only missed prayers can be marked for qaḍā.");
    }
    await db.updateResponse(existing.id, { made_up_at: existing.made_up_at ? null : new Date().toISOString() });
    res.redirect("/dashboard");
  } catch (error) {
    console.error(`[prayer-qada] Error:`, error);
    res.status(500).send("Failed to update qaḍā status.");
  }
});

router.get("/admin", requireLogin, requireGroupAdmin, async (req, res) => {
  const group = req.group;
  const date = await localDateStrFor(req.user);

  const members = await db.getGroupMembers(group.id);

  const rows = await Promise.all(members.map(async (m) => {
    // Fast/qaḍā rows share the table but are personal — never surfaced in the
    // group admin views.
    const todayResponses = await db.getResponsesByUser(m.id);
    const todayResponsesFiltered = todayResponses.filter(r => r.date === date && PRAYERS.includes(r.prayer_name));
    const statusMap = {};
    todayResponsesFiltered.forEach((r) => (statusMap[r.prayer_name] = r.status));

    const allTimeResponses = await db.getResponsesByUser(m.id);
    const done = allTimeResponses.filter(r => r.status === 'done').length;
    const total = allTimeResponses.length;
    const pct = total > 0 ? Math.round((done / total) * 100) : null;

    return { member: m, statusMap, pct };
  }));

  // Per-prayer summary for today: how many of the group's members have
  // completed each prayer so far, out of the total member count.
  const prayerSummary = PRAYERS.map((p) => {
    const done = rows.filter((r) => r.statusMap[p] === "done").length;
    const missed = rows.filter((r) => r.statusMap[p] === "missed").length;
    return { name: p, done, missed, total: members.length };
  });

  res.render("admin", { group, rows, PRAYERS, date, memberCount: members.length, prayerSummary, user: req.user });
});

// Admin-only: inspect one member's full prayer history in detail.
router.get("/admin/member/:userId", requireLogin, requireGroupAdmin, async (req, res) => {
  const member = await db.getUserProfile(req.params.userId);
  if (!member || member.group_id !== req.group.id) {
    return res.status(404).send("Member not found in your group.");
  }

  const history = await db.getResponsesByUser(member.id);
  const prayerHistory = history.filter(r => PRAYERS.includes(r.prayer_name));
  const historyLimited = prayerHistory.slice(0, 100);

  const done = prayerHistory.filter(r => r.status === 'done').length;
  const missed = prayerHistory.filter(r => r.status === 'missed').length;
  const pending = prayerHistory.filter(r => r.status === 'pending').length;
  const total = prayerHistory.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : null;

  const totals = { done, missed, pending, total };

  res.render("admin_member", { group: req.group, member, history: historyLimited, totals, pct, user: req.user });
});

module.exports = router;
