// One-off: re-send a pending group invitation using the hardened link builder.
// Reuses the existing DB token (no new row) so the click validates against the
// deployed /register route. Run: node scripts/resend-invite.js <email>
require("dotenv").config();
const { supabaseAdmin } = require("../src/supabase");
const { sendMail, invitationEmailHtml } = require("../src/services/email");
const { siteOrigin } = require("../src/utils/siteUrl");

const EMAIL = (process.argv[2] || "").toLowerCase().trim();
if (!EMAIL) {
  console.error("usage: node scripts/resend-invite.js <email>");
  process.exit(1);
}

(async () => {
  const { data: inv, error } = await supabaseAdmin
    .from("group_invitations")
    .select("*")
    .eq("email", EMAIL)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (error || !inv) {
    console.error("no pending invitation found:", error && error.message);
    process.exit(1);
  }

  const [{ data: group }, { data: inviter }] = await Promise.all([
    supabaseAdmin.from("groups").select("name").eq("id", inv.group_id).single(),
    supabaseAdmin.from("user_profiles").select("name").eq("id", inv.invited_by).single(),
  ]);

  const signupUrl = `${siteOrigin()}/register?invite=${inv.token}`;
  console.log("BASE_URL env  :", process.env.BASE_URL);
  console.log("signupUrl     :", signupUrl);
  console.log("group         :", group && group.name);
  console.log("inviter       :", inviter && inviter.name);

  const result = await sendMail({
    to: EMAIL,
    subject: `You're invited to join ${group ? group.name : "your prayer group"}`,
    html: invitationEmailHtml(inviter ? inviter.name : "A friend", group ? group.name : "a group", signupUrl),
  });
  console.log("send result   :", result);
  process.exit(result.success ? 0 : 1);
})();
