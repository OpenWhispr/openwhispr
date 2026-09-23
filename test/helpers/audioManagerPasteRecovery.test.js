const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

test("safePaste preserves exact final text only for confirmed permission recovery", async (t) => {
  const { window, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-paste-recovery-",
    settingsKey: "__pasteRecoverySettings",
  });
  const errors = [];
  const manager = createManager({
    onError: (error) => errors.push(error),
    streamingFinalText: "raw text",
  });
  const text = "  Final translated text\nwith spacing  ";
  const options = { restoreClipboard: false };
  const calls = [];
  window.electronAPI.pasteText = async (...args) => {
    calls.push(args);
    return {
      success: false,
      pasted: false,
      code: "ACCESSIBILITY_PERMISSION_REQUIRED",
      clipboardCopied: true,
    };
  };
  assert.equal(await manager.safePaste(text, options), false);
  assert.deepEqual(calls, [[text, options]]);
  assert.deepEqual(errors, [
    {
      title: "Paste Error",
      code: "ACCESSIBILITY_PERMISSION_REQUIRED",
      clipboardCopied: true,
      transcript: text,
    },
  ]);

  for (const pasted of [true, false]) {
    errors.length = 0;
    window.electronAPI.pasteText = async () => ({ success: true, pasted });
    assert.equal(await manager.safePaste(text), pasted);
    assert.deepEqual(errors, []);
  }
  window.electronAPI.pasteText = async () => {
    throw new Error("accessibility in an unrelated error");
  };
  assert.equal(await manager.safePaste(text), false);
  assert.deepEqual(errors, [
    {
      title: "Paste Error",
      code: "PASTE_FAILED",
      description: "accessibility in an unrelated error",
    },
  ]);
});
