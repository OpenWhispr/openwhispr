const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Note formatting had no explicit output budget, so it inherited the generic
// 2048-token default from calculateMaxTokens. Summaries of long meetings were
// cut off at that ceiling and saved anyway, with no error and nothing in the
// UI to say the notes were incomplete (#2142).

const ACTION = { id: 1, name: "Generate Notes", prompt: "Summarize the meeting." };
const LABELS = { noModel: "no model", noEndpoint: "no endpoint", actionFailed: "failed" };
const STORED_NOTE = {
  title: "Untitled Note",
  enhanced_content: "- the summary before the run",
  enhancement_prompt: "the prompt before the run",
  enhancement_template_id: "the template before the run",
  enhanced_at_content_hash: "the hash before the run",
};

async function loadStore(t, storedNote = STORED_NOTE) {
  const updates = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        updateNote: async (noteId, payload) => {
          updates.push({ noteId, payload });
          return { success: !globalThis.__updateNoteFails };
        },
        // What the database holds now, so a snapshot read after the write would show it.
        getNote: async (noteId) =>
          Object.assign(
            { id: noteId, ...storedNote },
            ...updates.filter((u) => u.noteId === noteId).map((u) => u.payload)
          ),
      },
    },
  });

  const calls = [];
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-action-output-test-",
    mockModules: {
      "/services/ReasoningService": `
        export default {
          processText: async (text, model, agentName, config) => {
            globalThis.__processTextCalls.push({ text, model, config });
            const queued = globalThis.__processTextErrors?.shift();
            if (queued) throw queued;
            if (globalThis.__processTextError) throw globalThis.__processTextError;
            return globalThis.__processTextResult ?? "# Notes\\n- decided things";
          },
        };
      `,
      "/utils/generateTitle": `
        export const generateNoteTitle = async () => {
          globalThis.__titleRequests += 1;
          return globalThis.__generatedTitle;
        };
      `,
    },
  });
  globalThis.__processTextCalls = calls;
  globalThis.__titleRequests = 0;
  t.after(() => {
    delete globalThis.__processTextCalls;
    delete globalThis.__processTextResult;
    delete globalThis.__processTextError;
    delete globalThis.__processTextErrors;
    delete globalThis.__generatedTitle;
    delete globalThis.__titleRequests;
    delete globalThis.__updateNoteFails;
  });

  const store = await vite.ssrLoadModule("/stores/actionProcessingStore.ts");
  return { store, calls, updates, vite };
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("AI Summary generates from meeting or personal material with the detailed template and stable identity", async (t) => {
  const { BUILTIN_ACTIONS, GENERATE_NOTES_KEY, LEGACY_DETAILED_NOTES } =
    await import("../../src/helpers/builtinActions.js");
  const { compileTemplatePrompt } = await import("../../src/helpers/templatePrompts.js");
  const { store, calls, updates } = await loadStore(t);
  const builtin = BUILTIN_ACTIONS.find((action) => action.translationKey === GENERATE_NOTES_KEY);
  const action = {
    ...builtin,
    id: 1,
    translation_key: GENERATE_NOTES_KEY,
    client_id: GENERATE_NOTES_KEY,
  };
  for (const isMeetingNote of [true, false]) {
    const noteId = isMeetingNote ? 801 : 802;
    const input = isMeetingNote
      ? "## Meeting Transcript\nAlice: I will send the Acme proposal by Friday."
      : "Acme proposal: send by Friday. Budget $250,000.";
    store.runBackgroundAction(
      noteId,
      input,
      "material-hash",
      action,
      { modelId: "gpt-4.1", isCloudMode: true, isMeetingNote },
      LABELS
    );
    await waitFor(() => updates.some((update) => update.noteId === noteId), "summary save");
    assert.equal(calls.at(-1).text, input);
    assert.equal(
      calls.at(-1).config.systemPrompt,
      compileTemplatePrompt(
        { ...LEGACY_DETAILED_NOTES, translation_key: LEGACY_DETAILED_NOTES.translationKey },
        { isMeetingNote }
      )
    );
    assert.equal(updates.at(-1).payload.enhancement_template_id, GENERATE_NOTES_KEY);
  }
  globalThis.__processTextResult = "NOTHING_TO_SUMMARIZE";
  store.runBackgroundAction(
    803,
    "Hello. Testing.",
    "empty-hash",
    action,
    { modelId: "gpt-4.1", isCloudMode: true, isMeetingNote: true },
    LABELS
  );
  let notices = [];
  await waitFor(() => (notices = store.consumeErrorEvents()).length > 0, "empty material notice");
  assert.equal(notices[0].messageKey, "notes.actions.errors.nothingToSummarize");
  assert.equal(
    updates.some((update) => update.noteId === 803),
    false
  );
});

