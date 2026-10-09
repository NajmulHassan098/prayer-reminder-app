const nodemailer = require("nodemailer");
const { siteOrigin } = require("../utils/siteUrl");
const { adhkarForDay } = require("../data/adhkar");
const { t, dirAttr, resolveLocale } = require("../utils/i18n");
const { resolveLocaleFromCountry } = require("../services/prayerTimes");

const PRAYER_ORDER = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];

// Effective language for a user's email + a dir attribute for the wrapper.
function emailLocale(user) {
  return resolveLocale(user || {}, resolveLocaleFromCountry);
}

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  
  // Validate required environment variables
  const requiredEnvVars = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'];
  const missing = requiredEnvVars.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required email environment variables: ${missing.join(', ')}`);
  }
  
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    // Add connection pooling and timeout settings for production
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    connectionTimeout: 60000,
  });
  
  return transporter;
}

async function sendMail({ to, subject, html, text }) {
  try {
    const t = getTransporter();
    
    // Verify connection configuration
    try {
      await t.verify();
    } catch (verifyError) {
      console.error(`[email] SMTP connection verification failed:`, verifyError.message);
      console.error(`[email] SMTP Config:`, {
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        user: process.env.SMTP_USER,
        secure: process.env.SMTP_SECURE
      });
      return { success: false, error: `SMTP connection failed: ${verifyError.message}` };
    }
    
    const result = await t.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
      to,
      subject,
      html,
      text: text || stripHtml(html), // Fallback plain text version
      // RFC 8058 one-click unsubscribe. Gmail/Outlook/Yahoo surface this as a
      // visible Unsubscribe button and enforce it since Feb 2024 — omitting it
      // is now a deliverability risk on bulk mail. The URL points at the
      // existing /notifications page where the user can toggle every email
      // type off; no dedicated route needed.
      headers: {
        "List-Unsubscribe": `<${siteOrigin()}/notifications>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    
    console.log(`[email] Successfully sent to ${to}: ${subject} (Message ID: ${result.messageId})`);
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error(`[email] Failed to send to ${to}:`, error.message);
    console.error(`[email] Error details:`, {
      to,
      subject,
      error: error.stack,
      timestamp: new Date().toISOString()
    });
    
    // Don't throw - let the caller handle the failure
    return { success: false, error: error.message };
  }
}

