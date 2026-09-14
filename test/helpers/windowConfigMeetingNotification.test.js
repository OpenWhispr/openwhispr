const test = require("node:test");
const assert = require("node:assert/strict");

const { NOTIFICATION_WINDOW_CONFIG } = require("../../src/helpers/windowConfig");

test("meeting notifications accept the first macOS click with Electron's documented option", () => {
  assert.equal(NOTIFICATION_WINDOW_CONFIG.acceptFirstMouse, true);
  assert.equal(Object.hasOwn(NOTIFICATION_WINDOW_CONFIG, "acceptsFirstMouse"), false);
});
