const express = require("express");
const crypto = require("crypto");
const { supabase, supabaseAdmin } = require("../supabase");
const db = require("../db");
const { requireLogin, requireGroupAdmin } = require("../middleware/auth");
const { sendMail, invitationEmailHtml, groupAddedEmailHtml } = require("../services/email");
const { siteOrigin } = require("../utils/siteUrl");

const router = express.Router();
const MAX_MEMBERS = 30;
const INVITATION_EXPIRY_DAYS = 7;

function generateCode() {
  // 6-character uppercase alphanumeric code, permanent once created.
  return crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
}

async function generateUniqueCode() {
  let code;
  let isUnique = false;
  while (!isUnique) {
    code = generateCode();
    const existing = await db.getGroupByCode(code);
    if (!existing) isUnique = true;
  }
  return code;
}

function generateInvitationToken() {
  return crypto.randomBytes(32).toString("hex");
}

async function generateUniqueToken() {
  let token;
  let isUnique = false;
  while (!isUnique) {
    token = generateInvitationToken();
    const existing = await db.getInvitationByToken(token);
    if (!existing) isUnique = true;
  }
  return token;
}

router.get("/group/new", requireLogin, (req, res) => {
  if (req.user.group_id) return res.redirect("/dashboard");
  res.render("group_new", { error: null });
});

router.post("/group/new", requireLogin, async (req, res) => {
  if (req.user.group_id) return res.redirect("/dashboard");

  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.render("group_new", { error: "Please enter a group name." });
  }

  try {
    const code = await generateUniqueCode();
    const group = await db.createGroup({
      name: name.trim(),
      code: code,
      created_by: req.user.id
    });

    await db.updateUserProfile(req.user.id, { group_id: group.id });

    res.redirect("/dashboard");
  } catch (error) {
    console.error(`[group-new] Error:`, error);
    res.render("group_new", { error: "Failed to create group. Please try again." });
  }
});