// Helper function to strip HTML tags for plain text fallback
function stripHtml(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function reminderEmailHtml(user, prayerName, time, leadMinutes = 30) {
  const loc = emailLocale(user);
  const dir = dirAttr(loc);
  const soon = t(loc, "email.prayer_soon", { prayer: prayerName, mins: leadMinutes });
  return `
    <!DOCTYPE html>
    <html dir="${dir}" lang="${loc}">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${soon}</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; direction: ${dir};">
      <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 32px 24px; text-align: center;">
          <div style="font-size: 48px; margin-bottom: 16px;">🕌</div>
          <h1 style="color: #ffffff; margin: 0; font-size: 26px; font-weight: 700;">${soon}</h1>
        </div>
        
        <!-- Content -->
        <div style="padding: 32px 24px;">
          <p style="color: #1e293b; font-size: 16px; line-height: 1.6; margin: 0 0 16px;">
            ${t(loc, "email.greeting", { name: `<strong>${user.name}</strong>` })}
          </p>
          
          <div style="background-color: #f0fdf4; border-${dir === 'rtl' ? 'right' : 'left'}: 4px solid #10b981; padding: 20px; margin: 24px 0; border-radius: ${dir === 'rtl' ? '8px 0 0 8px' : '0 8px 8px 0'};">
            <p style="color: #166534; margin: 0; font-size: 18px; font-weight: 600;">
              ${t(loc, "email.prayer_now", { prayer: prayerName })}
            </p>
            <p style="color: #166534; margin: 8px 0 0; font-size: 16px;">
              ${t(loc, "label.today")} · <strong>${time}</strong> — ${user.city}
            </p>
          </div>
          
          <p style="color: #64748b; font-size: 14px; line-height: 1.6; margin: 24px 0 0;">
            ${t(loc, "email.followup_nudge")}
          </p>
        </div>
        
        <!-- Footer -->
        <div style="background-color: #f1f5f9; padding: 24px; text-align: center; border-top: 1px solid #e2e8f0;">
          <p style="color: #64748b; font-size: 12px; margin: 0;">
            ${t(loc, "email.brand")} · ${new Date().toLocaleDateString()} — ${t(loc, "email.footer_sent_with")}
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
}

function followupEmailHtml(user, prayerName, date, yesUrl, noUrl, postMinutes = 30) {
  const loc = emailLocale(user);
  const dir = dirAttr(loc);
  const question = t(loc, "email.subject.followup", { prayer: prayerName });
  return `
    <!DOCTYPE html>
    <html dir="${dir}" lang="${loc}">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${question}</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; direction: ${dir};">
      <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); padding: 32px 24px; text-align: center;">
          <div style="font-size: 48px; margin-bottom: 16px;">🤲</div>
          <h1 style="color: #ffffff; margin: 0; font-size: 26px; font-weight: 700;">${question}</h1>
        </div>
        
        <!-- Content -->
        <div style="padding: 32px 24px;">
          <p style="color: #1e293b; font-size: 16px; line-height: 1.6; margin: 0 0 16px;">
            ${t(loc, "email.greeting", { name: `<strong>${user.name}</strong>` })}
          </p>
          
          <p style="color: #64748b; font-size: 15px; line-height: 1.6; margin: 0 0 24px;">
            ${t(loc, "email.followup_nudge")} <strong>${date}</strong>.
          </p>

          <p style="color: #64748b; font-size: 15px; line-height: 1.6; margin: 0 0 24px;">
            ${t(loc, "email.followup.still_time", { prayer: prayerName, mins: postMinutes })}
          </p>
          
          <!-- Action Buttons -->
          <div style="margin: 32px 0; text-align: center;">
            <a href="${yesUrl}" style="display: inline-block; background-color: #10b981; color: #ffffff; padding: 16px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px; margin: 0 ${dir === 'rtl' ? '0 0 12px 8px' : '0 8px 12px 0'};">
              ✅ ${t(loc, "btn.respond_yes")}
            </a>
            <a href="${noUrl}" style="display: inline-block; background-color: #ef4444; color: #ffffff; padding: 16px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px; margin: 0 0 12px 0;">
              ❌ ${t(loc, "btn.respond_not_yet")}
            </a>
          </div>
          
          <p style="color: #94a3b8; font-size: 12px; line-height: 1.5; margin: 24px 0 0; text-align: center;">
            ${t(loc, "email.tap_to_log")}
          </p>

          <!-- Post-prayer dhikr, rotating per prayer per day -->
          ${adhkarFooter(prayerName, date)}
        </div>
        
        <!-- Footer -->
        <div style="background-color: #f1f5f9; padding: 24px; text-align: center; border-top: 1px solid #e2e8f0;">
          <p style="color: #64748b; font-size: 12px; margin: 0;">
            ${t(loc, "email.brand")} · ${new Date().toLocaleDateString()} — ${t(loc, "email.footer_sent_with")}
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
}

function invitationEmailHtml(inviterName, groupName, signupUrl) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>You're invited to join ${groupName}</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc;">
      <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); padding: 32px 24px; text-align: center;">
          <div style="font-size: 48px; margin-bottom: 16px;">📬</div>
          <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 700;">You're Invited!</h1>
        </div>
        
        <!-- Content -->
        <div style="padding: 32px 24px;">
          <p style="color: #1e293b; font-size: 16px; line-height: 1.6; margin: 0 0 16px;">
            <strong>${inviterName}</strong> has invited you to join their prayer group:
          </p>
          
          <div style="background-color: #f5f3ff; border-left: 4px solid #8b5cf6; padding: 20px; margin: 24px 0; border-radius: 0 8px 8px 0;">
            <p style="color: #5b21b6; margin: 0; font-size: 20px; font-weight: 700;">
              ${groupName}
            </p>
          </div>
          
          <p style="color: #64748b; font-size: 15px; line-height: 1.6; margin: 24px 0;">
            Join the group to track your daily prayers together and stay motivated with your community.
          </p>
          
          <!-- Action Button -->
          <div style="margin: 32px 0; text-align: center;">
            <a href="${signupUrl}" style="display: inline-block; background-color: #8b5cf6; color: #ffffff; padding: 16px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px;">
              Join the Group
            </a>
          </div>
          
          <p style="color: #94a3b8; font-size: 12px; line-height: 1.5; margin: 24px 0 0; text-align: center;">
            This invitation link will expire in 7 days.
          </p>
        </div>
        
        <!-- Footer -->
        <div style="background-color: #f1f5f9; padding: 24px; text-align: center; border-top: 1px solid #e2e8f0;">
          <p style="color: #64748b; font-size: 12px; margin: 0;">
            Prayer Reminder App · ${new Date().toLocaleDateString()}
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
}

