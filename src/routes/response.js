const express = require("express");
const db = require("../db");
const { verifyResponseToken } = require("../utils/token");

const router = express.Router();

router.get("/respond", async (req, res) => {
  const { token, action } = req.query;

  if (!token || !["yes", "no"].includes(action)) {
    return res.status(400).render("respond_result", {
      ok: false,
      message: "This link is invalid.",
    });
  }

  let payload;
  try {
    payload = verifyResponseToken(token);
  } catch (err) {
    return res.status(400).render("respond_result", {
      ok: false,
      message: "This link is invalid or has expired.",
    });
  }

  const { userId, prayerName, date } = payload;
  const status = action === "yes" ? "done" : "missed";

  try {
    const user = await db.getUserProfile(userId);
    if (!user) {
      return res.status(404).render("respond_result", { ok: false, message: "User not found." });
    }

    // Check if response already exists
    const existing = await db.getResponse(userId, prayerName, date);
    
    if (existing) {
      // Update existing response
      await db.updateResponse(existing.id, {
        status: status,
        mark_source: 'email',
        responded_at: new Date().toISOString()
      });
    } else {
      // Create new response
      await db.createResponse({
        user_id: userId,
        group_id: user.group_id,
        prayer_name: prayerName,
        date: date,
        status: status,
        mark_source: 'email',
        responded_at: new Date().toISOString()
      });
    }

    // Marked successfully. Per product requirement, land the user on their own
    // dashboard (which now reflects the updated status) instead of a standalone
    // confirmation page. If they aren't logged in, requireLogin will bounce
    // them to the login screen first.
    return res.redirect("/dashboard");
  } catch (error) {
    console.error(`[respond] Error:`, error);
    res.status(500).render("respond_result", { ok: false, message: "An error occurred while processing your response." });
  }
});

module.exports = router;
