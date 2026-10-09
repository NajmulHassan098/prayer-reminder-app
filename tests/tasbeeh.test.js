// Unit tests for the tasbeeh counter core (public/tasbeeh-core.js) and the
// settings normalizer. Pure state machine — no DOM, no timers.
const test = require("node:test");
const assert = require("node:assert");

const C = require("../public/tasbeeh-core.js");
const { parseSettings } = require("../src/utils/settings");

test("tasbeeh: increment builds an undo history capped at 20", () => {
  let s = C.initialState();
  for (let i = 0; i < 30; i++) s = C.next(s, { type: "increment" });
  assert.strictEqual(s.count, 30);
  assert.strictEqual(s.undoStack.length, C.UNDO_DEPTH);
  // Undo walks back through the most recent values only.
  s = C.next(s, { type: "undo" });
  assert.strictEqual(s.count, 29);
});

test("tasbeeh: undo past zero clamps at 0, reset clears everything", () => {
  let s = C.initialState();
  s = C.next(s, { type: "increment" });
  s = C.next(s, { type: "undo" });
  assert.strictEqual(s.count, 0);
  s = C.next(s, { type: "undo" }); // undo with empty stack stays at 0
  assert.strictEqual(s.count, 0);
  for (let i = 0; i < 5; i++) s = C.next(s, { type: "increment" });
  s = C.next(s, { type: "reset" });
  assert.deepStrictEqual([s.count, s.undoStack.length, s.completedAt], [0, 0, null]);
});

test("tasbeeh: rapid taps never drop a count (50 dispatches)", () => {
  let s = C.initialState();
  for (let i = 0; i < 50; i++) s = C.next(s, { type: "increment" });
  assert.strictEqual(s.count, 50);
});

test("tasbeeh: count is capped at 100 000 and flags gently", () => {
  let s = C.initialState({ count: 99999 });
  s = C.next(s, { type: "increment" });
  assert.strictEqual(s.count, 100000);
  assert.strictEqual(s.capped, false);
  s = C.next(s, { type: "increment" });
  assert.strictEqual(s.count, 100000);
  assert.strictEqual(s.capped, true);
});

test("tasbeeh: completion cue fires on every full round, not just the first", () => {
  let s = C.initialState({ target: 3 });
  s = C.next(s, { type: "increment" });
  s = C.next(s, { type: "increment" });
  assert.strictEqual(s.completedAt, null);
  s = C.next(s, { type: "increment" });
  assert.strictEqual(s.completedAt, 3); // 3/3
  s = C.next(s, { type: "increment" });
  assert.strictEqual(s.completedAt, 3); // 4/3 — cue holds until the next round
  for (let i = 0; i < 2; i++) s = C.next(s, { type: "increment" });
  assert.strictEqual(s.completedAt, 6); // 6/3
});

test("tasbeeh: setTarget clamps; custom dhikr truncates at 80 chars", () => {
  let s = C.initialState();
  s = C.next(s, { type: "setTarget", value: 0 });
  assert.strictEqual(s.target, 1); // clamped up, never rejected (documented rule)
  s = C.next(s, { type: "setTarget", value: 999999 });
  assert.strictEqual(s.target, C.TARGET_MAX);
  s = C.next(s, { type: "setDhikr", value: "custom", custom: "x".repeat(200) });
  assert.strictEqual(s.customDhikr.length, 80);
  assert.strictEqual(C.dhikrLabel(s), "x".repeat(80));
  s = C.next(s, { type: "setDhikr", value: "bogus" }); // rejected, keeps custom
  assert.strictEqual(s.dhikr, "custom");
});

test("tasbeeh: corrupt or hostile stored JSON loads as a fresh valid state", () => {
  assert.strictEqual(C.loadJSON("not json"), null);
  assert.strictEqual(C.loadJSON("[1,2]"), null);
  assert.strictEqual(C.loadJSON(""), null);
  const s = C.loadJSON('{"count":10000000000,"target":-5,"dhikr":{"evil":1},"__proto__":{"polluted":true}}');
  assert.ok(s);
  assert.strictEqual(s.count, C.COUNT_MAX); // clamped, not NaN
  assert.strictEqual(s.target, 1); // clamped to min
  assert.strictEqual(s.dhikr, "SubhanAllah"); // non-string rejected to default
  assert.strictEqual({}.polluted, undefined);
});

test("tasbeeh: toggle only accepts sound/haptics", () => {
  let s = C.initialState();
  s = C.next(s, { type: "toggle", key: "sound" });
  assert.strictEqual(s.sound, false);
  const before = s;
  s = C.next(s, { type: "toggle", key: "count" }); // refused
  assert.strictEqual(s, before);
});

// ---- settings normalizer (shared with the calendar) ------------------------
test("parseSettings: empty/garbage input yields safe defaults", () => {
  for (const raw of [undefined, null, "str", 42, [], {}]) {
    const s = parseSettings(raw);
    assert.strictEqual(s.calendar.tradition, "both");
    assert.strictEqual(s.calendar.dayAdjust, 0);
    assert.strictEqual(s.tasbeeh.target, 33);
    assert.strictEqual(s.tasbeeh.lastCount, 0);
  }
});

test("parseSettings: clamps dayAdjust and dhikr, keeps valid values", () => {
  const s = parseSettings({
    calendar: { tradition: "shia", dayAdjust: 5 },
    tasbeeh: { target: "99", dhikr: "Allahu Akbar", lastCount: -3 },
  });
  assert.strictEqual(s.calendar.tradition, "shia");
  assert.strictEqual(s.calendar.dayAdjust, 0); // outside the discrete set {-1,0,1} → default
  assert.strictEqual(s.tasbeeh.target, 99);
  assert.strictEqual(s.tasbeeh.dhikr, "Allahu Akbar");
  assert.strictEqual(s.tasbeeh.lastCount, 0);
});