// Admin-only: invite a user to the group via email
router.post("/group/invite", requireLogin, requireGroupAdmin, async (req, res) => {
  const { email, resend } = req.body;
  const normalizedEmail = (email || "").toLowerCase().trim();
  
  if (!normalizedEmail) {
    return res.status(400).json({ success: false, error: "Email is required." });
  }

  try {
    console.log('[group-invite] Fetching group members...');
    const groupMembers = await db.getGroupMembers(req.group.id);
    if (groupMembers.length >= MAX_MEMBERS) {
      return res.status(400).json({ success: false, error: "This group is full (30/30 members)." });
    }

    console.log('[group-invite] Fetching pending invitations...');
    // Existing pending/expired invitations for this email + group (spam guard + reuse).
    const existingInvitations = await db.getPendingInvitationsByEmail(normalizedEmail);
    const existingInvitation = existingInvitations.find(inv => inv.group_id === req.group.id);

    // Does a user with this email already have an account?
    // (This supabase-js build has no auth.admin.getUserByEmail, so look it up
    // from the paginated admin user list — same approach used in routes/auth.js.)
    let authUser = null;
    try {
      const { data: usersData } = await supabaseAdmin.auth.admin.listUsers();
      authUser = (usersData && usersData.users || []).find((u) => (u.email || '').toLowerCase() === normalizedEmail) || null;
    } catch (e) {
      console.error('[group-invite] Error looking up existing user:', e.message);
      authUser = null;
    }

    // ---- CASE 1: already a registered user -> add them to the group instantly ----
    if (authUser) {
      const profile = await db.getUserProfile(authUser.id);
      if (profile && profile.group_id) {
        if (profile.group_id === req.group.id) {
          return res.json({ success: true, message: `${normalizedEmail} is already a member of this group.` });
        }
        return res.status(400).json({ success: false, error: `${normalizedEmail} already belongs to another group.` });
      }

      console.log(`[group-invite] ${normalizedEmail} exists — adding instantly to group ${req.group.id}`);
      await db.updateUserProfile(authUser.id, { group_id: req.group.id });

      // Mark any pending invitation as accepted so it can't be reused later.
      if (existingInvitation && existingInvitation.status === 'pending') {
        await db.updateInvitation(existingInvitation.id, { status: 'accepted', accepted_at: new Date().toISOString() });
      }

      const result = await sendMail({
        to: normalizedEmail,
        subject: `You've been added to ${req.group.name}`,
        html: groupAddedEmailHtml(req.user.name, req.group.name),
      });
      return res.json({
        success: true,
        message: result.success
          ? `${normalizedEmail} was added to the group.`
          : `${normalizedEmail} was added to the group (email delivery failed).`,
      });
    }

    // ---- CASE 2: not registered yet -> send an invitation with a signup link ----
    // If there's a recent pending invitation (within last 24 hours), prevent spam.
    if (existingInvitation && existingInvitation.status === 'pending') {
      const invitationAge = Date.now() - new Date(existingInvitation.created_at).getTime();
      const hoursSinceInvitation = invitationAge / (1000 * 60 * 60);

      if (hoursSinceInvitation < 24 && !resend) {
        const hoursLeft = Math.ceil(24 - hoursSinceInvitation);
        return res.status(400).json({
          success: false,
          error: `An invitation was already sent ${hoursSinceInvitation < 1 ? 'recently' : hoursSinceInvitation.toFixed(1) + ' hours ago'}. Please wait ${hoursLeft} hours before sending another or use the resend option.`
        });
      }

      // Explicit resend, or older than 24h: expire the old one and create a fresh link.
      console.log('[group-invite] Marking old invitation as expired...');
      await db.updateInvitation(existingInvitation.id, { status: 'expired' });
    }

    console.log('[group-invite] Generating token and creating invitation...');
    const token = await generateUniqueToken();
    const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

    await db.createInvitation({
      group_id: req.group.id,
      email: normalizedEmail,
      token: token,
      invited_by: req.user.id,
      expires_at: expiresAt
    });

    // Send invitation email
    const signupUrl = `${siteOrigin()}/register?invite=${token}`;

    console.log(`[group-invite] Creating invitation for ${normalizedEmail} to group ${req.group.id}`);
    console.log(`[group-invite] Signup URL: ${signupUrl}`);

    try {
      const result = await sendMail({
        to: normalizedEmail,
        subject: `You're invited to join ${req.group.name}`,
        html: invitationEmailHtml(req.user.name, req.group.name, signupUrl),
      });

      if (result.success) {
        const message = resend ? "Invitation resent successfully." : "Invitation sent successfully.";
        console.log(`[group-invite] ${message}`);
        return res.json({ success: true, message });
      } else {
        console.error(`[group-invite] Failed to send invitation email: ${result.error}`);
        // Still return success since the invitation was created in DB
        return res.json({ success: true, message: "Invitation created (email delivery failed)." });
      }
    } catch (error) {
      console.error(`[group-invite] Error sending invitation email:`, error);
      return res.json({ success: true, message: "Invitation created (email delivery failed)." });
    }
  } catch (error) {
    console.error(`[group-invite] Error:`, error);
    return res.status(500).json({ success: false, error: "Failed to process invitation." });
  }
});

router.post("/group/leave", requireLogin, async (req, res) => {
  if (!req.user.group_id) return res.redirect("/dashboard");

  try {
    const group = await db.getGroupById(req.user.group_id);
    if (group && group.created_by === req.user.id) {
      return res.status(400).send(
        "You're the admin of this group. Remove all other members first, or transfer admin support isn't built yet."
      );
    }

    await db.removeUserFromGroup(req.user.id);
    res.redirect("/dashboard");
  } catch (error) {
    console.error(`[group-leave] Error:`, error);
    res.redirect("/dashboard");
  }
});

// Admin-only: remove a member from their group
router.post("/group/remove-member/:userId", requireLogin, requireGroupAdmin, async (req, res) => {
  try {
    const targetProfile = await db.getUserProfile(req.params.userId);
    if (!targetProfile || targetProfile.group_id !== req.group.id) {
      return res.status(404).send("Member not found in your group.");
    }
    if (targetProfile.id === req.user.id) {
      return res.status(400).send("Admin can't remove themselves. Use a future 'delete group' feature instead.");
    }
    await db.removeUserFromGroup(targetProfile.id);
    res.redirect("/admin");
  } catch (error) {
    console.error(`[group-remove-member] Error:`, error);
    res.status(500).send("Failed to remove member.");
  }
});

module.exports = router;