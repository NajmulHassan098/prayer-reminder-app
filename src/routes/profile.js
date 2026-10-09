const express = require("express");
const db = require("../db");
const { requireLogin } = require("../middleware/auth");
const { supabaseAdmin } = require("../supabase");
const { resolveCalcMethod, todayStr, reverseGeocode, fetchTimesFromApi, resolveLocaleFromCountry } = require("../services/prayerTimes");
const { SUPPORTED, resolveLocale } = require("../utils/i18n");

// Human labels for the language selector. "auto" (empty value) means: detect
// from country, else English — so a user in a mapped country inherits the local
// language without us hard-coding it into their profile row.
const LANGUAGES = [
  { code: "", label: "Auto (from my country)" },
  { code: "en", label: "English" },
  { code: "ur", label: "اردو (Urdu)" },
  { code: "tr", label: "Türkçe (Turkish)" },
  { code: "ar", label: "العربية (Arabic)" },
  { code: "id", label: "Bahasa Indonesia" },
];

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
  res.render("profile", {
    user,
    method,
    error: null,
    saved: false,
    languages: LANGUAGES,
    currentLocale: user.locale || "",
    effectiveLocale: resolveLocale(user, resolveLocaleFromCountry),
  });
});

router.post("/profile", requireLogin, async (req, res) => {
  const user = req.user;
  const name = (req.body.name || "").trim();
  const city = (req.body.city || "").trim();
  const country = (req.body.country || "").trim();
  // Empty/"auto" clears the explicit choice (back to country detection); any
  // other value must be a supported locale or we ignore it (leave choice as-is).
  const rawLang = (req.body.language || "").trim();
  const locale = rawLang === "" ? null : (SUPPORTED.includes(rawLang) ? rawLang : undefined);

  const fail = (msg) =>
    res.status(400).render("profile", {
      user: { ...user, name, city, country },
      method: methodLabelFor(country),
      error: msg,
      saved: false,
      languages: LANGUAGES,
      currentLocale: rawLang,
      effectiveLocale: resolveLocale({ ...user, locale: locale === undefined ? user.locale : locale }, resolveLocaleFromCountry),
    });

  if (!name) return fail("Please enter your name.");
  if (!city || !country) return fail("City and country are required for accurate prayer times.");

  const locationChanged =
    city.toLowerCase() !== (user.city || "").toLowerCase() ||
    country.toLowerCase() !== (user.country || "").toLowerCase();

  try {
    // 1) Update the app's own profile row (source of truth for the dashboard).
    const profileUpdates = { name, city, country };
    if (locale !== undefined) profileUpdates.locale = locale;
    await db.updateUserProfile(user.id, profileUpdates);

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
      languages: LANGUAGES,
      currentLocale: locale === undefined ? (user.locale || "") : (locale || ""),
      effectiveLocale: resolveLocale({ ...user, locale: locale === undefined ? user.locale : locale }, resolveLocaleFromCountry),
    });
  } catch (error) {
    console.error("[profile] Error updating profile:", error);
    return fail("We couldn't save your changes. Please try again.");
  }
});

// Auto-location: the browser sends coordinates (user-initiated), we
// reverse-geocode them via Nominatim, prove the pair resolves to real prayer
// times with one trial fetch, and only then save — this eliminates the #1
// wrong-times support case (a mistyped city). JSON endpoint; the page reloads
// on success.
router.post("/profile/locate", requireLogin, async (req, res) => {
  const user = req.user;
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  const accuracy = Number(req.body.accuracy);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: "That location reading doesn't look valid. Please try again or type your city below." });
  }
  // VPN / cell-tower / city-level IP lookups can be tens or hundreds of km off.
  // Ask before saving something that wrong; the user can still do it manually.
  if (Number.isFinite(accuracy) && accuracy > 50000) {
    return res.status(400).json({ error: "Your location signal is rough right now (±" + Math.round(accuracy / 1000) + " km). Try near a window or on Wi-Fi, or enter your city below." });
  }

  let loc = null;
  try {
    loc = await reverseGeocode(lat, lng);
  } catch (err) {
    console.error("[locate] reverse geocode failed:", err.message);
    return res.status(502).json({ error: "Could not read your location just now — please try again or type your city below." });
  }
  if (!loc) {
    return res.status(422).json({ error: "We couldn't map those coordinates to a city. Please type your city and country below instead." });
  }

  // Prove Aladhan knows this city/country BEFORE saving it — otherwise a
  // successful-looking save leaves the user with no times at all.
  try {
    const t = await fetchTimesFromApi(loc.city, loc.country, todayStr());
    if (!t || !t.fajr) throw new Error("empty");
  } catch (err) {
    console.warn("[locate] trial fetch failed for", loc.city, loc.country, err.message);
    return res.status(422).json({ error: `We found “${loc.city}, ${loc.country}” but can't get prayer times for it yet. Please type the city name you usually use below.` });
  }

  const locationChanged =
    loc.city.toLowerCase() !== (user.city || "").toLowerCase() ||
    loc.country.toLowerCase() !== (user.country || "").toLowerCase();

  await db.updateUserProfile(user.id, { city: loc.city, country: loc.country });
  try {
    await supabaseAdmin.auth.admin.updateUserById(user.id, {
      data: { name: user.name, city: loc.city, country: loc.country },
    });
  } catch (metaErr) {
    console.error("[locate] auth metadata sync failed:", metaErr.message);
  }
  if (locationChanged) {
    await db.deletePrayerTimesFrom(user.id, todayStr());
  }

  const method = methodLabelFor(loc.country);
  res.json({ ok: true, city: loc.city, country: loc.country, methodName: method.name });
});

const PRAYERS = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];

// Normalize a stored prefs blob into a full shape for the form. The original
// five-prayer switches default missing keys to ENABLED (historical behavior);
// the newer seasonal features (Ayyam al-Biḍʿ, Ramadan) default OFF — a feature
// that emails more than the established two-per-prayer must be asked for.
function parsePrefs(raw) {
  const p = raw || {};
  const prayers = p.prayers || {};
  const ram = p.ramadan || {};
  return {
    prayers: PRAYERS.reduce((acc, n) => { acc[n] = prayers[n] !== false; return acc; }, {}),
    pre: p.pre !== false,
    post: p.post !== false,
    sunnahFast: p.sunnahFast === true,
    ramadan: {
      enabled: ram.enabled === true,
      suhoor: ram.suhoor !== false,
      iftar: ram.iftar !== false,
      taraweeh: ram.taraweeh !== false,
    },
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
  const notification_prefs = {
    prayers,
    pre,
    post,
    sunnahFast: body.sunnah_fast === "on",
    ramadan: {
      enabled: body.ramadan_enabled === "on",
      suhoor: body.ramadan_suhoor === "on",
      iftar: body.ramadan_iftar === "on",
      taraweeh: body.ramadan_taraweeh === "on",
    },
  };

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
