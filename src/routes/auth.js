const express = require("express");
const { supabase, supabaseAdmin } = require("../supabase");
const db = require("../db");
const { createPasswordResetToken, verifyPasswordResetToken } = require("../utils/token");
const { sendMail, resetPasswordEmailHtml } = require("../services/email");
const { siteOrigin } = require("../utils/siteUrl");

const router = express.Router();

// Find a Supabase auth user by email using the admin (service-role) client.
// supabase-js has no getUserByEmail, so we list and match.
async function findAuthUserByEmail(email) {
  const normalized = (email || "").toLowerCase().trim();
  const { data } = await supabaseAdmin.auth.admin.listUsers();
  return (data && data.users ? data.users : []).find(
    (u) => (u.email || "").toLowerCase() === normalized
  ) || null;
}

router.get("/register", async (req, res) => {
  const inviteToken = req.query.invite || null;
  let invitation = null;
  
  console.log(`[register] GET request with invite token: ${inviteToken}`);
  
  if (inviteToken) {
    try {
      // Use existing db helper to fetch the invitation
      const data = await db.getInvitationByToken(inviteToken);
      
      if (data && data.status === 'pending' && new Date(data.expires_at) > new Date()) {
        // Fetch group and inviter details manually to avoid complex join issues
        const group = await db.getGroupById(data.group_id);
        const inviter = await db.getUserProfile(data.invited_by);
        
        invitation = {
          ...data,
          group_name: group ? group.name : 'Unknown Group',
          inviter_name: inviter ? inviter.name : 'Unknown User'
        };
        console.log(`[register] Found valid invitation:`, { id: invitation.id, group: invitation.group_name, email: invitation.email });
      } else {
        console.log(`[register] No valid invitation found`);
      }
    } catch (err) {
      console.error(`[register] Error fetching invitation:`, err);
    }
  }
  
  res.render("register", { error: null, invitation });
});

router.post("/register", async (req, res) => {
  const { name, email, password, city, country, invite_token } = req.body;

  console.log(`[register] POST request received`);
  console.log(`[register] Email: ${email}, Invite token: ${invite_token}`);

  if (!name || !email || !password || !city || !country) {
    return res.render("register", { error: "All fields are required." });
  }

  try {
    // Check if user already exists in Supabase Auth
    const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers();
    const existingUser = existingUsers.users.find(u => u.email === email.toLowerCase().trim());
    
    if (existingUser) {
      console.log(`[register] User already exists with email: ${email}`);
      return res.render("register", { error: "An account with this email already exists. Please log in instead." });
    }

    // Sign up user with Supabase Auth (auto-confirm email)
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: email.toLowerCase().trim(),
      password: password,
      email_confirm: true,
      user_metadata: {
        name: name.trim(),
        city: city.trim(),
        country: country.trim()
      }
    });

    if (authError) {
      console.error(`[register] Supabase auth error:`, authError);
      // Provide more user-friendly error messages
      if (authError.message.includes('rate limit')) {
        return res.render("register", { error: "Too many signup attempts. Please wait a few minutes before trying again." });
      }
      return res.render("register", { error: authError.message });
    }

    if (!authData.user) {
      return res.render("register", { error: "Failed to create user account." });
    }

    const userId = authData.user.id;
    console.log(`[register] User created with ID: ${userId}`);

    // Create user profile
    const profileData = {
      id: userId,
      name: name.trim(),
      city: city.trim(),
      country: country.trim()
    };

    // Handle invitation if present
    if (invite_token && invite_token.trim()) {
      console.log(`[register] Processing invitation token: ${invite_token}`);
      
      const invitation = await db.getInvitationByToken(invite_token);
      
      if (invitation) {
        console.log(`[register] Found valid invitation: ID=${invitation.id}, Group=${invitation.group_id}, Email=${invitation.email}`);
        
        // Add user to the group
        profileData.group_id = invitation.group_id;
        
        // Mark invitation as accepted
        await db.updateInvitation(invitation.id, {
          status: 'accepted',
          accepted_at: new Date().toISOString()
        });
        
        console.log(`[register] Successfully added user ${userId} to group ${invitation.group_id}`);
        
        // Send email notification that they have been added to the group
        try {
          const { sendMail, groupAddedEmailHtml } = require("../services/email");
          const group = await db.getGroupById(invitation.group_id);
          const inviter = await db.getUserProfile(invitation.invited_by);
          await sendMail({
            to: email.toLowerCase().trim(),
            subject: `You've been added to ${group ? group.name : 'your prayer group'}`,
            html: groupAddedEmailHtml(inviter ? inviter.name : 'The group admin', group ? group.name : 'your prayer group'),
          });
          console.log(`[register] Sent group added email to ${email}`);
        } catch (emailErr) {
          console.error(`[register] Error sending group added email:`, emailErr);
        }
      } else {
        console.log(`[register] Invalid or expired invitation token: ${invite_token}`);
      }
    } else {
      console.log(`[register] No invitation token provided`);
    }

    // Create user profile
    await db.createUserProfile(profileData);

    req.session.userId = userId;
    console.log(`[register] Redirecting to dashboard for user ${userId}`);
    res.redirect("/dashboard");

  } catch (error) {
    console.error(`[register] Error:`, error);
    res.render("register", { error: "An error occurred during signup. Please try again." });
  }
});

// Keep /signup as an alias for /register for backward compatibility
router.get("/signup", (req, res) => {
  res.redirect("/register" + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''));
});

router.post("/signup", (req, res) => {
  res.redirect(307, "/register");
});

