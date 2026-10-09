require("dotenv").config();
const path = require("path");
const express = require("express");
const session = require("express-session");

const authRoutes = require("./routes/auth");
const groupRoutes = require("./routes/group");
const dashboardRoutes = require("./routes/dashboard");
const responseRoutes = require("./routes/response");
const profileRoutes = require("./routes/profile");
const calendarRoutes = require("./routes/calendar");
const tasbeehRoutes = require("./routes/tasbeeh");
const hijriRoutes = require("./routes/hijri");
const scheduler = require("./services/scheduler");
const { SupabaseSessionStore } = require("./sessionStore");
const { supabaseAdmin } = require("./supabase");

const app = express();

// Vercel terminates TLS at its edge, so req.secure/req.ip are wrong without
// this. Trusting the proxy lets express-session set Secure cookies correctly
// over HTTPS (otherwise the browser silently drops the session cookie and you
// get logged out immediately after logging in).
app.set("trust proxy", 1);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // Add JSON parsing for API routes
app.use(express.static(path.join(__dirname, "..", "public")));

// Sessions are stored in Supabase (see src/sessionStore.js) instead of in RAM,
// so they survive serverless cold starts and redeploys on Vercel. On a purely
// local run we fall back to the memory store to avoid needing the DB.
const MemoryStore = require("memorystore")(session);
const sessionStore = process.env.VERCEL
  ? new SupabaseSessionStore({ client: supabaseAdmin })
  : new MemoryStore({ checkPeriod: 86400000 });

app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev_secret_change_me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
      secure: process.env.VERCEL ? true : false, // HTTPS-only cookie in production
      sameSite: "lax",
      httpOnly: true,
    },
    store: sessionStore
  })
);

app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  next();
});

// Secured cron job endpoint for production deployment
// This allows external cron services (Vercel Cron, GitHub Actions, etc.) to trigger prayer scheduling.
//
// The in-process node-cron path used to exist in scheduler.start() and was
// called from server startup below. It has been removed because on Vercel each
// HTTP invocation is a short-lived function; the 5-minute timer never got a
// chance to fire before the invocation returned, so reminders appeared to work
// locally and silently did nothing in production. Ops should now use the
// GET /api/health endpoint (see below) to prove the external trigger actually
// reaches the scheduler.
app.post("/api/cron/prayer-scheduler", async (req, res) => {
  const CRON_SECRET = process.env.CRON_SECRET;

  // Verify the request is authorized
  const authHeader = req.headers.authorization;
  const providedSecret = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  // Log the raw hit before the auth decision so ops can see whether the
  // endpoint is being reached at all (GitHub Action failing to fire vs. firing
  // with the wrong secret look identical from a 401 alone).
  const ua = (req.headers['user-agent'] || '').slice(0, 60);
  console.log(`[cron] hit ua="${ua}" hasAuthHeader=${!!authHeader} hasSecretConfigured=${!!CRON_SECRET}`);

  if (!CRON_SECRET || providedSecret !== CRON_SECRET) {
    console.error('[cron] Unauthorized access attempt to prayer scheduler endpoint');
    return res.status(401).json({
      success: false,
      error: 'Unauthorized'
    });
  }

  try {
    console.log('[cron] Authorized prayer scheduler tick triggered');
    await scheduler.tick();
    res.json({
      success: true,
      message: 'Prayer scheduler executed successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[cron] Prayer scheduler execution failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health endpoint. Unauthenticated on purpose: it is the ONLY way to prove to
// ops (and to the GitHub Action itself, right after it posts the tick) that
// the scheduler is actually firing in production. Response shape is small and
// does not leak anything sensitive — just booleans and a heartbeat age.
app.get("/api/health", async (req, res) => {
  let scheduler = { present: false };
  try {
    const hb = await require("./db").getCronHeartbeat();
    if (hb) {
      const now = Date.now();
      const lastStartMs = hb.last_started_at ? new Date(hb.last_started_at).getTime() : null;
      scheduler = {
        present: true,
        lastTickAt: hb.last_started_at,
        lastFinishedAt: hb.last_finished_at,
        lastError: hb.last_error || null,
        usersSeen: hb.users_seen,
        emailsSent: hb.emails_sent,
        emailsSkippedStale: hb.emails_skipped_stale,
        dryRun: !!hb.dry_run,
        staleFor: lastStartMs ? Math.round((now - lastStartMs) / 1000) : null,
      };
    }
  } catch (err) {
    scheduler = { present: false, error: err.message };
  }
  const envFlags = {
    hasSmtp: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
    hasEmailFrom: !!process.env.EMAIL_FROM,
    hasCronSecret: !!process.env.CRON_SECRET,
    hasSupabaseUrl: !!process.env.SUPABASE_URL,
    hasSupabaseServiceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    hasSessionSecret: !!process.env.SESSION_SECRET,
    vercel: !!process.env.VERCEL,
  };
  // `ok` is intentionally only about the *endpoint* being up. Ops decides
  // freshness from `scheduler.staleFor`. Anything that could crash health
  // itself already lives inside the try, so we always return 200.
  res.json({
    ok: true,
    scheduler,
    env: envFlags,
    emailMode: (process.env.SCHEDULER_DRY_RUN === 'true' || process.env.SCHEDULER_DRY_RUN === '1') ? 'dryrun' : 'live',
  });
});

app.use(dashboardRoutes);
app.use(authRoutes);
app.use(groupRoutes);
app.use(responseRoutes);
app.use(profileRoutes);
app.use(calendarRoutes);
app.use(tasbeehRoutes);
app.use(hijriRoutes);

app.use((req, res) => res.status(404).send("Not found"));

// Export for Vercel
module.exports = app;

// Only start the server if not running in Vercel
if (!process.env.VERCEL) {
  let PORT = parseInt(process.env.PORT || "3000", 10);
  
  const startServer = (port) => {
    const server = app.listen(port, () => {
      console.log(`Prayer Reminder App running at http://localhost:${port}`);
      // The scheduler NEVER self-runs in-process. Serverless hosts (Vercel)
      // short-circuit the process before the timer can fire, and long-running
      // hosts (local dev) should not compete with the external HTTP trigger.
      // Manual tick: `npm run tick-once`. Production cadence: GitHub Action or
      // Vercel Cron hitting POST /api/cron/prayer-scheduler every 5 minutes.
      console.log('[scheduler] external trigger required (POST /api/cron/prayer-scheduler) — run `npm run tick-once` for a manual tick');
    });

    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        console.log(`Port ${port} is in use, trying ${port + 1}...`);
        startServer(port + 1);
      } else {
        console.error(e);
      }
    });
  };

  startServer(PORT);
}
