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
            return "# Notes\\n- decided things";
          },
        };
      `,
      "/utils/generateTitle": `export const generateNoteTitle = async () => undefined;`,
    },
  });
  globalThis.__processTextCalls = calls;
  t.after(() => {
    delete globalThis.__processTextCalls;
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
