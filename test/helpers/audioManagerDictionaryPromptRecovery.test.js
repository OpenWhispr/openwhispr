const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

const DICTIONARY_PROMPT = [
  "OpenWhispr",
  "Parakeet",
  "Alcahest",
  "Chromium",
  "TypeScript",
  "Electron",
  "testing",
  "data",
  "benchmark",
  "inference",
  "transcription",
  "dictionary",
  "microphone",
  "renderer",
  "latency",
  "pipeline",
].join(", ");

const AUDIO_BLOB = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" });

function queueTranscriptions(window, outcomes) {
  const calls = [];
  window.electronAPI.transcribeLocalWhisper = async (arrayBuffer, options) => {
    const outcome = outcomes[calls.length];
    calls.push({ arrayBuffer, options });
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return calls;
}

test("local Whisper recovers dictionary prompt echoes and fragments", async (t) => {
  globalThis.__dictionaryPromptRecoveryLogs = [];
  t.after(() => {
    delete globalThis.__dictionaryPromptRecoveryLogs;
  });

  const baseSettings = {
    allowOpenAIFallback: false,
    cloudTranscriptionProvider: "openai",
    useLocalWhisper: true,
    localTranscriptionProvider: "whisper",
    whisperModel: "base",
    cloudTranscriptionMode: "byok",
    isSignedIn: false,
  };
  const { window, createManager, setSettings } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-dictionary-prompt-recovery-test-",
    settingsKey: "__dictionaryPromptRecoverySettings",
    settings: baseSettings,
    mockModules: {
      "/utils/logger": `
        export default {
          debug() {},
          info(message, data, category) {
            globalThis.__dictionaryPromptRecoveryLogs.push({ message, data, category });
          },
          warn(message, data, category) {
            globalThis.__dictionaryPromptRecoveryLogs.push({ level: "warn", message, data, category });
          },
          error() {},
          logReasoning() {},
        };
      `,
    },
  });

  const createRecoveryManager = (dictionaryPrompt = DICTIONARY_PROMPT) => {
    const processedTexts = [];
    const manager = createManager({
      getEffectiveSttLanguage: () => "en-US",
      getCustomDictionaryPrompt: () => dictionaryPrompt,
      getWhisperPrompt: () => dictionaryPrompt,
      processTranscription: async (text) => {
        processedTexts.push(text);
        return `processed: ${text}`;
      },
    });
    return { manager, processedTexts };
  };

  await t.test("a short prompt fragment uses the fuller prompt-free retry", async () => {
    globalThis.__dictionaryPromptRecoveryLogs.length = 0;
    const fullTranscript = "The database migration completed successfully.";
    const calls = queueTranscriptions(window, [
      { success: true, text: "data, data, data, data," },
      { success: true, text: fullTranscript },
    ]);
    const { manager, processedTexts } = createRecoveryManager();

    const result = await manager.processWithLocalWhisper(AUDIO_BLOB, "base");

    assert.equal(result.rawText, fullTranscript);
    assert.equal(result.text, `processed: ${fullTranscript}`);
    assert.deepEqual(processedTexts, [fullTranscript]);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].options, {
      model: "base",
      language: "en",
      initialPrompt: DICTIONARY_PROMPT,
    });
    assert.deepEqual(calls[1].options, { model: "base", language: "en", skipVad: true });

    const recoveryLog = globalThis.__dictionaryPromptRecoveryLogs.find(
      ({ message }) => message === "Local dictionary-prompt recovery attempt"
    );
    assert.equal(recoveryLog.data.reason, "prompt-fragment");
    assert.equal(recoveryLog.data.promptLength, DICTIONARY_PROMPT.length);
    assert.equal(recoveryLog.data.initialTextLength, "data, data, data, data,".length);
    assert.equal(recoveryLog.data.retryTextLength, fullTranscript.length);
    assert.equal(recoveryLog.data.recovered, true);
    assert.equal(Number.isInteger(recoveryLog.data.retryDurationMs), true);
    assert.equal(Object.values(recoveryLog.data).includes(DICTIONARY_PROMPT), false);
  });

  await t.test("a strict echo accepts a short dictionary-spelled retry", async () => {
    // The retry is the recovered dictation, so only another full-prompt echo may
    // reject it — the fragment heuristic would discard a genuine two-term list.
    const calls = queueTranscriptions(window, [
      { success: true, text: DICTIONARY_PROMPT },
      { success: true, text: "OpenWhispr, Parakeet" },
    ]);
    const { manager, processedTexts } = createRecoveryManager();

    const result = await manager.processWithLocalWhisper(AUDIO_BLOB, "base", {
      durationSeconds: 4,
    });

    assert.equal(result.rawText, "OpenWhispr, Parakeet");
    assert.deepEqual(processedTexts, ["OpenWhispr, Parakeet"]);
    assert.equal(calls.length, 2);
  });

  await t.test("ordinary speech spelled from snippet-trigger words is never retried", async () => {
    const prompt = `${DICTIONARY_PROMPT}, on my way, let me know`;
    const calls = queueTranscriptions(window, [
      { success: true, text: "On my way." },
      { success: true, text: "I am on my way to the office now." },
    ]);
    const { manager, processedTexts } = createRecoveryManager(prompt);

    const result = await manager.processWithLocalWhisper(AUDIO_BLOB, "base", {
      durationSeconds: 4,
    });

    assert.equal(result.rawText, "On my way.");
    assert.deepEqual(processedTexts, ["On my way."]);
    assert.equal(calls.length, 1);
  });

  await t.test("comma-separated dictionary terms are dictation, never retried", async () => {
    const calls = queueTranscriptions(window, [
      { success: true, text: "Electron, renderer" },
      { success: true, text: "electron rendered a late in sea" },
    ]);
    const { manager, processedTexts } = createRecoveryManager();

    const result = await manager.processWithLocalWhisper(AUDIO_BLOB, "base", {
      durationSeconds: 5,
    });

    assert.equal(result.rawText, "Electron, renderer");
    assert.deepEqual(processedTexts, ["Electron, renderer"]);
    assert.equal(calls.length, 1);
  });

  await t.test("a genuinely doubled dictionary term is never retried", async () => {
    const calls = queueTranscriptions(window, [
      { success: true, text: "OpenWhispr, OpenWhispr" },
      { success: true, text: "open whisper open whisper too" },
    ]);
    const { manager } = createRecoveryManager();

    const result = await manager.processWithLocalWhisper(AUDIO_BLOB, "base", {
      durationSeconds: 4,
    });

    assert.equal(result.rawText, "OpenWhispr, OpenWhispr");
    assert.equal(calls.length, 1);
  });

  await t.test("a long recording keeps correct dictionary terms it decoded", async () => {
    const calls = queueTranscriptions(window, [
      { success: true, text: "Electron renderer latency" },
      { success: true, text: "electron render or latency issue" },
    ]);
    const { manager } = createRecoveryManager();

    const result = await manager.processWithLocalWhisper(AUDIO_BLOB, "base", {
      durationSeconds: 6,
    });

    assert.equal(result.rawText, "Electron renderer latency");
    assert.equal(calls.length, 1);
  });

  await t.test("a hallucinated retry never replaces a genuine dictionary term", async () => {
    const calls = queueTranscriptions(window, [
      { success: true, text: "testing" },
      { success: true, text: "Thank you for watching!" },
    ]);
    const { manager } = createRecoveryManager();

    const result = await manager.processWithLocalWhisper(AUDIO_BLOB, "base", {
      durationSeconds: 6,
    });

    assert.equal(result.rawText, "testing");
    assert.equal(calls.length, 1);
  });

  await t.test("a fragment the retry could not replace skips the retry entirely", async () => {
    const calls = queueTranscriptions(window, [
      { success: true, text: "testing," },
      { success: true, text: "The whole sentence I actually said." },
    ]);
    const { manager } = createRecoveryManager();

    const result = await manager.processWithLocalWhisper(AUDIO_BLOB, "base", {
      durationSeconds: 2,
    });

    assert.equal(result.rawText, "testing,");
    assert.equal(calls.length, 1);
  });

  await t.test("a correct short dictionary term survives an unrelated longer retry", async () => {
    const calls = queueTranscriptions(window, [
      { success: true, text: "testing" },
      { success: true, text: "testing the unrelated application" },
    ]);
    const { manager, processedTexts } = createRecoveryManager();

    const result = await manager.processWithLocalWhisper(AUDIO_BLOB, "base", {
      durationSeconds: 1,
    });

    assert.equal(result.rawText, "testing");
    assert.deepEqual(processedTexts, ["testing"]);
    assert.equal(calls.length, 1);
  });

  await t.test("an exact snippet trigger survives an equally rich retry", async () => {
    const prompt = `${DICTIONARY_PROMPT}, cal link`;
    const calls = queueTranscriptions(window, [
      { success: true, text: "cal link" },
      { success: true, text: "calendar hyperlink" },
    ]);
    const { manager, processedTexts } = createRecoveryManager(prompt);

    const result = await manager.processWithLocalWhisper(AUDIO_BLOB, "base", {
      durationSeconds: 1,
    });

    assert.equal(result.rawText, "cal link");
    assert.deepEqual(processedTexts, ["cal link"]);
    assert.equal(calls.length, 1);
  });

  await t.test("a sparse long recording uses a materially fuller retry", async () => {
    const fullTranscript = "The complete sentence was recovered from the recording.";
    // The literal output reported in #1889 — a dictionary term carrying the
    // prompt's own ", " separator.
    const calls = queueTranscriptions(window, [
      { success: true, text: "testing, " },
      { success: true, text: fullTranscript },
    ]);
    const { manager } = createRecoveryManager();

    const result = await manager.processWithLocalWhisper(AUDIO_BLOB, "base", {
      durationSeconds: 5,
    });

    assert.equal(result.rawText, fullTranscript);
    assert.equal(calls.length, 2);
  });

  await t.test("a consecutive-term continuation recovers past the length cap", async () => {
    const fullTranscript = "The quarterly report is ready for review.";
    const calls = queueTranscriptions(window, [
      { success: true, text: "TypeScript, Electron, testing, data, benchmark" },
      { success: true, text: fullTranscript },
    ]);
    const { manager } = createRecoveryManager();

    const result = await manager.processWithLocalWhisper(AUDIO_BLOB, "base", {
      durationSeconds: 6,
    });

    assert.equal(result.rawText, fullTranscript);
    assert.equal(calls.length, 2);
  });

  await t.test("a sparse retry below the unique-word gain keeps the fragment", async () => {
    const calls = queueTranscriptions(window, [
      { success: true, text: "testing, " },
      { success: true, text: "yes please" },
    ]);
    const { manager } = createRecoveryManager();

    const result = await manager.processWithLocalWhisper(AUDIO_BLOB, "base", {
      durationSeconds: 5,
    });

    assert.equal(result.rawText, "testing, ");
    assert.equal(calls.length, 2);
  });

  await t.test("a repeated fragment yields to a shorter retry with more unique words", async () => {
    const calls = queueTranscriptions(window, [
      { success: true, text: "data, data, data, data," },
      { success: true, text: "data is valid" },
    ]);
    const { manager } = createRecoveryManager();

    const result = await manager.processWithLocalWhisper(AUDIO_BLOB, "base");

    assert.equal(result.rawText, "data is valid");
    assert.equal(calls.length, 2);
  });

  await t.test("a repeated long dictionary term triggers recovery", async () => {
    const fullTranscript = "The application opened successfully.";
    const calls = queueTranscriptions(window, [
      { success: true, text: "OpenWhispr, OpenWhispr, OpenWhispr" },
      { success: true, text: fullTranscript },
    ]);
    const { manager } = createRecoveryManager();

    const result = await manager.processWithLocalWhisper(AUDIO_BLOB, "base");

    assert.equal(result.rawText, fullTranscript);
    assert.equal(calls.length, 2);
  });

  await t.test("a strict full-prompt echo accepts a non-prompt retry", async () => {
    const fullTranscript = "This is the complete dictated sentence.";
    const calls = queueTranscriptions(window, [
      { success: true, text: DICTIONARY_PROMPT },
      { success: true, text: fullTranscript },
    ]);
    const { manager, processedTexts } = createRecoveryManager();

    const result = await manager.processWithLocalWhisper(AUDIO_BLOB, "small.en");

    assert.equal(result.rawText, fullTranscript);
    assert.deepEqual(processedTexts, [fullTranscript]);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.model, "small.en");
    assert.equal(calls[1].options.language, "en");
    assert.equal(calls[1].options.initialPrompt, undefined);
    assert.equal(calls[1].options.skipVad, true);
  });

  await t.test("a strict echo rejects a prompt-free retry that is still the prompt", async () => {
    const calls = queueTranscriptions(window, [
      { success: true, text: DICTIONARY_PROMPT },
      { success: true, text: DICTIONARY_PROMPT },
    ]);
    const { manager, processedTexts } = createRecoveryManager();

    await assert.rejects(manager.processWithLocalWhisper(AUDIO_BLOB, "base"), (error) => {
      assert.equal(error.message, "No audio detected");
      assert.equal(error.code, "DICTIONARY_ECHO");
      return true;
    });

    assert.deepEqual(processedTexts, []);
    assert.equal(calls.length, 2);
  });

  await t.test("classification uses the exact prompt sent with the initial request", async () => {
    const fullTranscript = "The complete transcript came from the saved audio.";
    const calls = queueTranscriptions(window, [
      { success: true, text: DICTIONARY_PROMPT },
      { success: true, text: fullTranscript },
    ]);
    const { manager } = createRecoveryManager();
    let promptReads = 0;
    manager.getCustomDictionaryPrompt = () => null;
    manager.getWhisperPrompt = () => {
      promptReads += 1;
      return promptReads === 1 ? DICTIONARY_PROMPT : "A different dictionary prompt";
    };

    const result = await manager.processWithLocalWhisper(AUDIO_BLOB, "base");

    assert.equal(result.rawText, fullTranscript);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.initialPrompt, DICTIONARY_PROMPT);
    assert.equal(promptReads, 1);
  });

  for (const [description, retryOutcome] of [
    ["a failed", new Error("GPU inference failed")],
    ["an empty", { success: true, text: "   " }],
    ["a shorter", { success: true, text: "data" }],
  ]) {
    await t.test(`${description} heuristic retry preserves the original fragment`, async () => {
      const originalText = "data, data, data, data,";
      const calls = queueTranscriptions(window, [
        { success: true, text: originalText },
        retryOutcome,
      ]);
      const { manager, processedTexts } = createRecoveryManager();

      const result = await manager.processWithLocalWhisper(AUDIO_BLOB, "base");

      assert.equal(result.rawText, originalText);
      assert.equal(result.text, `processed: ${originalText}`);
      assert.deepEqual(processedTexts, [originalText]);
      assert.equal(calls.length, 2);
    });
  }

  await t.test("a failed fragment retry is logged before keeping the initial text", async () => {
    globalThis.__dictionaryPromptRecoveryLogs.length = 0;
    const calls = queueTranscriptions(window, [
      { success: true, text: "data, data, data, data," },
      new Error("GPU inference failed"),
    ]);
    const { manager } = createRecoveryManager();

    const result = await manager.processWithLocalWhisper(AUDIO_BLOB, "base");

    assert.equal(result.rawText, "data, data, data, data,");
    assert.equal(calls.length, 2);
    const warnLog = globalThis.__dictionaryPromptRecoveryLogs.find(({ level }) => level === "warn");
    assert.ok(warnLog, "expected the swallowed retry failure to be logged");
    assert.equal(warnLog.data.message, "GPU inference failed");
  });

  await t.test(
    "a small-dictionary echo stays strict when the merged prompt dilutes it",
    async () => {
      // getWhisperPrompt may append a Chinese script bias; the strict check must
      // also consult the dictionary alone (see isDictionaryEcho's rationale).
      const fullTranscript = "This is what I actually said.";
      const calls = queueTranscriptions(window, [
        { success: true, text: "OpenWhispr, Parakeet" },
        { success: true, text: fullTranscript },
      ]);
      const { manager, processedTexts } = createRecoveryManager();
      manager.getCustomDictionaryPrompt = () => "OpenWhispr, Parakeet";
      manager.getWhisperPrompt = () => "OpenWhispr, Parakeet, 简体中文";

      const result = await manager.processWithLocalWhisper(AUDIO_BLOB, "base");

      assert.equal(result.rawText, fullTranscript);
      assert.deepEqual(processedTexts, [fullTranscript]);
      assert.equal(calls.length, 2);
    }
  );

  await t.test("normal output with a dictionary uses one inference call", async () => {
    const transcript = "Please summarize the customer meeting.";
    const calls = queueTranscriptions(window, [{ success: true, text: transcript }]);
    const { manager, processedTexts } = createRecoveryManager();

    const result = await manager.processWithLocalWhisper(AUDIO_BLOB, "base");

    assert.equal(result.rawText, transcript);
    assert.deepEqual(processedTexts, [transcript]);
    assert.equal(calls.length, 1);
  });

  await t.test("output without a dictionary uses one inference call", async () => {
    const transcript = "testing,";
    const calls = queueTranscriptions(window, [{ success: true, text: transcript }]);
    const { manager, processedTexts } = createRecoveryManager(null);

    const result = await manager.processWithLocalWhisper(AUDIO_BLOB, "base");

    assert.equal(result.rawText, transcript);
    assert.deepEqual(processedTexts, [transcript]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.initialPrompt, undefined);
  });

  await t.test("an unrecovered strict echo is saved and settles as no audio", async () => {
    const calls = queueTranscriptions(window, [
      { success: true, text: DICTIONARY_PROMPT },
      { success: true, text: "" },
    ]);
    const { manager } = createRecoveryManager();
    const lifecycle = [];
    const saved = [];
    Object.assign(manager, {
      isProcessing: true,
      _localSpeechGateState: null,
      pendingAssistantConversation: null,
      pendingSelectionEdit: null,
      lastAudioBlob: AUDIO_BLOB,
      onStateChange: ({ isProcessing }) => lifecycle.push(isProcessing ? "processing" : "idle"),
      onNoAudio: () => lifecycle.push("no-audio"),
      onError: () => lifecycle.push("error"),
      saveFailedTranscription: (message, code) => saved.push({ message, code }),
    });

    await manager.processAudio(AUDIO_BLOB);

    assert.equal(calls.length, 2);
    assert.deepEqual(lifecycle, ["idle", "no-audio"]);
    assert.deepEqual(saved, [{ message: "No audio detected", code: "DICTIONARY_ECHO" }]);
  });

  await t.test("a strict retry exception reaches the configured cloud fallback", async (t) => {
    setSettings({ ...baseSettings, allowOpenAIFallback: true });
    t.after(() => setSettings(baseSettings));
    const calls = queueTranscriptions(window, [
      { success: true, text: DICTIONARY_PROMPT },
      new Error("IPC unavailable"),
    ]);
    const { manager } = createRecoveryManager();
    let fallbackCalls = 0;
    manager.processWithOpenAIAPI = async () => {
      fallbackCalls += 1;
      return {
        success: true,
        text: "Recovered by cloud fallback.",
        rawText: "Recovered by cloud fallback.",
        source: "openai",
        timings: {},
      };
    };

    const result = await manager.processWithLocalWhisper(AUDIO_BLOB, "base");

    assert.equal(result.text, "Recovered by cloud fallback.");
    assert.equal(result.source, "openai-fallback");
    assert.equal(fallbackCalls, 1);
    assert.equal(calls.length, 2);
  });
});
