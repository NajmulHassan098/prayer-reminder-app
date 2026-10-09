const nodemailer = require("nodemailer");
const { siteOrigin } = require("../utils/siteUrl");

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
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${prayerName} is coming up</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc;">
      <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 32px 24px; text-align: center;">
          <div style="font-size: 48px; margin-bottom: 16px;">🕌</div>
          <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 700;">${prayerName} is coming up</h1>
        </div>
        
        <!-- Content -->
        <div style="padding: 32px 24px;">
          <p style="color: #1e293b; font-size: 16px; line-height: 1.6; margin: 0 0 16px;">
            Assalamu Alaikum, <strong>${user.name}</strong> 👋
          </p>
          
          <div style="background-color: #f0fdf4; border-left: 4px solid #10b981; padding: 20px; margin: 24px 0; border-radius: 0 8px 8px 0;">
            <p style="color: #166534; margin: 0; font-size: 18px; font-weight: 600;">
              Be ready for ${prayerName} prayer in ${leadMinutes} minutes.
            </p>
            <p style="color: #166534; margin: 8px 0 0; font-size: 16px;">
              ${prayerName} today is at <strong>${time}</strong> in ${user.city}.
            </p>
          </div>
          
          <p style="color: #64748b; font-size: 14px; line-height: 1.6; margin: 24px 0 0;">
            You'll receive a follow-up message after the prayer time to help you track whether you've completed it.
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

function followupEmailHtml(user, prayerName, date, yesUrl, noUrl) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Did you pray ${prayerName}?</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc;">
      <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); padding: 32px 24px; text-align: center;">
          <div style="font-size: 48px; margin-bottom: 16px;">🤲</div>
          <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 700;">Did you pray ${prayerName}?</h1>
        </div>
        
        <!-- Content -->
        <div style="padding: 32px 24px;">
          <p style="color: #1e293b; font-size: 16px; line-height: 1.6; margin: 0 0 16px;">
            Assalamu Alaikum, <strong>${user.name}</strong>
          </p>
          
          <p style="color: #64748b; font-size: 15px; line-height: 1.6; margin: 0 0 24px;">
            Just checking in on your <strong>${prayerName}</strong> prayer for <strong>${date}</strong>.
          </p>
          
          <!-- Action Buttons -->
          <div style="margin: 32px 0; text-align: center;">
            <a href="${yesUrl}" style="display: inline-block; background-color: #10b981; color: #ffffff; padding: 16px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px; margin: 0 8px 12px 0;">
              ✅ Yes, I prayed
            </a>
            <a href="${noUrl}" style="display: inline-block; background-color: #ef4444; color: #ffffff; padding: 16px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px; margin: 0 0 12px 0;">
              ❌ Not yet
            </a>
          </div>
          
          <p style="color: #94a3b8; font-size: 12px; line-height: 1.5; margin: 24px 0 0; text-align: center;">
            This link is unique to you and expires automatically for your security.
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

module.exports = { 
  sendMail, 
  reminderEmailHtml, 
  followupEmailHtml,
  invitationEmailHtml,
  groupAddedEmailHtml,
  resetPasswordEmailHtml
};
