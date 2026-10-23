const test = require("node:test");
const assert = require("node:assert/strict");

test("a turn that keeps notes unchanged isn't offered update_note", async () => {
  const { createToolRegistry } = await import("../../src/services/tools/index.ts");
  const settings = {
    isSignedIn: false,
    calendarConnected: false,
    cloudBackupEnabled: false,
    webSearchEnabled: false,
  };

  const chat = createToolRegistry(settings);
  const chatAction = createToolRegistry({ ...settings, keepNotesUnchanged: true });

  assert.ok(chat.get("update_note"), "a plain message can still edit a note");
  assert.equal(chatAction.get("update_note"), undefined);
  assert.ok(chatAction.get("get_note"), "a chat action can still read the note");
});

test("load_skill is registered only when a skill is usable", async () => {
  const { createToolRegistry } = await import("../../src/services/tools/index.ts");
  const settings = {
    isSignedIn: false,
    calendarConnected: false,
    cloudBackupEnabled: false,
    webSearchEnabled: false,
  };
  const skills = (usable) => ({
    usable,
    activeNames: () => new Set(),
    read: async () => null,
    markUsed: () => {},
    maxTokens: 2_500,
  });
  const meetingPrep = { name: "meeting-prep", displayName: "Meeting prep", description: "Preps." };

  assert.equal(createToolRegistry(settings).get("load_skill"), undefined);
  const none = createToolRegistry({ ...settings, skills: skills([]) });
  assert.equal(none.get("load_skill"), undefined);
  assert.ok(createToolRegistry({ ...settings, skills: skills([meetingPrep]) }).get("load_skill"));
});
