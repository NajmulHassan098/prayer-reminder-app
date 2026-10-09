// One-off maintenance: clear every user's cached prayer times from today onward
// so they are re-fetched with the corrected, country-based calculation method.
//
// Why this is needed: prayer times are cached per (user, date) and only fetched
// when missing. After switching from a single global method (Karachi) to a
// per-country method, each user's ALREADY-CACHED rows for today still hold the
// old times, and the daily scheduler will not overwrite them. Deleting today's
// and future rows forces a fresh fetch on the next dashboard load / scheduler
// tick. Past rows are left untouched as history.
//
// Usage:  node scripts/refresh-prayer-times.js   (or: npm run refresh-times)
require("dotenv").config();
const db = require("../src/db");
const { todayStr } = require("../src/services/prayerTimes");

async function main() {
  const from = todayStr();
  console.log(`[refresh-prayer-times] Clearing cached prayer times with date >= ${from} for all users...`);
  // Passing a null userId makes the helper clear the range for every user.
  await db.deletePrayerTimesFrom(null, from);
  console.log("[refresh-prayer-times] Done. Times will be re-fetched per user on next dashboard load or scheduler tick.");
}

main().catch((err) => {
  console.error("[refresh-prayer-times] Failed:", err);
  process.exit(1);
});
