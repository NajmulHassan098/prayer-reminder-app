// Tasbeeh (dhikr counter) page + account sync.
//
// The counter itself lives entirely in the browser (localStorage via
// public/tasbeeh-core.js) so it is instant and offline-friendly. This route
// only (a) renders the page and (b) keeps a debounced copy of the count and
// settings in user_profiles.settings (migration 0006) so a cleared cache or
// new device can restore it — "restored from your account".
const express = require("express");
const db = require("../db");
const { requireLogin } = require("../middleware/auth");
const { parseSettings } = require("../utils/settings");

const router = express.Router();

router.get("/tasbeeh", requireLogin, (req, res) => {
  const settings = parseSettings(req.user.settings);
  res.render("tasbeeh", {
    user: req.user,
    serverTasbeeh: settings.tasbeeh,
    isAdmin: false,
  });
});

// Body carries the same fields as settings.tasbeeh (count arrives as
// lastCount). Everything is clamped by parseSettings, never rejected — a
// slightly-off value from a race is repaired, not bounced.
router.post("/tasbeeh/sync", requireLogin, async (req, res) => {
  try {
    const body = req.body || {};
    const current = parseSettings(req.user.settings);
    const incoming = parseSettings({
      tasbeeh: {
        target: body.target,
        dhikr: body.dhikr,
        customDhikr: body.customDhikr,
        sound: body.sound,
        haptics: body.haptics,
        lastCount: body.lastCount != null ? body.lastCount : body.count,
      },
    });
    const settings = {
      calendar: current.calendar,
      tasbeeh: incoming.tasbeeh,
    };
    await db.updateUserProfile(req.user.id, { settings });
    res.json({ ok: true });
  } catch (error) {
    console.error("[tasbeeh] sync failed:", error.message);
    res.status(500).json({ error: "Could not save just now — your count is safe on this device." });
  }
});

module.exports = router;
