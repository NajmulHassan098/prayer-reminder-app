// Manually trigger one scheduler tick from the command line. Replaces the
// in-process node-cron path that used to live in scheduler.start() — that
// path was deleted because on Vercel each HTTP invocation returns long before
// the 5-minute timer could ever fire, so reminders silently stopped working
// in production.
//
// Usage:
//   node scripts/tick-once.js            one tick, real SMTP, exits when done
//   SCHEDULER_DRY_RUN=1 npm run tick-once  one tick, logs the emails it
//                                          WOULD have sent without touching
//                                          SMTP — safe on staging
//
// The tick is idempotent thanks to the atomic notifications_log claim, so
// running this manually after a scheduled tick has already fired is a no-op
// (every event is either already 'sent' or already 'skipped_stale').
require("dotenv").config();
const { tick } = require("../src/services/scheduler");

(async () => {
  const startedAt = new Date().toISOString();
  const dry = process.env.SCHEDULER_DRY_RUN === "true" || process.env.SCHEDULER_DRY_RUN === "1";
  console.log(`[tick-once] starting at ${startedAt} dry_run=${dry}`);
  try {
    await tick();
    console.log("[tick-once] done");
    process.exit(0);
  } catch (err) {
    console.error("[tick-once] FAILED:", err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
