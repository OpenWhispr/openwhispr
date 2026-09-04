const test = require("node:test");
const assert = require("node:assert/strict");

const { getAssistantPanelChrome } = require("../../src/helpers/assistantPanelChrome");

test("Linux drops always-on-top while the assistant panel needs the keyboard", () => {
  assert.deepEqual(getAssistantPanelChrome({ platform: "linux", open: true }), {
    focusable: true,
    alwaysOnTop: false,
    skipTaskbar: false,
  });
});

test("Linux restores overlay chrome when the assistant panel closes", () => {
  assert.deepEqual(getAssistantPanelChrome({ platform: "linux", open: false }), {
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
  });
});

test("macOS and Windows keep the overlay above other windows while the panel is open", () => {
  for (const platform of ["darwin", "win32"]) {
    assert.deepEqual(getAssistantPanelChrome({ platform, open: true }), {
      focusable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
    });
  }
});
