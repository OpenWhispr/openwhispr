const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createHotkeyRepeatGate,
  HOTKEY_REPEAT_WINDOW_MS,
} = require("../../src/helpers/hotkeyRepeatGate");

function gateAt(times) {
  let index = 0;
  return createHotkeyRepeatGate(HOTKEY_REPEAT_WINDOW_MS, () => times[index++]);
}

test("a held key is one press: autorepeats renew the window instead of leaking through", () => {
  // macOS default: first repeat 375ms after the press, then every 90ms.
  const times = [0, 375, 465, 555, 645, 735, 825, 915, 1005];
  const isPress = gateAt(times);
  assert.deepEqual(
    times.map(() => isPress()),
    [true, false, false, false, false, false, false, false, false]
  );
});

test("a deliberate second press after the window counts", () => {
  const isPress = gateAt([0, 700, 1300]);
  assert.deepEqual([isPress(), isPress(), isPress()], [true, true, true]);
});

test("a quick second tap inside the window is treated as a repeat", () => {
  const isPress = gateAt([0, 300]);
  assert.deepEqual([isPress(), isPress()], [true, false]);
});
