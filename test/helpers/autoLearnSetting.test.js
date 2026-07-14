const test = require("node:test");
const assert = require("node:assert/strict");

const { applyAutoLearnSetting } = require("../../src/helpers/autoLearnSetting");

test("reports a change when enabling from disabled", () => {
  assert.deepEqual(applyAutoLearnSetting(false, true), {
    changed: true,
    enabled: true,
  });
});

test("reports a change when disabling from enabled", () => {
  assert.deepEqual(applyAutoLearnSetting(true, false), {
    changed: true,
    enabled: false,
  });
});

test("is idempotent when the value is unchanged (enabled) — #1080 dual-window mount sync", () => {
  assert.deepEqual(applyAutoLearnSetting(true, true), {
    changed: false,
    enabled: true,
  });
});

test("is idempotent when the value is unchanged (disabled)", () => {
  assert.deepEqual(applyAutoLearnSetting(false, false), {
    changed: false,
    enabled: false,
  });
});

test("coerces truthy/falsy incoming values to boolean", () => {
  assert.deepEqual(applyAutoLearnSetting(false, 1), { changed: true, enabled: true });
  assert.deepEqual(applyAutoLearnSetting(true, 0), { changed: true, enabled: false });
  assert.deepEqual(applyAutoLearnSetting(true, undefined), {
    changed: true,
    enabled: false,
  });
});
