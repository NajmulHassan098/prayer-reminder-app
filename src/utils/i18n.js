// Minimal, dependency-free i18n. Five locales (en/ur/tr/ar/id); every lookup
// falls back to the English dictionary so a missing or mistyped key can never
// crash a render or blank an email. Non-English strings are best-effort and are
// expected to be reviewed by native speakers before heavy production email use —
// the fallback design means that review can happen key-by-key without risk.

const fs = require("fs");
const path = require("path");

const SUPPORTED = ["en", "ur", "tr", "ar", "id"];
const RTL = ["ur", "ar"];
const FALLBACK = "en";

const dicts = {};
for (const loc of SUPPORTED) {
  try {
    dicts[loc] = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "i18n", `${loc}.json`), "utf8"));
  } catch (err) {
    console.error(`[i18n] Failed to load locale "${loc}":`, err.message);
    dicts[loc] = {};
  }
}

// Warn once per missing key so a translation gap is visible in logs but never
// noisy and never fatal.
const warned = new Set();

// Translate a dotted key for a locale, interpolating {{var}} placeholders.
// Interpolation values are inserted as-is (callers pass plain data, not HTML).
function t(locale, key, vars) {
  const loc = SUPPORTED.includes(locale) ? locale : FALLBACK;
  let str = dicts[loc] && dicts[loc][key];
  if (str == null) {
    str = dicts[FALLBACK][key];
    if (str == null) {
      if (!warned.has(key)) {
        warned.add(key);
        console.warn(`[i18n] Missing key: ${key}`);
      }
      str = key;
    }
  }
  if (vars) {
    str = str.replace(/\{\{(\w+)\}\}/g, (m, name) =>
      vars[name] != null ? String(vars[name]) : m
    );
  }
  return str;
}

// Resolve the effective locale for a user: an explicit, supported stored choice
// wins; otherwise auto-detect from country; final fallback English.
function resolveLocale(user, countryToLocale) {
  const explicit = user && user.locale;
  if (explicit && SUPPORTED.includes(explicit)) return explicit;
  if (countryToLocale && user && user.country) {
    const auto = countryToLocale(user.country);
    if (auto && SUPPORTED.includes(auto)) return auto;
  }
  return FALLBACK;
}

function isRtl(locale) {
  return RTL.includes(locale);
}

// HTML dir attribute for a locale, for <html>/email wrappers.
function dirAttr(locale) {
  return isRtl(locale) ? "rtl" : "ltr";
}

module.exports = { t, resolveLocale, isRtl, dirAttr, SUPPORTED, RTL, FALLBACK };
