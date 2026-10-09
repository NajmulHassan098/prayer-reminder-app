/**
 * User settings blob (user_profiles.settings, migration 0006) — the single
 * normalizer for everything stored there. Like parsePrefs for notifications,
 * garbage/missing values always resolve to safe defaults so a half-written
 * blob can never break a render.
 *
 * Shape:
 *   calendar: { tradition: "both"|"sunni"|"shia", dayAdjust: -1|0|1 }
 *   tasbeeh:  { target, dhikr, customDhikr, sound, haptics, lastCount }
 */

const TRADITIONS = ["both", "sunni", "shia"];
const DHIKR_PRESETS = ["SubhanAllah", "Alhamdulillah", "Allahu Akbar"];
const TASBEEH_TARGET_MAX = 10000;
const TASBEEH_COUNT_MAX = 100000;

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function parseSettings(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const cal = s.calendar && typeof s.calendar === "object" ? s.calendar : {};
  const tas = s.tasbeeh && typeof s.tasbeeh === "object" ? s.tasbeeh : {};

  const tradition = TRADITIONS.includes(cal.tradition) ? cal.tradition : "both";
  const dayAdjust = [-1, 0, 1].includes(Number(cal.dayAdjust)) ? Number(cal.dayAdjust) : 0;

  const dhikr =
    typeof tas.dhikr === "string" && DHIKR_PRESETS.includes(tas.dhikr)
      ? tas.dhikr
      : "custom";
  const customDhikr =
    typeof tas.customDhikr === "string" ? tas.customDhikr.slice(0, 80) : "";

  return {
    calendar: { tradition, dayAdjust },
    tasbeeh: {
      target: clampInt(tas.target, 1, TASBEEH_TARGET_MAX, 33),
      dhikr,
      customDhikr,
      sound: tas.sound !== false,
      haptics: tas.haptics !== false,
      lastCount: clampInt(tas.lastCount, 0, TASBEEH_COUNT_MAX, 0),
    },
  };
}

module.exports = { parseSettings, TRADITIONS, DHIKR_PRESETS, TASBEEH_TARGET_MAX, TASBEEH_COUNT_MAX, clampInt };