router.get("/login", (req, res) => {
  const message = req.query.reset === "success"
    ? "Your password has been reset. You can now log in with your new password."
    : null;
  res.render("login", { error: null, message });
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  console.log(`[login] Login attempt for email: ${email}`);

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.toLowerCase().trim(),
      password: password
    });

    if (error) {
      console.error(`[login] Supabase auth error:`, error);
      // Provide more specific error messages
      if (error.message.includes('Invalid login credentials')) {
        return res.render("login", { error: "Invalid email or password. Please check your credentials and try again.", message: null });
      }
      if (error.message.includes('Email not confirmed')) {
        // This app auto-confirms at signup and never sends verification emails,
        // so an unconfirmed account (e.g. created before that behaviour or via
        // the dashboard) would otherwise be permanently locked out. Self-heal:
        // confirm the email with the admin client, then retry the sign-in once.
        try {
          const unconfirmed = await findAuthUserByEmail(email);
          if (unconfirmed && !unconfirmed.email_confirmed_at) {
            await supabaseAdmin.auth.admin.updateUserById(unconfirmed.id, { email_confirm: true });
            console.log(`[login] Auto-confirmed email for ${email}, retrying sign-in`);
            const retry = await supabase.auth.signInWithPassword({
              email: email.toLowerCase().trim(),
              password: password
            });
            if (!retry.error && retry.data.user) {
              req.session.userId = retry.data.user.id;
              return res.redirect("/dashboard");
            }
          }
        } catch (healErr) {
          console.error(`[login] Auto-confirm healing failed:`, healErr);
        }
        return res.render("login", { error: "Please confirm your email address before logging in.", message: null });
      }
      return res.render("login", { error: error.message, message: null });
    }

    if (!data.user) {
      console.error(`[login] No user data returned`);
      return res.render("login", { error: "Login failed. Please try again.", message: null });
    }

    // Check if user profile exists
    const userProfile = await db.getUserProfile(data.user.id);
    if (!userProfile) {
      console.error(`[login] User profile not found for user: ${data.user.id}`);
      // Create profile if it doesn't exist
      try {
        await db.createUserProfile({
          id: data.user.id,
          name: data.user.user_metadata?.name || 'User',
          city: data.user.user_metadata?.city || '',
          country: data.user.user_metadata?.country || ''
        });
        console.log(`[login] Created missing profile for user: ${data.user.id}`);
      } catch (profileError) {
        console.error(`[login] Failed to create profile:`, profileError);
        return res.render("login", { error: "Account setup incomplete. Please contact support.", message: null });
      }
    }

    req.session.userId = data.user.id;
    console.log(`[login] User logged in successfully: ${data.user.id}`);
    res.redirect("/dashboard");

  } catch (error) {
    console.error(`[login] Error:`, error);
    res.render("login", { error: "An error occurred during login. Please try again.", message: null });
  }
});

// ---- Forgot / reset password -------------------------------------------------

router.get("/forgot-password", (req, res) => {
  res.render("forgot_password", { error: null, submitted: false });
});

router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.render("forgot_password", { error: "Please enter your email address.", submitted: false });
  }

  try {
    const user = await findAuthUserByEmail(email);
    // Only act when the account exists; always show the same response so this
    // endpoint cannot be used to enumerate registered emails.
    if (user) {
      const token = createPasswordResetToken(user.id);
      const resetUrl = `${siteOrigin()}/reset-password?token=${encodeURIComponent(token)}`;
      const name = (user.user_metadata && user.user_metadata.name) || "";
      const result = await sendMail({
        to: (email || "").toLowerCase().trim(),
        subject: "Reset your Prayer Reminder password",
        html: resetPasswordEmailHtml(name, resetUrl),
      });
      console.log(`[forgot-password] Reset email result for ${email}:`, result.success ? 'sent' : result.error);
    }
    return res.render("forgot_password", { error: null, submitted: true });
  } catch (error) {
    console.error(`[forgot-password] Error:`, error);
    return res.render("forgot_password", { error: "Something went wrong. Please try again later.", submitted: false });
  }
});

router.get("/reset-password", async (req, res) => {
  const token = req.query.token || null;
  if (!token) {
    return res.render("reset_password", { error: "Invalid or missing reset link.", token: null });
  }
  try {
    verifyPasswordResetToken(token); // throws if invalid/expired
    res.render("reset_password", { error: null, token });
  } catch (err) {
    res.render("reset_password", { error: "This reset link is invalid or has expired. Please request a new one.", token: null });
  }
});

router.post("/reset-password", async (req, res) => {
  const { token, password, confirm } = req.body;

  const fail = (msg) => res.render("reset_password", { error: msg, token: token || null });

  if (!token) return fail("Missing reset token.");
  if (!password || password.length < 8) return fail("Password must be at least 8 characters.");
  if (password !== confirm) return fail("Passwords do not match.");

  let payload;
  try {
    payload = verifyPasswordResetToken(token);
  } catch (err) {
    return fail("This reset link is invalid or has expired. Please request a new one.");
  }

  try {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(payload.userId, {
      password: password,
      // Ensure a password change also clears any unconfirmed-email lockout.
      email_confirm: true,
    });
    if (error) {
      console.error(`[reset-password] update error:`, error);
      return fail("We could not reset your password. Please try again.");
    }
    console.log(`[reset-password] Password reset for user ${payload.userId}`);
    return res.redirect("/login?reset=success");
  } catch (error) {
    console.error(`[reset-password] Error:`, error);
    return fail("Something went wrong. Please try again later.");
  }
});

router.post("/logout", async (req, res) => {
  try {
    await supabase.auth.signOut();
  } catch (error) {
    console.error(`[logout] Error:`, error);
  }
  
  req.session.destroy(() => res.redirect("/login"));
});

module.exports = router;
