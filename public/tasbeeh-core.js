/**
 * Tasbeeh counter core — pure, dependency-free state machine shared by the
 * /tasbeeh page (served statically as window.TasbeehCore) and the Node unit
 * tests (module.exports). Keeping every rule here means the browser page is
 * just wiring (tap → dispatch → paint) and all the tricky parts — undo stack,
 * caps, clamping, completion detection, corrupt-storage recovery — are
 * testable without a DOM.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TasbeehCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var COUNT_MAX = 100000;      // gentle ceiling; increments past it are ignored
  var TARGET_MIN = 1;
  var TARGET_MAX = 10000;
  var UNDO_DEPTH = 20;
  var DHIKR_PRESETS = ["SubhanAllah", "Alhamdulillah", "Allahu Akbar"];
  var CUSTOM_MAX = 80;

  var DEFAULTS = {
    count: 0,
    target: 33,
    dhikr: "SubhanAllah", // one of DHIKR_PRESETS, or "custom"
    customDhikr: "",
    sound: true,
    haptics: true,
  };

  function clamp(n, min, max, dflt) {
    n = Number(n);
    if (!isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  /** Normalize any partial/attacked state object into a valid one. */
  function sanitize(s) {
    s = s && typeof s === "object" ? s : {};
    var dhikr =
      typeof s.dhikr === "string" &&
      (DHIKR_PRESETS.indexOf(s.dhikr) !== -1 || s.dhikr === "custom")
        ? s.dhikr
        : DEFAULTS.dhikr;
    return {
      count: clamp(s.count, 0, COUNT_MAX, 0),
      target: clamp(s.target, TARGET_MIN, TARGET_MAX, DEFAULTS.target),
      dhikr: dhikr,
      customDhikr:
        typeof s.customDhikr === "string"
          ? s.customDhikr.slice(0, CUSTOM_MAX)
          : "",
      sound: s.sound !== false,
      haptics: s.haptics !== false,
    };
  }

  function initialState(overrides) {
    var s = sanitize(Object.assign({}, DEFAULTS, overrides || {}));
    s.undoStack = [];
    s.capped = false;
    s.completedAt = null; // the count value at which the last cue fired
    return s;
  }

  /** The dhikr text currently displayed. */
  function dhikrLabel(state) {
    if (state.dhikr === "custom") {
      return state.customDhikr || "Your dhikr";
    }
    return state.dhikr;
  }

  /**
   * Pure reducer: next(state, action) -> newState (shares references where
   * unchanged; the caller repaints from the returned object).
   * Actions: increment | undo | reset | setTarget | setDhikr | toggle
   */
  function next(state, action) {
    if (!action || !action.type) return state;
    switch (action.type) {
      case "increment": {
        if (state.count >= COUNT_MAX) {
          return state.capped ? state : Object.assign({}, state, { capped: true });
        }
        var count = state.count + 1;
        var stack = state.undoStack.concat(state.count).slice(-UNDO_DEPTH);
        // Completion fires when a full round of `target` finishes (so it also
        // works past the first target: 33, 66, 99 ...). Counting continues.
        var completedAt = count % state.target === 0 ? count : state.completedAt;
        return Object.assign({}, state, {
          count: count,
          undoStack: stack,
          capped: false,
          completedAt: completedAt,
        });
      }
      case "undo": {
        if (!state.undoStack.length) {
          return state.count === 0 ? state : Object.assign({}, state, { count: 0, completedAt: null });
        }
        var stack2 = state.undoStack.slice(0, -1);
        var prev = state.undoStack[state.undoStack.length - 1];
        return Object.assign({}, state, {
          count: prev,
          undoStack: stack2,
          capped: false,
          completedAt: prev % state.target === 0 && prev !== 0 ? prev : null,
        });
      }
      case "reset":
        return Object.assign({}, state, {
          count: 0,
          undoStack: [],
          capped: false,
          completedAt: null,
        });
      case "setTarget": {
        var target = clamp(action.value, TARGET_MIN, TARGET_MAX, state.target);
        return Object.assign({}, state, { target: target, completedAt: null });
      }
      case "setDhikr": {
        var patch = Object.assign({}, state);
        if (typeof action.value === "string" && action.value === "custom") {
          patch.dhikr = "custom";
        } else if (DHIKR_PRESETS.indexOf(action.value) !== -1) {
          patch.dhikr = action.value;
        }
        if (typeof action.custom === "string") {
          patch.customDhikr = action.custom.slice(0, CUSTOM_MAX);
        }
        return patch;
      }
      case "toggle":
        if (action.key !== "sound" && action.key !== "haptics") return state;
        var t = Object.assign({}, state);
        t[action.key] = !state[action.key];
        return t;
      default:
        return state;
    }
  }

  /** Parse persisted JSON safely — anything corrupt falls back to defaults. */
  function loadJSON(str) {
    if (typeof str !== "string" || !str) return null;
    try {
      var raw = JSON.parse(str);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      var s = initialState(raw);
      return s;
    } catch (e) {
      return null;
    }
  }

  function saveJSON(state) {
    var s = sanitize(state);
    s.updatedAt = Date.now();
    return JSON.stringify(s);
  }

  /** Progress within the current round, 0..1 — for the ring. */
  function roundProgress(state) {
    return state.target > 0 ? (state.count % state.target) / state.target : 0;
  }

  return {
    DEFAULTS: DEFAULTS,
    COUNT_MAX: COUNT_MAX,
    TARGET_MAX: TARGET_MAX,
    UNDO_DEPTH: UNDO_DEPTH,
    DHIKR_PRESETS: DHIKR_PRESETS,
    initialState: initialState,
    sanitize: sanitize,
    next: next,
    loadJSON: loadJSON,
    saveJSON: saveJSON,
    dhikrLabel: dhikrLabel,
    roundProgress: roundProgress,
  };
});
