// Personal prayer-times calendar feed (.ics).
//
// Users subscribe once with a signed, long-lived URL (no session — calendar
// clients can't log in) and receive the next 7 days of prayer times as events
// with a pre-prayer alarm matching PRE_REMINDER_MINUTES. Times come from the
// SAME cached `prayer_times` rows the dashboard and scheduler use, so the
// calendar can never disagree with the emails.
const express = require("express");
const db = require("../db");
const { requireLogin } = require("../middleware/auth");
const { getOrFetchTimesForDate, localDateStrFor } = require("../services/prayerTimes");
const { createCalendarToken, verifyCalendarToken } = require("../utils/token");
const { siteOrigin } = require("../utils/siteUrl");

const router = express.Router();
const PRAYERS = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];
const FEED_DAYS = 7;
const ALARM_MINUTES = Number(process.env.PRE_REMINDER_MINUTES || 30);

// --- ICS building helpers (pure; unit-testable) ----------------------------

function icsEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,");
}

// Fold content lines at ≤74 octets without splitting multi-byte UTF-8
// characters (RFC 5545 requirement; city names are often non-ASCII).
function foldLine(line) {
  if (line.length <= 74) return line;
  const out = [];
  let rest = line;
  let first = true;
  while (Buffer.byteLength(rest, "utf8") > (first ? 74 : 73)) {
    let cut = first ? 74 : 73;
    // Walk back until we're not mid-codepoint (continuation bytes are 10xxxxxx).
    while (cut > 0 && (rest.charCodeAt(cut) & 0xc0) === 0x80) cut--;
    // charCodeAt is UTF-16; re-encode the slice to respect the byte budget.
    let chunk = rest.slice(0, cut);
    while (Buffer.byteLength(chunk, "utf8") > (first ? 74 : 73) && chunk.length > 1) {
      chunk = chunk.slice(0, -1);
    }
    out.push(first ? chunk : " " + chunk);
    first = false;
    rest = rest.slice(chunk.length);
  }
  out.push(first ? rest : " " + rest);
  return out.join("\r\n");
}

function icsLocalTime(dateStr, hhmm) {
  return `${dateStr.replace(/-/g, "")}T${hhmm.replace(/:/g, "")}00`;
}

function plusOneMinute(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const t = (h * 60 + m + 1) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

// days: [{ date, timezone, city, times: { Fajr: "05:00", ... } }]
function buildICS(days, prodId = "-//Prayer Reminder//prayer-app//EN") {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${prodId}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Prayer Times",
  ];
  for (const day of days) {
    if (!day.times || !day.timezone) continue;
    for (const name of PRAYERS) {
      const time = day.times[name];
      if (!time) continue;
      lines.push(
        "BEGIN:VEVENT",
        `UID:${day.date}-${name.toLowerCase()}@prayer-app`,
        `DTSTAMP:${stamp}`,
        `DTSTART;TZID=${day.timezone}:${icsLocalTime(day.date, time)}`,
        `DTEND;TZID=${day.timezone}:${icsLocalTime(day.date, plusOneMinute(time))}`,
        `SUMMARY:${icsEscape(`${name} prayer`)}`,
        `DESCRIPTION:${icsEscape(`${name} in ${day.city || "your city"} — ${time}. May Allah accept it.`)}`,
        `LOCATION:${icsEscape(day.city || "")}`,
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `TRIGGER:-PT${ALARM_MINUTES}M`,
        `DESCRIPTION:${icsEscape(`Time to prepare for ${name}`)}`,
        "END:VALARM",
        "END:VEVENT"
      );
    }
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

// --- Routes -----------------------------------------------------------------

// Logged-in page: show the subscription URL + one-click links.
router.get("/calendar", requireLogin, async (req, res) => {
  const token = createCalendarToken(req.user.id);
  const url = `${siteOrigin()}/calendar.ics?token=${token}`;
  res.render("calendar", {
    user: req.user,
    url,
    googleUrl: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(url)}`,
    isAdmin: false,
  });
});

// The feed itself. Token-authenticated (calendar clients can't use sessions).
router.get("/calendar.ics", async (req, res) => {
  let userId;
  try {
    userId = verifyCalendarToken(req.query.token).userId;
  } catch {
    return res.status(401).send("Invalid or missing calendar token.");
  }
  const user = await db.getUserProfile(userId);
  if (!user) return res.status(404).send("User not found.");

  const days = [];
  for (let i = 0; i < FEED_DAYS; i++) {
    const date = await localDateStrFor(user, i);
    try {
      const row = await getOrFetchTimesForDate(user, date);
      days.push({
        date,
        timezone: row.timezone,
        city: user.city,
        times: { Fajr: row.fajr, Dhuhr: row.dhuhr, Asr: row.asr, Maghrib: row.maghrib, Isha: row.isha },
      });
    } catch {
      // A single day's fetch hiccup shouldn't poison the whole feed;
      // that day is simply missing until the client refreshes again.
      continue;
    }
  }
  if (!days.length) return res.status(503).send("Prayer times are not available right now.");

  res.set("Content-Type", "text/calendar; charset=utf-8");
  res.set("Content-Disposition", 'inline; filename="prayer-times.ics"');
  res.send(buildICS(days));
});

module.exports = router;
module.exports._test = { buildICS, foldLine, icsEscape, plusOneMinute };