test("templates and summary actions carry source fidelity once, apart from the material and the saved summary", async (t) => {
  const { SOURCE_FIDELITY_RULE } = await import("../../src/helpers/sourceFidelity.js");
  const { BUILTIN_ACTIONS } = await import("../../src/helpers/builtinActions.js");
  const { store, calls, updates } = await loadStore(t);
  const material = "## Meeting Transcript\nAlice: Not approved; Bob will check this weekend.";
  const summary = "## Current Summary\n- Bob will check this weekend; not approved yet.";
  const reply = "- Not approved yet. Bob will check this weekend.";
  globalThis.__processTextResult = reply;

  for (const key of ["generateNotes", "shorten", "lengthen"]) {
    const builtin = BUILTIN_ACTIONS.find((action) => action.translationKey.endsWith(`.${key}`));
    for (const fromSummary of [false, true]) {
      const noteId = 100 + updates.length;
      const input = builtin.kind === "action" && fromSummary ? summary : material;
      store.runBackgroundAction(
        noteId,
        input,
        `hash-${noteId}`,
        { ...builtin, id: noteId, translation_key: builtin.translationKey },
        { modelId: "gpt-4.1", isCloudMode: true, isMeetingNote: true, fromSummary },
        LABELS
      );
      await waitFor(() => updates.some((update) => update.noteId === noteId), "the summary save");

      assert.equal(calls.at(-1).config.systemPrompt.split(SOURCE_FIDELITY_RULE).length - 1, 1);
      assert.equal(calls.at(-1).text, input, "the instructions stay separate from source material");
      assert.equal(updates.at(-1).payload.enhanced_content, reply, "only model output is saved");
      assert.equal(updates.at(-1).payload.content, undefined, "personal notes are unchanged");
    }
  }
});

test("note formatting asks for enough output tokens to hold a long meeting summary", async (t) => {
  const { store, calls, updates } = await loadStore(t);

  store.runBackgroundAction(
    7,
    "## Meeting Transcript\n" + "Alice: we agreed to ship on Friday.\n".repeat(500),
    "hash",
    ACTION,
    { modelId: "gpt-4.1", isCloudMode: true, isMeetingNote: true },
    LABELS
  );

  await waitFor(() => updates.length > 0, "the note to be written");

  assert.equal(calls.length, 1);
  // 2048 is roughly 1,500 words — short of a structured summary of a long
  // meeting, which is exactly the case this feature exists for.
  assert.ok(
    calls[0].config.maxTokens >= 4096,
    `expected a real output budget, got ${calls[0].config.maxTokens}`
  );
});

test("a truncated summary is still saved rather than discarded", async (t) => {
  // Deliberate: unlike a selection edit, where a partial replacement would
  // corrupt the user's own text, a clipped summary is still worth keeping.
  // So note formatting must NOT set requireCompleteOutput.
  const { store, calls, updates } = await loadStore(t);

  store.runBackgroundAction(
    8,
    "some notes",
    "hash",
    ACTION,
    { modelId: "gpt-4.1", isCloudMode: true, isMeetingNote: true },
    LABELS
  );

  await waitFor(() => updates.length > 0, "the note to be written");
  assert.notEqual(calls[0].config.requireCompleteOutput, true);
});