function groupAddedEmailHtml(inviterName, groupName) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>You've been added to ${groupName}</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc;">
      <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #06b6d4 0%, #0891b2 100%); padding: 32px 24px; text-align: center;">
          <div style="font-size: 48px; margin-bottom: 16px;">✨</div>
          <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 700;">Welcome to the Group!</h1>
        </div>
        
        <!-- Content -->
        <div style="padding: 32px 24px;">
          <p style="color: #1e293b; font-size: 16px; line-height: 1.6; margin: 0 0 16px;">
            <strong>${inviterName}</strong> has added you to their prayer group:
          </p>
          
          <div style="background-color: #ecfeff; border-left: 4px solid #06b6d4; padding: 20px; margin: 24px 0; border-radius: 0 8px 8px 0;">
            <p style="color: #0e7490; margin: 0; font-size: 20px; font-weight: 700;">
              ${groupName}
            </p>
          </div>
          
          <p style="color: #64748b; font-size: 15px; line-height: 1.6; margin: 24px 0;">
            You can now track your daily prayers together with your group members. Visit your dashboard to see your prayer times and group progress.
          </p>
          
          <!-- Action Button -->
          <div style="margin: 32px 0; text-align: center;">
            <a href="${siteOrigin()}/dashboard" style="display: inline-block; background-color: #06b6d4; color: #ffffff; padding: 16px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px;">
              Go to Dashboard
            </a>
          </div>
        </div>
        
        <!-- Footer -->
        <div style="background-color: #f1f5f9; padding: 24px; text-align: center; border-top: 1px solid #e2e8f0;">
          <p style="color: #64748b; font-size: 12px; margin: 0;">
            Prayer Reminder App · ${new Date().toLocaleDateString()}
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
}

function resetPasswordEmailHtml(name, resetUrl) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Reset your password</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc;">
      <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 32px 24px; text-align: center;">
          <div style="font-size: 48px; margin-bottom: 16px;">🔑</div>
          <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 700;">Reset your password</h1>
        </div>

        <!-- Content -->
        <div style="padding: 32px 24px;">
          <p style="color: #1e293b; font-size: 16px; line-height: 1.6; margin: 0 0 16px;">
            Assalamu Alaikum, <strong>${name || 'there'}</strong>
          </p>

          <p style="color: #64748b; font-size: 15px; line-height: 1.6; margin: 0 0 24px;">
            We received a request to reset the password for your Prayer Reminder account. Click the button below to choose a new password. This link is valid for <strong>1 hour</strong>.
          </p>

          <!-- Action Button -->
          <div style="margin: 32px 0; text-align: center;">
            <a href="${resetUrl}" style="display: inline-block; background-color: #10b981; color: #ffffff; padding: 16px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px;">
              Reset Password
            </a>
          </div>

          <p style="color: #94a3b8; font-size: 12px; line-height: 1.5; margin: 24px 0 0; text-align: center;">
            If you did not request this, you can safely ignore this email and your password will not change.
          </p>
        </div>

        <!-- Footer -->
        <div style="background-color: #f1f5f9; padding: 24px; text-align: center; border-top: 1px solid #e2e8f0;">
          <p style="color: #64748b; font-size: 12px; margin: 0;">
            Prayer Reminder App · ${new Date().toLocaleDateString()}
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
}

// Small rotating dhikr block appended inside the follow-up email body.
// Kept as a helper so future locales (i18n) can translate around it.
function adhkarFooter(prayerName, date) {
  const idx = Math.max(0, PRAYER_ORDER.indexOf(prayerName));
  const dhikr = adhkarForDay(idx, date);
  return `
          <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 32px 0 0; text-align: center;">
            <p style="color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; margin: 0 0 10px;">From the Sunnah after prayer</p>
            <p dir="rtl" style="color: #334155; font-size: 17px; line-height: 2; margin: 0 0 10px; font-family: 'Amiri', 'Noto Naskh Arabic', serif;">${dhikr.arabic}</p>
            <p style="color: #64748b; font-size: 13px; line-height: 1.6; margin: 0 0 6px; font-style: italic;">&ldquo;${dhikr.text}&rdquo;</p>
            <p style="color: #94a3b8; font-size: 11px; margin: 0;">&mdash; ${dhikr.reference}</p>
          </div>
  `;
}

