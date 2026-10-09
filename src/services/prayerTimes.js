const axios = require("axios");
const moment = require("moment-timezone");
const db = require("../db");
// Service-role client: profile queries here run outside a user session and must
// bypass RLS (the anon key returns zero rows under RLS).
const { supabaseAdmin: supabase } = require("../supabase");

const METHOD = Number(process.env.PRAYER_CALC_METHOD) || 1;
const PRAYERS = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];

// Aladhan calculation-method ids. Only Fajr and Isha depend on the method (they
// are derived from the sun's twilight angles); Dhuhr/Asr/Maghrib are purely
// astronomical and are identical for every method. Using a single global method
// therefore gives wrong Fajr/Isha for anyone outside that method's region of
// origin. We pick the method from the user's country and fall back to
// PRAYER_CALC_METHOD for countries we don't map explicitly.
//   1  = University of Islamic Sciences, Karachi (South Asia)
//   2  = Islamic Society of North America (ISNA)
//   3  = Muslim World League (international / Europe default)
//   4  = Umm Al-Qura University, Makkah (Saudi Arabia / Gulf)
//   5  = Egyptian General Authority of Survey (Egypt, Levant, much of Africa)
//   7  = Institute of Geophysics, University of Tehran (Iran)
//   12 = Union des Organisations Islamiques de France (France)
//   13 = Diyanet İşleri Başkanlığı, Turkey
const COUNTRY_METHOD = {
  // Karachi — South Asia & a few countries that follow its convention
  pakistan: 1, india: 1, bangladesh: 1, srilanka: 1, "sri lanka": 1, nepal: 1,
  afghanistan: 1, maldives: 1, "south africa": 1, uzbekistan: 1, turkmenistan: 1,
  tajikistan: 1, kyrgyzstan: 1, kazakhstan: 1, azerbaijan: 1,
  // ISNA — North America
  usa: 2, us: 2, america: 2, "united states": 2, "united states of america": 2,
  canada: 2, mexico: 2,
  // Umm Al-Qura — Saudi Arabia & the Gulf
  "saudi arabia": 4, saudi: 4, uae: 4, "united arab emirates": 4, qatar: 4,
  kuwait: 4, bahrain: 4, oman: 4, yemen: 4,
  // Diyanet — Turkey
  turkey: 13, türkiye: 13,
  // Egyptian — Egypt, the Levant and much of Africa
  egypt: 5, sudan: 5, libya: 5, tunisia: 5, algeria: 5, morocco: 5, somalia: 5,
  jordan: 5, palestine: 5, israel: 5, lebanon: 5, syria: 5, iraq: 5,
  nigeria: 5, mali: 5, niger: 5, chad: 5, djibouti: 5, comoros: 5,
  // Tehran — Iran
  iran: 7,
  // France
  france: 12,
  // MWL — UK, Ireland and most of Europe (neutral international standard)
  uk: 3, "u.k.": 3, "united kingdom": 3, britain: 3, england: 3, ireland: 3,
  germany: 3, netherlands: 3, holland: 3, belgium: 3, spain: 3, italy: 3,
  portugal: 3, sweden: 3, norway: 3, denmark: 3, finland: 3, poland: 3,
  austria: 3, switzerland: 3, greece: 3, romania: 3, bulgaria: 3,
  "czech republic": 3, czechia: 3, hungary: 3, ukraine: 3, belarus: 3,
  russia: 3, indonesia: 3, malaysia: 3, singapore: 3, brunei: 3,
  thailand: 3, philippines: 3, australia: 3, "new zealand": 3, japan: 3,
  china: 3, korea: 3, "south korea": 3,
};

/**
 * Resolve the Aladhan calculation-method id to use for a given country.
 * Falls back to the PRAYER_CALC_METHOD env value (default 1 / Karachi) for
 * countries we don't have in the map, so an operator can still override globally.
 */
function resolveCalcMethod(country) {
  if (country) {
    const key = String(country).trim().toLowerCase();
    if (COUNTRY_METHOD[key]) return COUNTRY_METHOD[key];
  }
  return METHOD;
}

/**
 * Calls the free Aladhan API to get today's 5 prayer times for a city/country.
 * Docs: https://aladhan.com/prayer-times-api
 */
async function fetchTimesFromApi(city, country, date) {
  // date format required by Aladhan: DD-MM-YYYY
  const [yyyy, mm, dd] = date.split("-");
  const dateStr = `${dd}-${mm}-${yyyy}`;

  const url = `https://api.aladhan.com/v1/timingsByCity/${dateStr}`;
  const res = await axios.get(url, {
    params: { city, country, method: resolveCalcMethod(country) },
    timeout: 10000,
  });

  if (!res.data || res.data.code !== 200) {
    throw new Error("Aladhan API did not return a valid response");
  }

  const timings = res.data.data.timings;
  const timezone = res.data.data.meta.timezone;

  // Timings come back like "05:12 (PKT)" sometimes — strip anything after a space.
  const clean = (t) => (t || "").split(" ")[0];

  return {
    timezone,
    fajr: clean(timings.Fajr),
    dhuhr: clean(timings.Dhuhr),
    asr: clean(timings.Asr),
    maghrib: clean(timings.Maghrib),
    isha: clean(timings.Isha),
  };
}

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC calendar date)
}

