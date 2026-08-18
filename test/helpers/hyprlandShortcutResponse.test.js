const test = require("node:test");
const assert = require("node:assert/strict");

const { isHyprctlResponseOk } = require("../../src/helpers/hyprctlResponse");

test("plain ok responses are accepted", () => {
  assert.equal(isHyprctlResponseOk("ok"), true);
  assert.equal(isHyprctlResponseOk("ok\n"), true);
  assert.equal(isHyprctlResponseOk("ok\nok\n"), true);
  assert.equal(isHyprctlResponseOk("OK"), true);
});

test("empty output is not treated as a rejection", () => {
  assert.equal(isHyprctlResponseOk(""), true);
  assert.equal(isHyprctlResponseOk("\n"), true);
  assert.equal(isHyprctlResponseOk(null), true);
  assert.equal(isHyprctlResponseOk(undefined), true);
});

test("the Lua config provider rejection is detected (#1675)", () => {
  // hyprctl exits 0 for this — the rejection exists only in the response text.
  assert.equal(isHyprctlResponseOk("keyword can't work with non-legacy parsers. Use eval."), false);
});

test("other compositor error texts are detected", () => {
  assert.equal(isHyprctlResponseOk("Invalid dispatcher"), false);
  assert.equal(
    isHyprctlResponseOk("ok\nkeyword can't work with non-legacy parsers. Use eval."),
    false
  );
});