// Shared shell for the seasonal (Ramadan/Ayyam) emails — same structure as the
// daily templates, with a per-feature accent color. Copy stays gentle/inviting.
function seasonalEmailHtml({ emoji, title, greeting, lines, dir = "ltr", loc = "en", accent = "#7c3aed", gradFrom = "#8b5cf6", gradTo = "#6d28d9" }) {
  const bodyLines = lines
    .map((l) => `<p style="color: ${l.muted ? "#64748b" : "#1e293b"}; font-size: ${l.big ? "18px" : "15px"}; line-height: 1.7; margin: 0 0 16px; ${l.center ? "text-align:center;" : ""}">${l.html}</p>`)
    .join("\n          ");
  return `
    <!DOCTYPE html>
    <html dir="${dir}" lang="${loc}">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title}</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; direction: ${dir};">
      <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
        <div style="background: linear-gradient(135deg, ${gradFrom} 0%, ${gradTo} 100%); padding: 32px 24px; text-align: center;">
          <div style="font-size: 48px; margin-bottom: 16px;">${emoji}</div>
          <h1 style="color: #ffffff; margin: 0; font-size: 26px; font-weight: 700;">${title}</h1>
        </div>
        <div style="padding: 32px 24px;">
          <p style="color: #1e293b; font-size: 16px; line-height: 1.6; margin: 0 0 16px;">${greeting}</p>
          ${bodyLines}
        </div>
        <div style="background-color: #f1f5f9; padding: 24px; text-align: center; border-top: 1px solid #e2e8f0;">
          <p style="color: #64748b; font-size: 12px; margin: 0;">
            ${t(loc, "email.brand")} · ${new Date().toLocaleDateString()} — ${t(loc, "email.footer_sent_with")}
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
}

// Ayyam al-Biḍʿ: the 13th/14th/15th of the lunar month — the white days.
function sunnahFastEmailHtml(user, row) {
  const loc = emailLocale(user); const dir = dirAttr(loc);
  return seasonalEmailHtml({
    dir, loc,
    emoji: "🌕",
    title: t(loc, "email.subject.ayyam"),
    greeting: t(loc, "email.greeting", { name: `<strong>${user.name}</strong>` }),
    lines: [
      { html: t(loc, "email.ayyam.body", { hday: row.hijri_day, hmonth: row.hijri_month || "the lunar month" }) },
      { html: `If today works for you, make the intention before ${row.fajr} and join the fast. If it doesn't — no weight, no guilt — tomorrow is another day. 🌙`, muted: true },
    ],
  });
}

function suhoorEmailHtml(user, row) {
  const loc = emailLocale(user); const dir = dirAttr(loc);
  const imsak = row.imsak && row.imsak !== "00:00" ? row.imsak : row.fajr;
  return seasonalEmailHtml({
    dir, loc,
    emoji: "🍳",
    title: t(loc, "email.subject.suhoor"),
    greeting: t(loc, "email.greeting", { name: `<strong>${user.name}</strong>` }),
    gradFrom: "#0d9488", gradTo: "#065f46",
    lines: [
      { html: t(loc, "email.suhoor.body", { imsak }), big: true, center: true },
      { html: `The Prophet ﷺ said: "Take suhoor, for in suhoor there is blessing." (Sahih al-Bukhari & Muslim)`, muted: true },
    ],
  });
}

function iftarEmailHtml(user, row) {
  const loc = emailLocale(user); const dir = dirAttr(loc);
  return seasonalEmailHtml({
    dir, loc,
    emoji: "🌴",
    title: t(loc, "email.subject.iftar"),
    greeting: t(loc, "email.greeting", { name: `<strong>${user.name}</strong>` }),
    gradFrom: "#b45309", gradTo: "#78350f",
    lines: [
      { html: t(loc, "email.iftar.body", { maghrib: row.maghrib }), big: true },
      { html: `ذَهَبَ الظَّمَأُ وَابْتَلَّتِ الْعُرُوقُ وَثَبَتَ الْأَجْرُ إِنْ شَاءَ اللَّهُ — the thirst is gone, the veins are moistened, and the reward is confirmed, if Allah wills.`, muted: true },
    ],
  });
}

function taraweehEmailHtml(user, row) {
  const loc = emailLocale(user); const dir = dirAttr(loc);
  return seasonalEmailHtml({
    dir, loc,
    emoji: "🌙",
    title: t(loc, "email.subject.taraweeh"),
    greeting: t(loc, "email.greeting", { name: `<strong>${user.name}</strong>` }),
    gradFrom: "#4338ca", gradTo: "#312e81",
    lines: [
      { html: t(loc, "email.taraweeh.body", { isha: row.isha }) },
      { html: `Whoever stands (in prayer) in Ramadan out of faith and hoping for reward, his previous sins will be forgiven. — Sahih al-Bukhari`, muted: true },
    ],
  });
}

module.exports = { 
  sendMail, 
  reminderEmailHtml, 
  followupEmailHtml,
  invitationEmailHtml,
  groupAddedEmailHtml,
  resetPasswordEmailHtml,
  sunnahFastEmailHtml,
  suhoorEmailHtml,
  iftarEmailHtml,
  taraweehEmailHtml,
  adhkarFooter
};
