const test = require("node:test");
const assert = require("node:assert/strict");

let voiceModes;

test.before(async () => {
  voiceModes = await import("../../src/utils/voiceModes.ts");
});

const modes = [
  {
    id: "1",
    name: "Work",
    apps: ["Slack", "com.tinyspeck.slackmacgap"],
    instructions: "Be formal.",
  },
  { id: "2", name: "Chat", apps: ["ChatGPT"], instructions: "  Be casual.  " },
  { id: "3", name: "Empty", apps: ["Notes"], instructions: "   " },
];

test("matches the macOS app name case-insensitively", () => {
  const mode = voiceModes.resolveVoiceMode(modes, {
    name: "slack",
    bundleId: null,
    windowClass: null,
  });
  assert.deepEqual(mode, { appName: "slack", instructions: "Be formal." });
});

test("matches the bundle id when the name differs", () => {
  const mode = voiceModes.resolveVoiceMode(modes, {
    name: "Slack Helper",
    bundleId: "com.tinyspeck.slackmacgap",
    windowClass: null,
  });
  assert.equal(mode?.instructions, "Be formal.");
});

test("a Windows exe name matches the bare app name and trims the instructions", () => {
  const mode = voiceModes.resolveVoiceMode(modes, {
    name: "ChatGPT.exe",
    bundleId: null,
    windowClass: "Chrome_WidgetWin_1",
  });
  assert.deepEqual(mode, { appName: "ChatGPT.exe", instructions: "Be casual." });
});

test("a Linux window class matches and falls back to the listed app for the prompt", () => {
  const mode = voiceModes.resolveVoiceMode(modes, {
    name: null,
    bundleId: null,
    windowClass: "slack",
  });
  assert.deepEqual(mode, { appName: "Slack", instructions: "Be formal." });
});

test("a mode without instructions never matches", () => {
  assert.equal(
    voiceModes.resolveVoiceMode(modes, { name: "Notes", bundleId: null, windowClass: null }),
    null
  );
});

test("an unknown, missing, or unidentifiable target yields no mode", () => {
  assert.equal(
    voiceModes.resolveVoiceMode(modes, { name: "Mail", bundleId: null, windowClass: null }),
    null
  );
  assert.equal(voiceModes.resolveVoiceMode(modes, null), null);
  assert.equal(
    voiceModes.resolveVoiceMode(modes, { name: null, bundleId: null, windowClass: null }),
    null
  );
});
