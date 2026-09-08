const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/components/onboarding/hotkeyPresentation.ts");

test("Globe/Fn renders as one reusable physical key", async () => {
  const { getHotkeyKeycaps } = await load();

  assert.deepEqual(getHotkeyKeycaps("GLOBE"), [{ id: "Globe/Fn-0", label: "fn", symbol: "◎" }]);
});

test("compound shortcuts produce ordered keycaps and readable instructions", async () => {
  const { formatHotkeyInstruction, getHotkeyKeycaps } = await load();

  assert.deepEqual(
    getHotkeyKeycaps("Control+Shift+K").map(({ label }) => label),
    ["control", "Shift", "k"]
  );
  assert.equal(formatHotkeyInstruction("Control+Shift+K"), "Ctrl + Shift + K");
});

test("a side-specific modifier keeps its glyph and says which side in the label", async () => {
  const { getHotkeyKeycaps } = await load();

  const caps = getHotkeyKeycaps("RightOption");
  assert.equal(caps.length, 1);
  assert.equal(caps[0].symbol, "\u2325");
  assert.match(caps[0].label, /^right (option|alt)$/);
});

test("a mouse binding gets a glyph instead of printing its label into the symbol slot", async () => {
  const { getHotkeyKeycaps } = await load();

  assert.deepEqual(getHotkeyKeycaps("MouseButton4"), [
    { id: "Mouse Button 4-0", label: "mouse 4", symbol: "\u21f1" },
  ]);
});
