const express = require("express");
const db = require("../db");
const { requireLogin } = require("../middleware/auth");
const { supabaseAdmin } = require("../supabase");
const { resolveCalcMethod, todayStr } = require("../services/prayerTimes");

const router = express.Router();

// Friendly names for the Aladhan calculation methods we map countries to, so the
// profile page can show the user *why* their Fajr/Isha are computed the way they are.
const METHOD_LABELS = {
  1: "University of Islamic Sciences, Karachi",
  2: "Islamic Society of North America (ISNA)",
  3: "Muslim World League (MWL)",
  4: "Umm Al-Qura University, Makkah",
  5: "Egyptian General Authority of Survey",
  7: "Institute of Geophysics, University of Tehran",
  12: "Union des Organisations Islamiques de France",
  13: "Diyanet İşleri Başkanlığı, Turkey",
};

function methodLabelFor(country) {
  const id = resolveCalcMethod(country);
  return { id, name: METHOD_LABELS[id] || `Method #${id}` };
}

router.get("/profile", requireLogin, async (req, res) => {
  const user = req.user;
  const method = methodLabelFor(user.country);
  res.render("profile", { user, method, error: null, saved: false });
});

router.post("/profile", requireLogin, async (req, res) => {
  const user = req.user;
  const name = (req.body.name || "").trim();
  const city = (req.body.city || "").trim();
  const country = (req.body.country || "").trim();

  const fail = (msg) =>
    res.status(400).render("profile", {
      user: { ...user, name, city, country },
      method: methodLabelFor(country),
      error: msg,
      saved: false,
    });

  if (!name) return fail("Please enter your name.");
  if (!city || !country) return fail("City and country are required for accurate prayer times.");

  const locationChanged =
    city.toLowerCase() !== (user.city || "").toLowerCase() ||
    country.toLowerCase() !== (user.country || "").toLowerCase();

  try {
    // 1) Update the app's own profile row (source of truth for the dashboard).
    await db.updateUserProfile(user.id, { name, city, country });

    // 2) Keep Supabase auth metadata in sync, so a rebuilt profile (login fallback)
    //    and any email templates that read metadata stay consistent. Non-fatal.
    try {
      await supabaseAdmin.auth.admin.updateUserById(user.id, {
        data: { name, city, country },
      });
    } catch (metaErr) {
      console.error("[profile] Could not update auth metadata:", metaErr.message);
    }

    // 3) If the location changed, today's cached times are now wrong (different
    //    city and possibly a different regional calculation method). Drop today
    //    and beyond so the next dashboard load / scheduler tick re-fetches them.
    if (locationChanged) {
      await db.deletePrayerTimesFrom(user.id, todayStr());
    }

    res.render("profile", {
      user: { ...user, name, city, country },
      method: methodLabelFor(country),
      error: null,
      saved: true,
    });
  } catch (error) {
    console.error("[profile] Error updating profile:", error);
    return fail("We couldn't save your changes. Please try again.");
  }
});

const PRAYERS = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];

// Normalize a stored prefs blob into a full shape for the form, defaulting every
// missing key to enabled so a user who never visited the page keeps all emails.
function parsePrefs(raw) {
  const p = raw || {};
  const prayers = p.prayers || {};
  return {
    prayers: PRAYERS.reduce((acc, n) => { acc[n] = prayers[n] !== false; return acc; }, {}),
    pre: p.pre !== false,
    post: p.post !== false,
  };
}

router.get("/notifications", requireLogin, (req, res) => {
  res.render("notifications", {
    user: req.user,
    prefs: parsePrefs(req.user.notification_prefs),
    isAdmin: false,
    saved: false,
    error: null,
  });
});

router.post("/notifications", requireLogin, async (req, res) => {
  const body = req.body || {};
  const prayers = {};
  PRAYERS.forEach((n) => { prayers[n] = body[`prayer_${n}`] === "on"; });
  const pre = body.pre === "on";
  const post = body.post === "on";
  const notification_prefs = { prayers, pre, post };

  try {
    await db.updateUserProfile(req.user.id, { notification_prefs });
    res.render("notifications", {
      user: { ...req.user, notification_prefs },
      prefs: parsePrefs(notification_prefs),
      isAdmin: false,
      saved: true,
      error: null,
    });
  } catch (error) {
    console.error("[notifications] save failed:", error);
    res.status(500).render("notifications", {
      user: req.user,
      prefs: parsePrefs(req.user.notification_prefs),
      isAdmin: false,
      saved: false,
      error:
        "We couldn't save your preferences right now. If this feature was just added, the database may still need its one-time update (see the deployment notes).",
    });
  }
});

module.exports = router;
