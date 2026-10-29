const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

test("batch cleanup preserves spoken paragraph commands through the actual audio core", async (t) => {
  const { createManager, setSettings } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-spoken-paragraphs-",
    settingsKey: "__spokenParagraphSettings",
    settings: {
      useCleanupModel: true,
      cleanupMode: "local",
      cleanupProvider: "local",
      cleanupModel: "cleanup-test-model",
      preferredLanguage: "en-GB",
      useDictationAgent: false,
      useDictationTranslation: false,
    },
    mockModules: {
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__spokenParagraphSettings;
        export const getEffectiveCleanupModel = () => "cleanup-test-model";
        export const selectResolvedLLMConfig = () => ({
          mode: "local", provider: "local", model: "cleanup-test-model"
        });
        export const isCloudCleanupMode = () => false;
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
        export const useSettingsStore = { subscribe: () => () => {} };
      `,
    },
  });

  const makeManager = (cleanup) =>
    createManager({
      voiceAgentRequested: false,
      translationRequested: false,
      pendingCleanupFailure: null,
      isReasoningAvailable: async () => true,
      processWithReasoningModel: cleanup,
    });

  await t.test(
    "literal model output still produces real paragraph breaks in one call",
    async () => {
      const calls = [];
      const manager = makeManager(async (text, model, _agent, config) => {
        calls.push(text);
        assert.equal(model, "cleanup-test-model");
        assert.equal(config.requireCompleteOutput, true);
        return text;
      });
      const input = "Right pressure 16 mmHg. New paragraph. Left pressure 18 mmHg.";
      assert.equal(
        await manager.processTranscription(input, "openai"),
        "Right pressure 16 mmHg.\n\nLeft pressure 18 mmHg."
      );
      assert.deepEqual(calls, [input]);
    }
  );

  await t.test("deleted commands retain cleaned sentence punctuation", async () => {
    const manager = makeManager(async () => "Dear Alex, The report is ready.");
    assert.equal(
      await manager.processTranscription("Dear Alex. New paragraph. The report is ready.", "local"),
      "Dear Alex,\n\nThe report is ready."
    );
  });

  await t.test(
    "command-only dictation bypasses cleanup and survives blank-output fallback",
    async () => {
      const manager = makeManager(async () => assert.fail("cleanup should not run"));
      assert.equal(await manager.processTranscription("  New paragraph. \n", "openai"), "\n\n");
    }
  );

  await t.test("repeated commands preserve repeated paragraph breaks", async () => {
    const manager = makeManager(async (text) => text);
    assert.equal(
      await manager.processTranscription("One. New paragraph. New paragraph. Two.", "openai"),
      "One.\n\n\n\nTwo."
    );
  });

  await t.test(
    "failed cleanup preserves raw words with paragraph breaks and its warning",
    async () => {
      const manager = makeManager(async () => {
        throw new Error("synthetic cleanup failure");
      });
      assert.equal(
        await manager.processTranscription("One. New paragraph. Two.", "local"),
        "One.\n\nTwo."
      );
      assert.equal(manager.pendingCleanupFailure.message, "synthetic cleanup failure");
    }
  );

  await t.test("comma-separated shortcut mentions survive batch cleanup", async () => {
    const manager = makeManager(async (text) => text);
    const input = "Available shortcuts include new line, new paragraph, and undo.";
    assert.equal(await manager.processTranscription(input, "local"), input);
  });

  await t.test("a model-added bullet stays attached after batch cleanup", async () => {
    const manager = makeManager(async () => "Shopping list:\n\n- Apples and bananas.");
    assert.equal(
      await manager.processTranscription(
        "Shopping list. New paragraph. Apples and bananas.",
        "local"
      ),
      "Shopping list:\n\n- Apples and bananas."
    );
  });

  await t.test("non-English cleanup keeps existing behavior", async () => {
    setSettings({ ...globalThis.__spokenParagraphSettings, preferredLanguage: "fr" });
    const manager = makeManager(async (text) => text);
    const input = "One. New paragraph. Two.";
    assert.equal(await manager.processTranscription(input, "local"), input);
  });
});
