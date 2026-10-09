// Islamic (Hijri) calendar page — a monthly grid pairing each Gregorian day
// with the Hijri date for the user's own city, plus curated Sunni/Shia/Shared
// events (src/data/hijri-events.json). Tradition filter and the ±1-day
// moon-sighting adjustment persist in user_profiles.settings (migration 0006).
//
// Route naming: /calendar is the .ics *subscription* page; this is the
// browsable Islamic calendar at /hijri.
const express = require("express");
const moment = require("moment-timezone");
const db = require("../db");
const { requireLogin } = require("../middleware/auth");
const { resolveUserTimezone } = require("../services/prayerTimes");
const { getMonthHijri } = require("../services/hijriCalendar");
const { monthGrid } = require("../utils/hijri");
const { parseSettings, TRADITIONS } = require("../utils/settings");

const router = express.Router();

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// ?m=YYYY-MM, strict; anything malformed → the user's current month.
function parseMonthParam(raw, userTz) {
  const m = /^(\d{4})-(\d{2})$/.exec(raw || "");
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]);
    if (y >= 1900 && y <= 2100 && mo >= 1 && mo <= 12) return { year: y, month: mo };
  }
  const now = userTz ? moment.tz(userTz) : moment();
  return { year: now.year(), month: now.month() + 1 };
}

router.get("/hijri", requireLogin, async (req, res) => {
  const user = req.user;
  const settings = parseSettings(user.settings);
  // Query overrides let links share a view ("show me the Shia calendar");
  // the saved preference is what the controls POST and what loads by default.
  let tradition = settings.calendar.tradition;
  if (TRADITIONS.includes(req.query.tradition)) tradition = req.query.tradition;
  let dayAdjust = settings.calendar.dayAdjust;
  if (["-1", "0", "1"].includes(String(req.query.adjust))) dayAdjust = Number(req.query.adjust);

  const tz = await resolveUserTimezone(user).catch(() => null);
  const { year, month } = parseMonthParam(req.query.m, tz);
  const today = (tz ? moment.tz(tz) : moment()).format("YYYY-MM-DD");

  const cells = await getMonthHijri(user, year, month);
  const grid = monthGrid(cells, { tradition, dayAdjust });

  const prev = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };

  res.render("hijri", {
    user,
    isAdmin: false,
    monthLabel: `${MONTH_NAMES[month - 1]} ${year}`,
    monthParam: `${year}-${String(month).padStart(2, "0")}`,
    prevParam: `${prev.year}-${String(prev.month).padStart(2, "0")}`,
    nextParam: `${next.year}-${String(next.month).padStart(2, "0")}`,
    weeks: grid.weeks,
    hijriRange: grid.hijriRange,
    hasCalculated: grid.hasCalculated,
    eventDays: grid.eventDays,
    today,
    tradition,
    dayAdjust,
  });
});

// Persist the tradition filter / moon-sighting adjustment. Merges into the
// existing settings blob so the tasbeeh section is never clobbered.
router.post("/hijri/prefs", requireLogin, async (req, res) => {
  try {
    const body = req.body || {};
    const current = parseSettings(req.user.settings);
    const incoming = parseSettings({
      calendar: {
        tradition: body.tradition !== undefined ? body.tradition : current.calendar.tradition,
        dayAdjust: body.dayAdjust !== undefined ? body.dayAdjust : current.calendar.dayAdjust,
      },
    });
    const settings = { calendar: incoming.calendar, tasbeeh: current.tasbeeh };
    await db.updateUserProfile(req.user.id, { settings });
    res.json({ ok: true, calendar: settings.calendar });
  } catch (error) {
    console.error("[hijri] prefs save failed:", error.message);
    res.status(500).json({ error: "Could not save that preference just now." });
  }
});

module.exports = router;