test("a blank result is reported as an error and never saved as the enhanced note", async (t) => {
  // IPC-bridged providers (local, enterprise, OpenWhispr Cloud) relay whatever
  // the model returned, including nothing at all.
  const { store, updates } = await loadStore(t);
  globalThis.__processTextResult = "   ";

  store.runBackgroundAction(
    9,
    "## Meeting Transcript\nYou: ship on Friday.",
    "hash",
    ACTION,
    { modelId: "gpt-4.1", isCloudMode: true, isMeetingNote: true },
    LABELS
  );

  await waitFor(() => store.consumeErrorEvents().length > 0 || updates.length > 0, "an outcome");
  assert.equal(updates.length, 0);
});

test("note formatting requests carry the noteFormatting scope, which is what buys them the long deadline", async (t) => {
  // The scope is the only thing that tells the providers this request may run
  // for minutes. If the overrides stop being spread into the config, the note
  // silently drops back to the 30-second dictation deadline (1.10.1).
  const { store, calls, updates } = await loadStore(t);

  store.runBackgroundAction(
    10,
    "## Meeting Transcript\nYou: ship on Friday.",
    "hash",
    ACTION,
    { modelId: "gpt-5.6-terra", isCloudMode: true, isMeetingNote: true },
    LABELS
  );

  await waitFor(() => updates.length > 0, "the note to be written");
  assert.equal(calls[0].config.inferenceScope, "noteFormatting");
});

