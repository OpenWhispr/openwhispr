const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Note formatting had no explicit output budget, so it inherited the generic
// 2048-token default from calculateMaxTokens. Summaries of long meetings were
// cut off at that ceiling and saved anyway, with no error and nothing in the
// UI to say the notes were incomplete (#2142).

const ACTION = { id: 1, name: "Generate Notes", prompt: "Summarize the meeting." };
const LABELS = { noModel: "no model", noEndpoint: "no endpoint", actionFailed: "failed" };

async function loadStore(t) {
  const updates = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        updateNote: async (noteId, payload) => {
          updates.push({ noteId, payload });
          return { success: true };
        },
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
            if (globalThis.__processTextError) throw globalThis.__processTextError;
            return globalThis.__processTextResult ?? "# Notes\\n- decided things";
          },
        };
      `,
      "/utils/generateTitle": `export const generateNoteTitle = async () => undefined;`,
    },
  });
  globalThis.__processTextCalls = calls;
  t.after(() => {
    delete globalThis.__processTextCalls;
    delete globalThis.__processTextResult;
    delete globalThis.__processTextError;
  });

  const store = await vite.ssrLoadModule("/stores/actionProcessingStore.ts");
  return { store, calls, updates };
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

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
    },
    LABELS
  );

  await waitFor(() => updates.length > 0, "the note to be written");
  assert.equal(calls.length, 1);
  assert.match(calls[0].config.systemPrompt, /revise an existing AI summary[\s\S]*half as long/);
  assert.equal(calls[0].config.requireCompleteOutput, true);
  assert.equal(calls[0].config.refuseClippedByWindow, true);
  // The template and material hash stay those of the summary being edited.
  assert.deepEqual(Object.keys(updates[0].payload), ["enhanced_content"]);
});

test("a cut-off rewrite reports a notes error, not the dictation one providers attach", async (t) => {
  const { store, updates } = await loadStore(t);
  const { TRUNCATED_OUTPUT_MESSAGE_KEY } = await import("../../src/services/ai/chatRequestBody.ts");
  globalThis.__processTextError = Object.assign(new Error("Model output was truncated"), {
    messageKey: TRUNCATED_OUTPUT_MESSAGE_KEY,
  });

  store.runBackgroundAction(
    13,
    "## Current Summary\n- decided things",
    "hash-13",
    {
      id: 5,
      client_id: "shorten",
      kind: "action",
      output: "summary",
      name: "Shorten",
      prompt: "x",
    },
    { modelId: "gpt-4.1", isCloudMode: true, isMeetingNote: true },
    LABELS
  );

  let events = [];
  await waitFor(() => (events = store.consumeErrorEvents()).length > 0, "the error");
  assert.equal(events[0].messageKey, "notes.actions.errors.outputTruncated");
  assert.equal(updates.length, 0);
});
