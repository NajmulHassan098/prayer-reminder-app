// Ops smoke test: sends ONE real pre-prayer reminder and ONE real follow-up
// straight through the same email.js pipeline the scheduler uses, so a
// deploy can be validated end-to-end (SMTP credentials, SPF/DKIM/DMARC,
// template rendering, unsubscribe headers) without waiting for the next
// prayer window and without touching any user's notifications_log.
//
// Usage:
//   SMOKE_TEST_EMAIL=you@example.com npm run smoke-reminder
//   SMOKE_TEST_EMAIL=... PRAYER=Asr npm run smoke-reminder   (default: Asr)
//
// Requires the same SMTP_* and EMAIL_FROM env vars as the app. If SMOKE_TEST_EMAIL
// is not set, the script refuses to run rather than guess a recipient.
require("dotenv").config();
const { sendMail, reminderEmailHtml, followupEmailHtml } = require("../src/services/email");
const { siteOrigin } = require("../src/utils/siteUrl");

const to = process.env.SMOKE_TEST_EMAIL;
if (!to) {
  console.error("[smoke-reminder] SMOKE_TEST_EMAIL env var is required. Refusing to send.");
  process.exit(2);
}
if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
  console.error("[smoke-reminder] SMTP_HOST/SMTP_USER/SMTP_PASS are required. Check your .env or Vercel project env vars.");
  process.exit(2);
}

const prayer = process.env.PRAYER || "Asr";
const today = new Date().toISOString().slice(0, 10);
const fakeUser = {
  id: "smoke",
  name: "Smoke-test recipient",
  city: process.env.SMOKE_TEST_CITY || "Karachi",
  country: process.env.SMOKE_TEST_COUNTRY || "Pakistan",
  notification_prefs: null,
};

// The scheduler's Yes/No links are signed. For a smoke test we only need to
// prove the HTML renders and arrives, so the URLs point at the app root; the
// user cannot act on them, but the visual pipeline is exercised identically.
const yesUrl = siteOrigin();
const noUrl = siteOrigin();

(async () => {
  console.log(`[smoke-reminder] sending pre-prayer reminder for ${prayer} to ${to}`);
  const r1 = await sendMail({
    to,
    subject: `[smoke] ${prayer} in about 30 minutes (test)`,
    html: reminderEmailHtml(fakeUser, prayer, "16:00", 30),
  });
  if (!r1.success) {
    console.error("[smoke-reminder] reminder send FAILED:", r1.error);
    process.exit(1);
  }
  console.log(`[smoke-reminder]   reminder messageId=${r1.messageId}`);

  console.log(`[smoke-reminder] sending post-prayer follow-up for ${prayer} to ${to}`);
  const r2 = await sendMail({
    to,
    subject: `[smoke] Did you get to pray ${prayer}? (test)`,
    html: followupEmailHtml(fakeUser, prayer, today, yesUrl, noUrl, 30),
  });
  if (!r2.success) {
    console.error("[smoke-reminder] follow-up send FAILED:", r2.error);
    process.exit(1);
  }
  console.log(`[smoke-reminder]   follow-up messageId=${r2.messageId}`);
  console.log("[smoke-reminder] OK — check the inbox (and spam folder) for both messages. If they landed in spam, review the SPF/DKIM/DMARC checklist in README.");
  process.exit(0);
})().catch((err) => {
  console.error("[smoke-reminder] unexpected error:", err);
  process.exit(1);
});