test("a template writes the summary and records which template produced it", async (t) => {
  const { store, calls, updates } = await loadStore(t);
  const template = {
    id: 3,
    client_id: "c0ffee00-0000-4000-8000-000000000001",
    kind: "template",
    name: "Sales call",
    prompt: "",
    sections: [{ heading: "Objections", instruction: "Each objection and the answer." }],
  };

  store.runBackgroundAction(
    11,
    "## Meeting Transcript\nThem: the price is too high.",
    "hash-11",
    template,
    { modelId: "gpt-4.1", isCloudMode: true, isMeetingNote: true },
    LABELS
  );

  await waitFor(() => updates.length > 0, "the note to be written");
  assert.match(calls[0].config.systemPrompt, /\n## Objections\nEach objection and the answer\./);
  const { payload } = updates[0];
  assert.equal(payload.enhancement_template_id, template.client_id);
  assert.equal(payload.enhanced_at_content_hash, "hash-11");
  assert.match(payload.enhancement_prompt, /## Objections/);
});

test("a summary action rewrites only the summary and never saves a clipped rewrite", async (t) => {
  const { store, calls, updates } = await loadStore(t);
  const action = {
    id: 4,
    client_id: "c0ffee00-0000-4000-8000-000000000002",
    kind: "action",
    output: "summary",
    name: "Shorten",
    prompt: "Make it half as long.",
  };

  store.runBackgroundAction(
    12,
    "## Current Summary\n- decided things",
    "hash-12",
    action,
    {
      modelId: "gpt-4.1",
      isCloudMode: true,
      isMeetingNote: true,
      allowTitleGeneration: true,
      fromSummary: true,
    },
    LABELS
  );

  await waitFor(() => updates.length > 0, "the note to be written");
  assert.equal(calls.length, 1);
  assert.match(calls[0].config.systemPrompt, /revise an existing AI summary[\s\S]*half as long/);
  assert.equal(calls[0].config.requireCompleteOutput, true);
  assert.equal(
    calls[0].config.refuseClippedByWindow,
    true,
    "a local model shortens the reply to fit rather than refusing up front"
  );
  const { NOTE_OUTPUT_MAX_TOKENS } = await import("../../src/helpers/builtinActions.js");
  assert.equal(
    calls[0].config.maxTokens,
    2 * NOTE_OUTPUT_MAX_TOKENS,
    "a rewrite has room to repeat a summary written under the note cap"
  );
  // The template and material hash stay those of the summary being edited.
  assert.deepEqual(Object.keys(updates[0].payload), ["enhanced_content"]);
});

test("a cut-off or empty rewrite reports a notes error, not the dictation one providers attach", async (t) => {
  const { store, updates } = await loadStore(t);
  const { EMPTY_OUTPUT_MESSAGE_KEY, TRUNCATED_OUTPUT_MESSAGE_KEY } =
    await import("../../src/services/ai/chatRequestBody.ts");

  for (const [noteId, providerKey, noteKey] of [
    [13, TRUNCATED_OUTPUT_MESSAGE_KEY, "notes.actions.errors.outputTruncated"],
    [14, EMPTY_OUTPUT_MESSAGE_KEY, "notes.actions.emptyReply"],
  ]) {
    globalThis.__processTextError = Object.assign(new Error("Provider refused the reply"), {
      messageKey: providerKey,
    });

    store.runBackgroundAction(
      noteId,
      "## Current Summary\n- decided things",
      `hash-${noteId}`,
      {
        id: 5,
        client_id: "shorten",
        kind: "action",
        output: "summary",
        name: "Shorten",
        prompt: "x",
      },
      { modelId: "gpt-4.1", isCloudMode: true, isMeetingNote: true, fromSummary: true },
      LABELS
    );

    let events = [];
    await waitFor(() => (events = store.consumeErrorEvents()).length > 0, "the error");
    assert.equal(events[0].messageKey, noteKey);
  }
  assert.equal(updates.length, 0);
});

// A reasoning model at its default effort can spend the whole notes budget
// thinking before it writes a word: GLM-5.3 on Ollama Cloud returned no notes on
// every real meeting at 4096 tokens, and wrote them with a bigger cap (#2008).
const ranOutThinking = async () => {
  const { emptyResponseError } = await import("../../src/services/ai/chatRequestBody.ts");
  return emptyResponseError("OpenAI", { systemPrompt: "Summarize" }, true);
};

// The reporter's route: GLM-5.3 on Ollama Cloud through a Custom endpoint, where
// Settings shows "Disable thinking output".
const CUSTOM_ROUTE_RUN = { modelId: "glm-5.3", isCloudMode: false, isMeetingNote: true };
async function useNoteFormattingRoute(vite, provider = "custom", model = "glm-5.3") {
  const { setResolvedLLMConfig } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  setResolvedLLMConfig("noteFormatting", { mode: "providers", provider, model });
}

test("a notes reply cut off before any answer is retried once with room for reasoning", async (t) => {
  const { store, calls, updates } = await loadStore(t);
  const { REASONING_MODEL_MIN_OUTPUT_TOKENS } =
    await import("../../src/services/ai/chatRequestBody.ts");
  const transcript = "## Meeting Transcript\nAlice: we agreed to ship on Friday.";
  globalThis.__processTextErrors = [await ranOutThinking()];

  store.runBackgroundAction(
    21,
    transcript,
    "hash",
    ACTION,
    { modelId: "glm-5.3", isCloudMode: true, isMeetingNote: true },
    LABELS
  );
  await waitFor(() => updates.length > 0, "the notes from the retry");

  assert.equal(calls.length, 2);
  assert.equal(calls[0].config.maxTokens, 4096);
  assert.equal(calls[1].config.maxTokens, REASONING_MODEL_MIN_OUTPUT_TOKENS);
  assert.equal(calls[1].text, transcript);
  assert.equal(calls[1].config.systemPrompt, calls[0].config.systemPrompt);
  assert.equal(updates[0].payload.enhanced_content, "# Notes\n- decided things");
});

test("a retry that still thinks past its budget points at Disable thinking output, or at another model when it is on or not offered", async (t) => {
  const { store, calls, vite } = await loadStore(t);
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  globalThis.__processTextError = await ranOutThinking();

  for (const [noteId, provider, model, disableThinking, messageKey] of [
    [23, "custom", "glm-5.3", false, "notes.actions.errors.outputSpentThinking"],
    [24, "custom", "glm-5.3", true, "notes.actions.errors.outputSpentThinkingDisabled"],
    // Settings hides the toggle for Corti S1, which thinks but can't be told not
    // to, so the toast must not name it whatever the shared setting says.
    [32, "corti", "corti-s1", false, "notes.actions.errors.outputSpentThinkingOtherModel"],
    [33, "corti", "corti-s1", true, "notes.actions.errors.outputSpentThinkingOtherModel"],
  ]) {
    await useNoteFormattingRoute(vite, provider, model);
    useSettingsStore.getState().setNoteFormattingDisableThinking(disableThinking);
    const before = calls.length;
    store.runBackgroundAction(
      noteId,
      "## Meeting Transcript\nAlice: we agreed to ship on Friday.",
      "hash",
      ACTION,
      { ...CUSTOM_ROUTE_RUN, modelId: model },
      LABELS
    );

    let events = [];
    await waitFor(() => (events = store.consumeErrorEvents()).length > 0, "the error");
    assert.equal(calls.length - before, 2, "one retry, never a loop");
    assert.equal(calls.at(-2).config.disableThinking, disableThinking);
    assert.equal(events[0].messageKey, messageKey);
    // Open Settings lands on Language Models → Note Formatting, which the toast names.
    assert.equal(events[0].settingsTarget, "noteFormatting");
  }
});

test("a reply cut off when its request already had room for reasoning is not sent again, and shows the cut-off error", async (t) => {
  const { store, calls } = await loadStore(t);
  const { truncatedOutputError } = await import("../../src/services/ai/chatRequestBody.ts");
  // OpenAI's own reasoning models get that room on the first request, so their
  // cut-off carries no retry code.
  globalThis.__processTextError = truncatedOutputError(
    "Model ran out of output tokens before producing a response"
  );

  store.runBackgroundAction(
    29,
    "## Meeting Transcript\nAlice: we agreed to ship on Friday.",
    "hash",
    ACTION,
    { modelId: "gpt-5.6-terra", isCloudMode: true, isMeetingNote: true },
    LABELS
  );

  let events = [];
  await waitFor(() => (events = store.consumeErrorEvents()).length > 0, "the error");
  assert.equal(calls.length, 1, "no second request with the same cap");
  // Settings hides Disable thinking output for these models; their request never sends it.
  assert.equal(events[0].messageKey, "notes.actions.errors.outputTruncated");
  assert.equal(events[0].settingsTarget, undefined);
});

test("a retry the server refuses or that times out keeps the first failure's advice; any other retry failure shows as itself", async (t) => {
  const { store, calls, vite } = await loadStore(t);
  await useNoteFormattingRoute(vite);
  const { asProviderError, providerHttpError } =
    await import("../../src/helpers/providerHttpErrors.js");
  const { llmRequestTimeoutError } = await import("../../src/helpers/llmRequestTimeout.js");
  const context = { provider: "Ollama", model: "glm-5.3", surface: "llm" };
  const refusal = (status, body) => providerHttpError({ ...context, status, body });

  for (const [noteId, retryError, messageKey] of [
    // Say a self-hosted server with a 32k window: the bigger cap no longer fits.
    [
      25,
      refusal(400, "max_tokens exceeds the maximum context length"),
      "notes.actions.errors.outputSpentThinkingDisabled",
    ],
    // Groq counts the cap against a free tier's tokens per minute and answers 413.
    [
      30,
      refusal(413, "Request too large for model on tokens per minute (TPM)"),
      "notes.actions.errors.outputSpentThinkingDisabled",
    ],
    // Still thinking at the note deadline.
    [
      28,
      asProviderError(llmRequestTimeoutError(600), context),
      "notes.actions.errors.outputSpentThinkingDisabled",
    ],
    // Tinfoil rejects with the deadline error as it is, unclassified.
    [31, llmRequestTimeoutError(600), "notes.actions.errors.outputSpentThinkingDisabled"],
    // Out of credit between the two requests: that is what the user can fix.
    [27, refusal(402, "insufficient credits"), "providerErrors.quotaExhausted"],
  ]) {
    globalThis.__processTextErrors = [await ranOutThinking(), retryError];
    const before = calls.length;
    store.runBackgroundAction(
      noteId,
      "## Meeting Transcript\nAlice: we agreed to ship on Friday.",
      "hash",
      ACTION,
      CUSTOM_ROUTE_RUN,
      LABELS
    );

    let events = [];
    await waitFor(() => (events = store.consumeErrorEvents()).length > 0, "the error");
    assert.equal(calls.length - before, 2);
    assert.equal(events[0].messageKey, messageKey);
    // The refusal's own details stay copyable, e.g. the server's context limit.
    assert.deepEqual(events[0].technicalDetails, retryError.technicalDetails);
  }
});

test("a run cancelled during its retry aborts the retry's request", async (t) => {
  const { store, calls, updates, vite } = await loadStore(t);
  const { isRequestCancelled } = await vite.ssrLoadModule("/services/ai/requestCancellation.ts");
  let finishRetry;
  globalThis.__processTextErrors = [await ranOutThinking()];
  globalThis.__processTextResult = new Promise((resolve) => {
    finishRetry = resolve;
  });

  store.runBackgroundAction(
    34,
    "## Meeting Transcript\nAlice: we agreed to ship on Friday.",
    "hash",
    ACTION,
    CUSTOM_ROUTE_RUN,
    LABELS
  );
  await waitFor(() => calls.length === 2, "the retry");
  const { requestId } = calls[1].config;
  assert.equal(isRequestCancelled(requestId), false);

  store.cancelAction(34);
  // The provider aborts its 25k request on this signal rather than paying for it.
  assert.equal(isRequestCancelled(requestId), true);
  finishRetry("# Notes\n- too late");
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(updates, []);
  assert.deepEqual(store.consumeErrorEvents(), []);
});

test("a run cancelled while its first reply comes back is not retried", async (t) => {
  const { store, calls, updates } = await loadStore(t);
  let fail;
  globalThis.__processTextResult = new Promise((resolve, reject) => {
    fail = reject;
  });

  store.runBackgroundAction(
    26,
    "## Meeting Transcript\nAlice: we agreed to ship on Friday.",
    "hash",
    ACTION,
    { modelId: "glm-5.3", isCloudMode: true, isMeetingNote: true },
    LABELS
  );
  await waitFor(() => calls.length === 1, "provider start");
  store.cancelAction(26);
  fail(await ranOutThinking());
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(calls.length, 1, "no paid 25k request for a cancelled run");
  assert.deepEqual(updates, []);
  assert.deepEqual(store.consumeErrorEvents(), []);
});

test("a summary action on a note without a summary writes one from the transcript, and tracks it for staleness", async (t) => {
  const { store, calls, updates } = await loadStore(t);
  const action = {
    id: 6,
    client_id: "notes.actions.builtin.lengthen",
    kind: "action",
    output: "summary",
    name: "Make notes longer",
    prompt: "Add supported detail.",
  };

  store.runBackgroundAction(
    14,
    "## Meeting Transcript\nAlice: we ship Friday.",
    "hash-14",
    action,
    { modelId: "gpt-4.1", isCloudMode: true, isMeetingNote: true, fromSummary: false },
    LABELS
  );

  await waitFor(() => updates.length > 0, "the note to be written");
  assert.match(calls[0].config.systemPrompt, /no AI summary yet[\s\S]*Add supported detail\.$/);
  assert.equal(calls[0].text, "## Meeting Transcript\nAlice: we ship Friday.");
  assert.equal(calls[0].config.requireCompleteOutput, undefined, "nothing to lose yet");
  assert.deepEqual(Object.keys(updates[0].payload), [
    "enhanced_content",
    "enhanced_at_content_hash",
  ]);
  assert.equal(updates[0].payload.enhanced_at_content_hash, "hash-14");
});

test("a run hands Undo the summary fields it overwrote, and the title when it renamed the note", async (t) => {
  const { store, updates } = await loadStore(t);
  const summaryFields = {
    enhanced_content: STORED_NOTE.enhanced_content,
    enhancement_prompt: STORED_NOTE.enhancement_prompt,
    enhancement_template_id: STORED_NOTE.enhancement_template_id,
    enhanced_at_content_hash: STORED_NOTE.enhanced_at_content_hash,
  };
  const shorten = {
    id: 7,
    client_id: "shorten",
    kind: "action",
    output: "summary",
    name: "Shorten",
    prompt: "x",
  };
  const options = { modelId: "gpt-4.1", isCloudMode: true, isMeetingNote: true };

  store.runBackgroundAction(
    15,
    "## Current Summary\n- a",
    "hash-15",
    shorten,
    { ...options, fromSummary: true },
    LABELS
  );
  await waitFor(() => updates.length === 1, "the rewrite to be written");
  // A summary to put back is a plain set, never a clear.
  assert.deepEqual(store.consumeAppliedEvents(), [
    { noteId: 15, action: shorten, previous: summaryFields },
  ]);

  globalThis.__generatedTitle = "Q3 launch sync";
  store.runBackgroundAction(
    16,
    "notes",
    "hash-16",
    ACTION,
    { ...options, allowTitleGeneration: true },
    LABELS
  );
  await waitFor(() => updates.length === 2, "the template run to be written");
  assert.equal(updates[1].payload.title, "Q3 launch sync");
  const [{ previous }] = store.consumeAppliedEvents();
  assert.deepEqual(previous, { ...summaryFields, title: STORED_NOTE.title });
});

test("Undo of a first summary is an explicit clear, which syncs to every device", async (t) => {
  // A blank without clear_fields stays local, so the undone summary would come
  // back on the next pull and stay on teammates' devices.
  const { store, updates } = await loadStore(t, {
    title: "Untitled Note",
    enhanced_content: null,
    enhancement_prompt: null,
    enhancement_template_id: null,
    enhanced_at_content_hash: null,
  });
  store.runBackgroundAction(
    31,
    "notes",
    "hash-31",
    ACTION,
    { modelId: "gpt-4.1", isCloudMode: true, isMeetingNote: false },
    LABELS
  );
  await waitFor(() => updates.length === 1, "the first summary to be written");
  const [{ previous }] = store.consumeAppliedEvents();
  assert.equal(previous.enhanced_content, null);
  assert.deepEqual(previous.clear_fields, ["enhanced_content"]);
});

test("a write the database refused offers no Undo and reports the failure", async (t) => {
  const { store } = await loadStore(t);
  globalThis.__updateNoteFails = true;
  store.runBackgroundAction(
    17,
    "notes",
    "hash-17",
    ACTION,
    { modelId: "gpt-4.1", isCloudMode: true, isMeetingNote: false },
    LABELS
  );
  let errors = [];
  await waitFor(() => (errors = store.consumeErrorEvents()).length > 0, "the error");
  assert.equal(errors[0].message, LABELS.actionFailed);
  assert.deepEqual(store.consumeAppliedEvents(), []);
});

test("material with nothing to summarize leaves the note as it was and says so", async (t) => {
  const { store, calls, updates } = await loadStore(t);
  globalThis.__generatedTitle = "Should not be asked for";

  const replies = [
    "NOTHING_TO_SUMMARIZE",
    "**NOTHING_TO_SUMMARIZE**",
    "```markdown\nNOTHING_TO_SUMMARIZE\n```",
    "Only greetings were exchanged.\n\nNOTHING_TO_SUMMARIZE",
    "<think>Just hellos.</think>\nNOTHING_TO_SUMMARIZE",
  ];
  for (const [index, reply] of replies.entries()) {
    const noteId = 18 + index;
    globalThis.__processTextResult = reply;
    store.runBackgroundAction(
      noteId,
      "## Meeting Transcript\nYou: Hi, can you hear me?",
      `hash-${noteId}`,
      ACTION,
      { modelId: "gpt-4.1", isCloudMode: true, isMeetingNote: true, allowTitleGeneration: true },
      LABELS
    );
    let errors = [];
    await waitFor(() => (errors = store.consumeErrorEvents()).length > 0, "the notice");
    assert.equal(errors[0].messageKey, "notes.actions.errors.nothingToSummarize", reply);
    assert.equal(errors[0].notice, true, "not a failure");
  }
  assert.equal(calls.length, replies.length, "one request per run");
  assert.equal(globalThis.__titleRequests, 0, "no title request");
  assert.deepEqual(updates, [], "nothing is written");
  assert.deepEqual(store.consumeAppliedEvents(), [], "nothing to undo");
});

test("the marker only in the model's thinking still saves the summary", async (t) => {
  const { store, updates } = await loadStore(t);
  globalThis.__processTextResult =
    "<think>NOTHING_TO_SUMMARIZE? No, they set a date.</think>\n# Notes\n- ship Friday";

  store.runBackgroundAction(
    30,
    "## Meeting Transcript\nYou: We ship Friday.",
    "hash-30",
    ACTION,
    { modelId: "gpt-4.1", isCloudMode: true, isMeetingNote: true },
    LABELS
  );
  await waitFor(() => updates.length > 0, "the summary write");
  assert.deepEqual(store.consumeErrorEvents(), []);
});

test("a summary that merely contains the marker is still saved", async (t) => {
  const { store, updates } = await loadStore(t);
  const summaries = [
    // A small model answering one empty section with the marker.
    "## Summary\n- We agreed to ship on Friday.\n\n## Decisions\nNOTHING_TO_SUMMARIZE",
    "- We agreed to ship on Friday.\n- NOTHING_TO_SUMMARIZE",
    "# Notes\n- The marker NOTHING_TO_SUMMARIZE confused the parser.\n- Ship Friday.",
  ];
  for (const [index, reply] of summaries.entries()) {
    const noteId = 40 + index;
    globalThis.__processTextResult = reply;
    store.runBackgroundAction(
      noteId,
      "## Meeting Transcript\nYou: We ship Friday.",
      `hash-${noteId}`,
      ACTION,
      { modelId: "gpt-4.1", isCloudMode: true, isMeetingNote: true },
      LABELS
    );
    await waitFor(() => updates.length === index + 1, "the summary write");
    assert.equal(updates[index].payload.enhanced_content, reply);
  }
  assert.deepEqual(store.consumeErrorEvents(), []);
});

test("cancelling a summary action before a provider returns keeps the saved summary and Undo queue unchanged", async (t) => {
  const { store, calls, updates } = await loadStore(t);
  let finish;
  globalThis.__processTextResult = new Promise((resolve) => {
    finish = resolve;
  });
  store.runBackgroundAction(
    120,
    "## Current Summary\nOriginal",
    "hash",
    { kind: "action", name: "Shorten", prompt: "Revise" },
    { isCloudMode: true, fromSummary: true },
    LABELS
  );
  await waitFor(() => calls.length === 1, "provider start");
  store.cancelAction(120);
  finish("A late reply");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(updates, []);
  assert.deepEqual(store.consumeAppliedEvents(), []);
});
