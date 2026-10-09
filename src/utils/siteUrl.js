// Resolve the public origin used to build links inside outbound emails.
//
// BASE_URL is occasionally misconfigured with a trailing slash or an extra path
// segment (e.g. https://app.vercel.app/dashboard). String-concatenating such a
// value corrupts generated links into 404s like /dashboard/respond or
// /dashboard/register. Taking only the URL *origin* makes every email link
// correct regardless of how BASE_URL is formatted.
function siteOrigin() {
  const raw = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  try {
    return new URL(raw).origin;
  } catch (err) {
    // Fall back to trimming any trailing slashes if BASE_URL isn't parseable.
    return raw.replace(/\/+$/, "");
  }
}

module.exports = { siteOrigin };
