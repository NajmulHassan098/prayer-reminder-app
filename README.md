# Prayer Reminder App

A group-based prayer-time reminder and tracking app, deployed on **Vercel** with
**Supabase** (PostgreSQL + Auth) as the database and authentication backend.

- Users sign up with their **name, email, and city**. Each person can either
  **create a group** (becoming its admin) or **join one** via an emailed
  invitation link.
- Each group holds **up to 30 members**, and each user belongs to **at most one
  group at a time**.
- Prayer times are calculated **per person, based on their own city** (not shared
  per group) using the free [Aladhan API](https://aladhan.com/prayer-times-api).
  The app asks the API fresh for each day's times instead of storing a fixed
  time, so it **automatically follows the daily shift in sunrise/sunset** — nothing
  needs to be updated by hand.
- On a repeating schedule (every 5 minutes), a scheduler checks each user's own
  local prayer times and sends **two emails per prayer — one before, one after**:
  1. **Before the prayer:** a "time to prepare" reminder (default: 30 minutes
     ahead of the prayer time; each user can pick 5–120 on `/notifications`).
  2. **After the prayer:** a **"Did you get to pray?"** follow-up (default: 30
     minutes later, also per-user configurable) with signed **Yes / No** links.
     It is skipped automatically if the user already logged that prayer.
  3. Auto-marks a prayer **"missed"** if there's still no response after a set
     window (default: 2 hours, always cleared before the next prayer).
- **Admin dashboard**: the group creator sees every member's status for each of
  the 5 daily prayers, an all-time completion percentage, a per-prayer "today"
  summary (e.g. "Fajr: 8/12 completed"), and can invite or remove members or
  drill into any member's full history.
- **Member dashboard**: a **live countdown to the next prayer** (with a
  sundial-style progress ring) and **"✅ Prayed" / "❌ Not yet"** buttons so
  members can mark prayers directly in the app — not just via email links.

## Tech stack

- **Runtime / framework:** Node.js + Express (runs as a single Vercel serverless
  function).
- **Database & Auth:** Supabase (PostgreSQL + Supabase Auth). All SQL lives in
  [`supabase/schema.sql`](supabase/schema.sql).
- **Templates:** EJS.
- **Scheduling:** Vercel Cron (and/or a GitHub Action) calling a secured HTTP
  endpoint — see [Cron & reminders](#cron--reminders).
- **Email:** `nodemailer` over SMTP.
- **Timezones:** `moment-timezone` for accurate per-city math.

## How it works on Vercel (serverless) — important

Vercel runs the app as **stateless serverless functions** that can cold-start on
any request. Two consequences are already handled in this codebase:

1. **Sessions are stored in Supabase, not in memory.**
   Login state lives in a `sessions` table (see
   [`src/sessionStore.js`](src/sessionStore.js)). If sessions were kept in RAM
   (the old `memorystore` approach), a user would be logged out or error every
   time a request hit a fresh/cold instance. The DB-backed store means your login
   persists across cold starts and redeploys.
2. **The scheduler cannot be an in-process `node-cron` loop**, because a
   serverless function exits before any timer callback fires. An earlier version
   started `scheduler.start()` inside the web process; that path has been
   **removed**. The scheduler now runs only when an external timer calls
   `POST /api/cron/prayer-scheduler` (see [Cron & reminders](#cron--reminders)),
   and every successful tick writes a `cron_heartbeat` row that
   `GET /api/health` reports so you can prove it is alive.

## 1. Install

```bash
cd prayer-app
npm install
```

## 2. Configure Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Open the **SQL Editor** → **New Query**, paste the entire contents of
   [`supabase/schema.sql`](supabase/schema.sql), and **Run** it. This creates all
   tables **including the `sessions` table** required for login to work on
   Vercel, plus RLS policies.
   - If you deployed an earlier version of the schema and are updating, at minimum
     run this new part:
     ```sql
     CREATE TABLE IF NOT EXISTS sessions (
       sid TEXT PRIMARY KEY,
       sess JSONB NOT NULL,
       expire TIMESTAMP WITH TIME ZONE NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);
     ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
     ```
3. Grab three values from **Project Settings → API**:
   - `Project URL` → `SUPABASE_URL`
   - `anon` public key → `SUPABASE_ANON_KEY`
   - `service_role` secret key → `SUPABASE_SERVICE_ROLE_KEY`

> **Note on the data layer / RLS:** the backend is a *trusted server* that
> authenticates with cookie sessions and never forwards a per-user JWT to
> Supabase. For that reason `src/db.js`, `src/services/scheduler.js`, and
> `src/services/prayerTimes.js` all use the **service-role key**, which bypasses
> RLS. The anon key is used only for signing users in (`signInWithPassword`) in
> `src/routes/auth.js`. Do not switch the data layer back to the anon key — under
> RLS it silently returns **zero rows** and login/dashboards/scheduler all stop
> working.

## 3. Configure environment variables

Copy `.env.example` to `.env` and fill in real values:

| Variable | Purpose |
| --- | --- |
| `PORT` | Local dev port (ignored on Vercel). |
| `SESSION_SECRET` | Signs the session cookie. Any long random string. |
| `TOKEN_SECRET` | Signs the email Yes/No links. Any long random string. |
| `BASE_URL` | Public URL used inside email links (e.g. `https://your-app.vercel.app`). Use `http://localhost:3000` locally. |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | From step 2. |
| `PRAYER_CALC_METHOD` | Aladhan method id (default `1` = Karachi). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `EMAIL_FROM` | SMTP credentials for sending email. |
| `PRE_REMINDER_MINUTES` | Default minutes **before** a prayer for the "time to prepare" reminder (default 30; per-user override wins). |
| `FOLLOWUP_DELAY_MINUTES` | Default minutes **after** a prayer for the "Did you get to pray?" follow-up (default 30; per-user override wins). |
| `MISSED_AFTER_MINUTES` | Minutes after a prayer before it's auto-marked missed (default 120). |
| `SEND_GRACE_MINUTES` | Width of each email's send window in minutes (default 15). A stale email is logged `skipped_stale` and never caught up. |
| `MAX_EMAILS_PER_TICK` | Hard cap on real emails sent by one invocation (default 50). Claims past the cap are released for the next tick. |
| `SCHEDULER_DRY_RUN` | `1`/`true`: exercise the whole claim→log→auto-mark pipeline **without** touching SMTP. |
| `CRON_SECRET` | Shared secret that authorizes the scheduler endpoint. **Must be set in production.** |
| `SMOKE_TEST_EMAIL` | Recipient for `npm run smoke-reminder` (ops-only, one manual test email). |

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> The `service_role` key and SMTP password are **secrets**. Keep them only in
> `.env` (gitignored) and in your host's environment-variable settings. Never
> commit them or expose them to the browser.

## 4. Run it locally

```bash
npm run dev     # or: npm start
```

Visit `http://localhost:3000` (or the `PORT` you set). The web process **no
longer self-schedules** (that in-process `node-cron` path was removed, because it
never worked on Vercel). To trigger a reminder pass locally, run one tick by hand:

```bash
npm run tick-once                       # one live tick (sends real email if SMTP is set)
SCHEDULER_DRY_RUN=1 npm run tick-once   # one dry-run tick: logs subjects, sends nothing
```

## 5. Try it out

1. Sign up — you create your account.
2. Create a group — you become its admin.
3. Invite someone by email from the dashboard. New users get a signup link that
   auto-joins the group when they register; existing members are tracked right
   away.
4. Open `/admin` (visible only to the group creator) to see everyone's status.
5. To test reminders quickly, set `PRE_REMINDER_MINUTES`/`FOLLOWUP_DELAY_MINUTES`
   to a small value (or use the per-user minutes field on `/notifications`) and
   run `npm run tick-once` near the target instant.

## Cron & reminders

The scheduler logic is in [`src/services/scheduler.js`](src/services/scheduler.js).
Each **tick** runs `tick()`, which fires an email only inside a narrow window
(`scheduled_at ≤ now < scheduled_at + SEND_GRACE_MINUTES`, default 15 min). An
email whose window has closed is permanently logged `skipped_stale` and never
caught up, so downtime can never stack late reminders on top of the next prayer.
**The tick must run at least every 5 minutes** or emails fall outside the window.
The app never self-schedules; pick an external trigger:

### Option B — GitHub Action (primary; works on every plan)
[`.github/workflows/run-scheduler.yml`](.github/workflows/run-scheduler.yml)
calls the endpoint every 5 minutes and then curls `/api/health` to prove the tick
landed. Add two repository secrets
(**Settings → Secrets and variables → Actions**):
- `CRON_URL` = `https://your-app.vercel.app/api/cron/prayer-scheduler`
- `CRON_SECRET` = the same value set on Vercel.

The workflow fails loudly (`::error::`) when `staleFor > 900` seconds, which
turns every Action run into a heartbeat alarm.

### Option A — Vercel Cron (daily backstop)
`vercel.json` registers a once-per-day cron that hits
`/api/cron/prayer-scheduler`:
```json
"crons": [{ "path": "/api/cron/prayer-scheduler", "schedule": "0 3 * * *" }]
```
> **Plan limit:** Vercel **Hobby** only allows cron **once per day** (a `*/5`
> schedule fails the deploy). `0 3 * * *` runs in a low-traffic UTC hour and
> serves as a refresh backstop only. On **Pro**, change it to `*/5 * * * *` and
> the GitHub Action becomes optional redundancy. Vercel automatically sends
> `Authorization: Bearer <CRON_SECRET>` when `CRON_SECRET` is set on the project.

### `GET /api/health` (no auth)
Returns whether the scheduler is alive and which way it is configured:
```json
{
  "ok": true,
  "scheduler": { "present": true, "lastTickAt": "…", "lastFinishedOk": true,
                 "lastError": null, "usersSeen": 12, "emailsSent": 3,
                 "staleFor": 143, "dryRun": false },
  "env": { "hasSmtp": true, "hasCronSecret": true, "hasSupabaseUrl": true, "vercel": true },
  "emailMode": "live"
}
```
`staleFor` is seconds since the last tick started. Alert if it exceeds ~900.

### How the endpoint is secured
`POST /api/cron/prayer-scheduler` rejects any request unless the
`Authorization: Bearer` token matches `CRON_SECRET`. A missing `CRON_SECRET` in
production is a **loud 401 failure**, not an open door. Each hit also logs
`[cron] hit ua=…` so ops can confirm the endpoint is being reached at all.

### Manual smoke test
After deploying, `npm run smoke-reminder` sends one pre-reminder and one
follow-up to `SMOKE_TEST_EMAIL` through the real SMTP pipeline (bypassing
`notifications_log`), so you can verify deliverability without waiting for a
prayer window.

## Deploying to Vercel

1. Push the repo to GitHub and import it in Vercel (the `vercel.json`
   `builds`/`routes` send all traffic to `src/server.js`).
2. Add all environment variables from step 3 in **Project → Settings →
   Environment Variables**, including a real `CRON_SECRET` and `BASE_URL` set to
   your Vercel domain. At minimum the Production environment needs:
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`,
   `SESSION_SECRET`, `TOKEN_SECRET`, `BASE_URL`, `CRON_SECRET`,
   `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`.
3. Apply the Supabase migrations (see [`SUPABASE_DEPLOYMENT.md`](SUPABASE_DEPLOYMENT.md)),
   including `0007_cron_heartbeat.sql`, so the heartbeat write and the sessions
   /prefs columns exist. Without `0007` the scheduler still runs but
   `/api/health` reports `scheduler.present = false`.
4. Enable the GitHub Action: add the `CRON_URL` / `CRON_SECRET` repository
   secrets described above.
5. Deploy, wait for one Action run, then open
   `https://your-app.vercel.app/api/health` and confirm
   `scheduler.lastFinishedOk = true` and `staleFor < 900`.

## Email deliverability (SPF / DKIM / DMARC)

If the scheduler is firing (health looks fresh) but reminders land in spam, the
problem is authentication, not code. Every reminder now carries an RFC 8058
`List-Unsubscribe` / `List-Unsubscribe-Post` header pointing at `/notifications`.
On top of that, make sure the domain used in `EMAIL_FROM` publishes:

- **SPF** — a TXT record authorising your SMTP provider. E.g. Google Workspace:
  `v=spf1 include:_spf.google.com ~all`; SendGrid/Mailgun/Resend: their documented
  `include:`.
- **DKIM** — the CNAME/TXT keys your provider gives you (Google: Admin console →
  Gmail → Authenticate mail; transactional providers: verify the domain).
- **DMARC** — at minimum `v=DMARC1; p=none; rua=mailto:you@yourdomain` while you
  watch reports, then tighten to `p=quarantine` / `p=reject`.

Do **not** send from a `@gmail.com` "send as" address on a shared relay — you
cannot publish SPF/DKIM for a domain you do not control, and deliverability will
stay poor. Use `npm run smoke-reminder` after any DNS change to check with a real
message. (Exact records differ per provider; consult your `SMTP_HOST` docs.)

## Project structure

```
src/
  server.js               → Express app, session setup, cron endpoint + GET /api/health
  sessionStore.js         → Supabase-backed express-session store (serverless logins)
  supabase.js             → Supabase clients (anon + service-role)
  db.js                   → data layer (uses the service-role client) + cron_heartbeat helpers
  middleware/auth.js      → login / admin guards
  routes/
    auth.js               → register / login / logout
    group.js              → create group, invite/leave/remove members
    dashboard.js          → member dashboard + admin dashboard + manual marking
    profile.js            → /notifications prefs incl. per-user pre/post minutes
    response.js           → handles the Yes/No email links
  services/
    prayerTimes.js        → Aladhan API integration + per-day caching
    scheduler.js          → reminder / follow-up / auto-missed tick (no self-scheduling)
    email.js              → SMTP sending + email templates + List-Unsubscribe headers
  utils/token.js          → signed tokens for the Yes/No email links
scripts/
  tick-once.js            → run one scheduler tick by hand (replaces the old node-cron)
  smoke-reminder.js       → send one real test email via the production pipeline
supabase/
  schema.sql              → all tables, indexes, RLS policies, sessions + cron_heartbeat
  migrations/             → incremental migrations (0007 adds cron_heartbeat)
views/                    → EJS page templates
public/style.css          → styling
```
