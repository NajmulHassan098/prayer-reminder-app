const db = require("../db");
const { t, resolveLocale, dirAttr } = require("../utils/i18n");
const { resolveLocaleFromCountry } = require("../services/prayerTimes");
const { formatHijri } = require("../utils/hijri");

async function requireLogin(req, res, next) {
  if (!req.session.userId) {
    // Return JSON for API requests, redirect for web requests
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    return res.redirect("/login");
  }
  
  try {
    const user = await db.getUserProfile(req.session.userId);
    if (!user) {
      req.session.destroy(() => {});
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ success: false, error: 'Invalid session' });
      }
      return res.redirect("/login");
    }
    req.user = user;
    res.locals.user = user;
    // Expose translation helpers to every authenticated view. locale honors the
    // user's explicit choice, then country auto-detect, then English.
    const locale = resolveLocale(user, resolveLocaleFromCountry);
    res.locals.locale = locale;
    res.locals.dir = dirAttr(locale);
    res.locals.isRtl = res.locals.dir === "rtl";
    res.locals.t = (key, vars) => t(locale, key, vars);
    // Today's Hijri date (calculated, civil-day convention) for every
    // authenticated page — the nav shows it and it changes daily on its own.
    res.locals.hijriToday = formatHijri();
    next();
  } catch (error) {
    console.error(`[auth-middleware] Error in requireLogin:`, error);
    req.session.destroy(() => {});
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ success: false, error: 'Authentication error' });
    }
    return res.redirect("/login");
  }
}

async function requireGroupAdmin(req, res, next) {
  if (!req.user.group_id) {
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ success: false, error: 'You are not in a group.' });
    }
    return res.status(403).send("You are not in a group.");
  }
  
  try {
    const group = await db.getGroupById(req.user.group_id);
    if (!group || group.created_by !== req.user.id) {
      if (req.path.startsWith('/api/')) {
        return res.status(403).json({ success: false, error: 'Only the group admin can access this page.' });
      }
      return res.status(403).send("Only the group admin can access this page.");
    }
    req.group = group;
    next();
  } catch (error) {
    console.error(`[auth-middleware] Error in requireGroupAdmin:`, error);
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ success: false, error: 'Authentication error' });
    }
    return res.status(403).send("Authentication error.");
  }
}

module.exports = { requireLogin, requireGroupAdmin };