function tomorrowStr() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve a user's IANA timezone. We read it from an already-cached prayer_times
 * row when possible (checking today / tomorrow / yesterday in UTC), and otherwise
 * make a single API call purely to read `meta.timezone` — that value is correct
 * for the city regardless of which calendar date we requested, so it bootstraps
 * the very first lookup for a brand-new or newly-relocated user.
 */
async function resolveUserTimezone(user) {
  const base = new Date();
  for (const delta of [0, 1, -1]) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + delta);
    const row = await db.getPrayerTime(user.id, d.toISOString().slice(0, 10));
    if (row && row.timezone) return row.timezone;
  }
  if (!user.city || !user.country) return null;
  try {
    const t = await fetchTimesFromApi(user.city, user.country, todayStr());
    return t && t.timezone ? t.timezone : null;
  } catch (err) {
    return null;
  }
}

/**
 * The user's current (or offset) LOCAL calendar date as YYYY-MM-DD. All
 * reminder/follow-up timing, the countdown, and the dashboard "today" MUST use
 * this instead of the UTC date: the two differ for the hours where the local
 * calendar day leads/lags UTC — e.g. Fajr before ~05:00 in Pakistan (UTC+5) or
 * Isha after ~19:00 in North America (UTC-5). Using UTC there selects the wrong
 * day's times, which is what made before/after emails fire on the wrong day.
 */
async function localDateStrFor(user, offsetDays = 0) {
  const tz = await resolveUserTimezone(user);
  if (!tz) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  }
  return moment.tz(tz).add(offsetDays, "days").format("YYYY-MM-DD");
}

/**
 * Fetches (if missing) and returns prayer times for a user on a given date,
 * caching in DB. Defaults to today. This is what keeps times auto-updating —
 * since Maghrib/Fajr shift a little every day, we never hardcode a time; we
 * always ask the API for the requested day and store it.
 */
async function getOrFetchTimesForDate(user, date) {
  const existing = await db.getPrayerTime(user.id, date);
  if (existing) return existing;

  if (!user.city || !user.country) return null;

  const times = await fetchTimesFromApi(user.city, user.country, date);

  await db.createPrayerTime({
    user_id: user.id,
    date: date,
    timezone: times.timezone,
    fajr: times.fajr,
    dhuhr: times.dhuhr,
    asr: times.asr,
    maghrib: times.maghrib,
    isha: times.isha,
    fetched_at: new Date().toISOString()
  });

  return await db.getPrayerTime(user.id, date);
}

/**
 * Fetches (if missing) and returns today's prayer times for a user, caching in DB.
 * "Today" is the user's LOCAL calendar day, not UTC.
 */
async function getOrFetchTodayTimes(user) {
  return getOrFetchTimesForDate(user, await localDateStrFor(user));
}

/**
 * Works out which prayer is next for this user, and exactly when it falls,
 * using their own city's timezone. If every prayer for today has already
 * passed, it rolls over to tomorrow's Fajr instead.
 * Returns { name, atUTC: Date, isTomorrow: boolean } or null if unavailable.
 */
async function computeNextPrayer(user) {
  const tz = await resolveUserTimezone(user);
  const todayDate = tz ? moment.tz(tz).format("YYYY-MM-DD") : todayStr();
  const tomorrowDate = tz ? moment.tz(tz).add(1, "days").format("YYYY-MM-DD") : tomorrowStr();

  const todayRow = await getOrFetchTimesForDate(user, todayDate);
  if (!todayRow || !todayRow.timezone) return null;

  const now = moment.utc();

  let prevMoment = null; // most recent prayer that has already passed today
  for (const prayerName of PRAYERS) {
    const timeStr = todayRow[prayerName.toLowerCase()];
    if (!timeStr) continue;
    const prayerMoment = moment.tz(`${todayRow.date} ${timeStr}`, "YYYY-MM-DD HH:mm", todayRow.timezone);
    if (!prayerMoment.isValid()) continue;
    if (prayerMoment.isAfter(now)) {
      return {
        name: prayerName,
        atUTC: prayerMoment.utc().toDate(),
        isTomorrow: false,
        prevAtUTC: prevMoment ? prevMoment.utc().toDate() : null,
      };
    }
    prevMoment = prayerMoment;
  }

  // Every prayer today has passed — fall back to tomorrow's Fajr.
  try {
    const tomorrowRow = await getOrFetchTimesForDate(user, tomorrowDate);
    if (tomorrowRow && tomorrowRow.fajr && tomorrowRow.timezone) {
      const fajrMoment = moment.tz(
        `${tomorrowRow.date} ${tomorrowRow.fajr}`,
        "YYYY-MM-DD HH:mm",
        tomorrowRow.timezone
      );
      if (fajrMoment.isValid()) {
        return {
          name: "Fajr",
          atUTC: fajrMoment.utc().toDate(),
          isTomorrow: true,
          prevAtUTC: prevMoment ? prevMoment.utc().toDate() : null,
        };
      }
    }
  } catch (err) {
    // If tomorrow's times can't be fetched, just skip the countdown rather than error out.
  }
  return null;
}

