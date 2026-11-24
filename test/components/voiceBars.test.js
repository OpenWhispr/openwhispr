const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SOUND_BAR_COUNT,
  SOUND_HISTORY_FRAMES,
  followLevel,
  soundBarHeight,
  soundBarLevels,
  soundLevel,
  thinkingBarLevels,
} = require("../../src/components/agent/voiceBars.ts");

test("a quiet room leaves the bars at rest", () => {
  assert.equal(soundLevel(0), 0);
  assert.equal(soundLevel(0.005), 0);
});

test("normal speech lifts the bars well past half way", () => {
  assert.ok(soundLevel(0.05) > 0.45, `quiet speech reads ${soundLevel(0.05)}`);
  assert.ok(soundLevel(0.1) > 0.7, `speech reads ${soundLevel(0.1)}`);
  assert.equal(soundLevel(0.5), 1);
});

test("the level rises faster than it falls", () => {
  const rise = followLevel(0, 1);
  const fall = 1 - followLevel(1, 0);
  assert.ok(rise > fall * 2);
});

test("each bar reads a different moment, so the bars don't move in step", () => {
  const history = Array.from({ length: SOUND_HISTORY_FRAMES }, (_, frame) => 1 - frame / 10);
  const levels = soundBarLevels(history);
  assert.equal(levels.length, SOUND_BAR_COUNT);
  assert.equal(new Set(levels).size, SOUND_BAR_COUNT);
});

test("silence keeps every bar at its resting height", () => {
  const levels = soundBarLevels(new Array(SOUND_HISTORY_FRAMES).fill(0));
  assert.deepEqual(levels, [0, 0, 0, 0]);
  assert.match(soundBarHeight(2), /^calc\(14px \+ 14px \* var\(--voice-bar-2, 0\)\)$/);
});

test("while a turn works, a low swell runs slowly across the bars, rising from rest", () => {
  assert.deepEqual(thinkingBarLevels(0), [0, 0, 0, 0]);
  const levels = thinkingBarLevels(1000);
  assert.ok(
    levels.every((lift) => lift >= 0 && lift <= 0.5),
    "a low swell"
  );
  assert.equal(new Set(levels.map((lift) => lift.toFixed(3))).size, SOUND_BAR_COUNT, "out of step");
  const later = thinkingBarLevels(1100);
  assert.ok(
    levels.every((lift, index) => Math.abs(lift - later[index]) < 0.04),
    "and slow"
  );
  const nextCycle = thinkingBarLevels(1000 + 3600);
  assert.deepEqual(
    nextCycle.map((lift) => lift.toFixed(6)),
    levels.map((lift) => lift.toFixed(6))
  );
});
