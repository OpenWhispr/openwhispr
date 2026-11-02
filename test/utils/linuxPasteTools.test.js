const test = require("node:test");
const assert = require("node:assert/strict");

let pasteToolsModule;

test.before(async () => {
  pasteToolsModule = await import("../../src/utils/linuxPasteTools.ts");
});

// Keys can be injected, but Wayland apps can't read the pasted text (#2621), so
// the card must still ask for wl-clipboard.
test("a missing wl-copy needs guidance even with a working paste method", () => {
  const ready = { platform: "linux", available: true, method: "uinput", requiresPermission: false };

  assert.equal(pasteToolsModule.needsLinuxPasteToolGuidance(ready), false);
  assert.equal(
    pasteToolsModule.needsLinuxPasteToolGuidance({ ...ready, wlCopyMissing: true }),
    true
  );
});