/**
 * Refreshes today's prayer times for every user who has a city set.
 * Intended to be called once a day by the scheduler, and also works
 * fine to call more often since it's cached per (user, date).
 */
async function refreshAllUsersToday() {
  // Get all users with city and country set
  // Since we're using Supabase, we need to query differently
  const { data: profiles, error } = await supabase
    .from('user_profiles')
    .select('*')
    .not('city', 'is', null)
    .not('country', 'is', null);
  
  if (error) {
    console.error('[refreshAllUsersToday] Error fetching users:', error);
    return [];
  }

  const results = [];
  for (const user of profiles) {
    try {
      const times = await getOrFetchTodayTimes(user);
      results.push({ user_id: user.id, ok: true, times });
    } catch (err) {
      results.push({ user_id: user.id, ok: false, error: err.message });
    }
  }
  return results;
}

/**
 * Tonight's Tahajjud window = the last third of the night, measured from
 * Maghrib (today) to true Fajr (tomorrow) in the user's own timezone. Returns
 * { start, end, startLabel, endLabel } as HH:MM / h:mm A strings, or null when
 * it can't be computed (no location / times unavailable).
 */
async function getTahajjudWindow(user) {
  const tz = await resolveUserTimezone(user);
  if (!tz || !user.city || !user.country) return null;
  const today = moment.tz(tz).format("YYYY-MM-DD");
  const tomorrow = moment.tz(tz).add(1, "days").format("YYYY-MM-DD");
  const todayRow = await getOrFetchTimesForDate(user, today);
  const tomorrowRow = await getOrFetchTimesForDate(user, tomorrow);
  if (!todayRow || !tomorrowRow || !todayRow.maghrib || !tomorrowRow.fajr) return null;

  const maghrib = moment.tz(`${todayRow.date} ${todayRow.maghrib}`, "YYYY-MM-DD HH:mm", tz);
  const fajr = moment.tz(`${tomorrowRow.date} ${tomorrowRow.fajr}`, "YYYY-MM-DD HH:mm", tz);
  if (!maghrib.isValid() || !fajr.isValid()) return null;

  const nightMin = fajr.diff(maghrib, "minutes");
  const start = maghrib.clone().add(Math.round((nightMin * 2) / 3), "minutes");
  return {
    start: start.format("HH:mm"),
    end: fajr.format("HH:mm"),
    startLabel: start.format("h:mm A"),
    endLabel: fajr.format("h:mm A"),
  };
}

// ---- Qibla ---------------------------------------------------------------
// Coordinates of the Kaaba (Masjid al-Haram, Makkah).
const KAABA = { lat: 21.4224779, lng: 39.8251832 };
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

// Great-circle initial bearing from a point to the Kaaba, degrees clockwise
// from true North. This is the standard spherical formula used by prayer apps.
function qiblaBearing(lat1, lng1) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(KAABA.lat);
  const dLambda = toRad(KAABA.lng - lng1);
  const y = Math.sin(dLambda);
  const x = Math.cos(phi1) * Math.tan(phi2) - Math.sin(phi1) * Math.cos(dLambda);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lng2 - lng1);
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLambda / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Resolve a city's real coordinates via OpenStreetMap Nominatim and compute the
 * Qibla bearing + great-circle distance to the Kaaba. (Aladhan's timingsByCity
 * only returns placeholder lat/lng, so it can't be used for direction.) Returns
 * null if the location can't be geocoded.
 *
 * Nominatim's usage policy requires an identifying User-Agent — keep the URL
 * contact below accurate for production traffic.
 */
async function getQiblaInfo(city, country) {
  if (!city || !country) return null;
  const res = await axios.get("https://nominatim.openstreetmap.org/search", {
    params: { q: `${city}, ${country}`, format: "jsonv2", limit: 1 },
    headers: { "User-Agent": "PrayerReminderApp/1.0 (https://prayer-app-sepia.vercel.app)" },
    timeout: 10000,
  });
  const hit = res.data && res.data[0];
  if (!hit || hit.lat == null || hit.lon == null) return null;
  const lat = Number(hit.lat);
  const lng = Number(hit.lon);
  return {
    city,
    country,
    lat,
    lng,
    direction: qiblaBearing(lat, lng),
    distanceKm: Math.round(haversineKm(lat, lng, KAABA.lat, KAABA.lng)),
  };
}

module.exports = {
  fetchTimesFromApi,
  resolveCalcMethod,
  resolveUserTimezone,
  localDateStrFor,
  getOrFetchTodayTimes,
  getOrFetchTimesForDate,
  refreshAllUsersToday,
  computeNextPrayer,
  getQiblaInfo,
  getTahajjudWindow,
  todayStr,
  tomorrowStr,
};
