const express = require("express");
const db = require("../db");
const { requireLogin, requireGroupAdmin } = require("../middleware/auth");
const { getOrFetchTodayTimes, getOrFetchTimesForDate, localDateStrFor, todayStr, computeNextPrayer, getQiblaInfo, getTahajjudWindow } = require("../services/prayerTimes");
const { REMINDERS, reminderOfTheDay } = require("../data/reminders");

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
        done: responses.filter((r) => r.date === d.date && r.status === "done").length,
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
  const todayResponsesFiltered = todayResponses.filter(r => r.date === date);
  const statusMap = {};
  const sourceMap = {};
  todayResponsesFiltered.forEach((r) => {
    statusMap[r.prayer_name] = r.status;
    sourceMap[r.prayer_name] = r.mark_source || null;
  });
  
  // Calculate completed prayers for progress indicator
  const completedCount = Object.values(statusMap).filter(status => status === 'done').length;

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
    today: date,
    isJummah,
    completedCount,
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

  const groupHistory = perMember
    .flatMap(({ member, responses }) =>
      responses.map((r) => ({ ...r, memberName: member.name }))
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
        done: responses.filter((r) => r.date === d.date && r.status === "done").length,
      }));
      const totalDone = days.reduce((s, x) => s + x.done, 0);
      return { member: { id: member.id, name: member.name }, days, totalDone };
    });
  }

  res.render("weekly", { user, group, memberCount, weekly, weekDates, isAdmin, today: date, PRAYERS });
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
  responses.filter((r) => r.date === date).forEach((r) => (statusMap[r.prayer_name] = r.status));

  res.render("times", { user, todayTimes, nextPrayer, tahajjud, apiError, statusMap, today: date, PRAYERS, isAdmin: false });
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

  if (!PRAYERS.includes(prayer_name)) return res.status(400).send("Unknown prayer.");
  if (!["done", "missed"].includes(status)) return res.status(400).send("Invalid status.");
  if (!date) return res.status(400).send("Missing date.");

  try {
    // Check if response already exists
    const existing = await db.getResponse(req.user.id, prayer_name, date);
    
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
        responded_at: new Date().toISOString()
      });
    }

    res.redirect("/dashboard");
  } catch (error) {
    console.error(`[prayer-mark] Error:`, error);
    res.status(500).send("Failed to mark prayer.");
  }
});

router.get("/admin", requireLogin, requireGroupAdmin, async (req, res) => {
  const group = req.group;
  const date = await localDateStrFor(req.user);

  const members = await db.getGroupMembers(group.id);

  const rows = await Promise.all(members.map(async (m) => {
    const todayResponses = await db.getResponsesByUser(m.id);
    const todayResponsesFiltered = todayResponses.filter(r => r.date === date);
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
  const historyLimited = history.slice(0, 100);

  const done = history.filter(r => r.status === 'done').length;
  const missed = history.filter(r => r.status === 'missed').length;
  const pending = history.filter(r => r.status === 'pending').length;
  const total = history.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : null;

  const totals = { done, missed, pending, total };

  res.render("admin_member", { group: req.group, member, history: historyLimited, totals, pct, user: req.user });
});

module.exports = router;
