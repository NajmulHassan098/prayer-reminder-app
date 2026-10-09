const jwt = require("jsonwebtoken");

const SECRET = process.env.TOKEN_SECRET || "dev_secret_change_me";

function createResponseToken(userId, prayerName, date) {
  return jwt.sign({ userId, prayerName, date }, SECRET, { expiresIn: "48h" });
}

function verifyResponseToken(token) {
  return jwt.verify(token, SECRET); // throws if invalid/expired
}

// Short-lived, single-purpose token for password resets.
function createPasswordResetToken(userId) {
  return jwt.sign({ userId, purpose: "password_reset" }, SECRET, { expiresIn: "1h" });
}

function verifyPasswordResetToken(token) {
  const payload = jwt.verify(token, SECRET); // throws if invalid/expired
  if (payload.purpose !== "password_reset") {
    throw new Error("Invalid token purpose");
  }
  return payload;
}

// Long-lived, purpose-scoped token for the personal .ics calendar feed.
// Calendar clients store the subscription URL, so it must not expire on a
// short clock like the response links; rotation happens by changing TOKEN_SECRET.
function createCalendarToken(userId) {
  return jwt.sign({ userId, purpose: "calendar" }, SECRET);
}

function verifyCalendarToken(token) {
  const payload = jwt.verify(token, SECRET); // throws if invalid
  if (payload.purpose !== "calendar") {
    throw new Error("Invalid token purpose");
  }
  return payload;
}

module.exports = {
  createResponseToken,
  verifyResponseToken,
  createPasswordResetToken,
  verifyPasswordResetToken,
  createCalendarToken,
  verifyCalendarToken,
};
