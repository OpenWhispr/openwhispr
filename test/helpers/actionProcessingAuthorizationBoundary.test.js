const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for background action");
};

const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

async function loadActionStore(t, processText, onTagOwners) {
  const { window } = installBrowserGlobals(t);
  window.electronAPI.beginActionNoteCommit = async () => ({
    success: true,
    commitToken: "action-token",
  });
  window.electronAPI.commitActionNote = async (payload) =>
    window.electronAPI.updateNote(payload.noteId, payload.updates);
  globalThis.__actionProcessText = processText;
  globalThis.__actionAuthorizationCallbacks = new Set();
  globalThis.__actionTagOwners = onTagOwners;
  t.after(() => {
    delete globalThis.__actionProcessText;
    delete globalThis.__actionAuthorizationCallbacks;
    delete globalThis.__actionTagOwners;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-action-authorization-test-",
    mockModules: {
      "/services/ReasoningService": `
        export default { processText: (...args) => globalThis.__actionProcessText(...args) };
      `,
      "/stores/settingsStore": `
        export const getSettings = () => ({
          uiLanguage: 'en', customDictionary: '', noteFormattingDisableThinking: false,
          autoGenerateNoteTitle: true,
        });
        export const selectResolvedNoteFormatting = () => ({ mode: 'providers' });
      `,
      "/config/prompts": "export const appendDictionarySuffix = (prompt) => prompt;",
      "/helpers/noteFormattingOverrides": "export const buildNoteFormattingOverrides = () => ({});",
      "/utils/mentionMarkdown": `
        export const tagActionItemOwners = (content) => {
          globalThis.__actionTagOwners?.();
          return content;
        };
      `,
      runtimeAuthorizationBoundary: `
        export const captureReasoningRuntimeAuthorizationContext = () => ({
          accountId: 'account-a', workspaceId: 'workspace-a', authGeneration: 7,
          configGeneration: 11, policyRevision: 5, signature: 'reasoning-signature-a',
        });
        export const captureRuntimeAuthorizationLease = (_domain, onChanged) => {
          let current = true;
          const callback = () => {
            if (!current) return;
            current = false;
            onChanged();
          };
          globalThis.__actionAuthorizationCallbacks.add(callback);
          return {
            isCurrent: () => current,
            assertCurrent() {
              if (!current) throw Object.assign(new Error('Authorization changed'), {
                name: 'AbortError', code: 'AUTHORIZATION_BOUNDARY_CHANGED',
              });
            },
            dispose() { globalThis.__actionAuthorizationCallbacks.delete(callback); },
          };
        };
      `,
    },
  });
  return vite.ssrLoadModule("/stores/actionProcessingStore.ts");
}

test("reasoning waits for main-owned action-note admission", async (t) => {
  const admission = {};
  admission.promise = new Promise((resolve) => {
    admission.resolve = resolve;
  });
  const calls = [];
  const genericUpdates = [];
  const authorizedCommits = [];
  const { runBackgroundAction } = await loadActionStore(t, async (...args) => {
    calls.push(args);
    return "enhanced note";
  });
  globalThis.window.electronAPI.beginActionNoteCommit = () => admission.promise;
  globalThis.window.electronAPI.commitActionNote = async (...args) => {
    authorizedCommits.push(args);
    return { success: true, note: { id: 1 } };
  };
  globalThis.window.electronAPI.updateNote = async (...args) => genericUpdates.push(args);

  runAction(runBackgroundAction, { allowTitleGeneration: false });
  await settle();
  assert.equal(calls.length, 0, "reasoning must not start before main admission");

  admission.resolve({ success: true, commitToken: "action-token" });
  await waitFor(() => authorizedCommits.length === 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(genericUpdates, []);
  assert.equal(authorizedCommits[0][0].commitToken, "action-token");
  assert.equal(authorizedCommits[0][0].reasoningSignature, "reasoning-signature-a");
});

function invalidateAuthorization() {
  for (const callback of [...globalThis.__actionAuthorizationCallbacks]) callback();
}

function runAction(runBackgroundAction, options = {}) {
  runBackgroundAction(
    1,
    "raw note",
    "note-hash",
    { name: "Enhance", prompt: "Summarize this note" },
    { isCloudMode: true, modelId: "model", allowTitleGeneration: true, ...options },
    { noModel: "No model", noEndpoint: "No endpoint", actionFailed: "Action failed" }
  );
}

test("authorization changes between enhancement and title prevent a title request and note update", async (t) => {
  const calls = [];
  const updates = [];
  const { runBackgroundAction } = await loadActionStore(t, async (...args) => {
    calls.push(args);
    if (calls.length === 1) {
      invalidateAuthorization();
      return "enhanced note";
    }
    return "Generated title";
  });
  globalThis.window.electronAPI.updateNote = async (...args) => updates.push(args);

  runAction(runBackgroundAction);
  await waitFor(() => calls.length > 1 || globalThis.__actionAuthorizationCallbacks.size === 0);

  assert.equal(calls.length, 1);
  assert.deepEqual(updates, []);
  assert.equal(globalThis.__actionAuthorizationCallbacks.size, 0);
});

test("authorization changes during title generation prevent note persistence", async (t) => {
  const calls = [];
  const updates = [];
  let resolveTitle;
  const { runBackgroundAction } = await loadActionStore(t, (...args) => {
    calls.push(args);
    if (calls.length === 1) return Promise.resolve("enhanced note");
    return new Promise((resolve) => {
      resolveTitle = resolve;
    });
  });
  globalThis.window.electronAPI.updateNote = async (...args) => updates.push(args);

  runAction(runBackgroundAction);
  await waitFor(() => calls.length === 2);
  invalidateAuthorization();
  resolveTitle("Generated title");
  await settle();

  assert.equal(calls.length, 2);
  assert.deepEqual(updates, []);
  assert.equal(globalThis.__actionAuthorizationCallbacks.size, 0);
});

test("authorization changes immediately before updateNote prevent persistence", async (t) => {
  const calls = [];
  const updates = [];
  const { runBackgroundAction } = await loadActionStore(
    t,
    async (...args) => {
      calls.push(args);
      return calls.length === 1 ? "enhanced note" : "Generated title";
    },
    invalidateAuthorization
  );
  globalThis.window.electronAPI.updateNote = async (...args) => updates.push(args);

  runAction(runBackgroundAction, { knownPeople: [{ id: 1, name: "Ada" }] });
  await settle();

  assert.equal(calls.length, 2);
  assert.deepEqual(updates, []);
  assert.equal(globalThis.__actionAuthorizationCallbacks.size, 0);
});

test("an authorization error from title generation prevents note persistence", async (t) => {
  const calls = [];
  const updates = [];
  const { runBackgroundAction } = await loadActionStore(t, async (...args) => {
    calls.push(args);
    if (calls.length === 1) return "enhanced note";
    throw Object.assign(new Error("Authorization changed"), {
      name: "AbortError",
      code: "AUTHORIZATION_BOUNDARY_CHANGED",
    });
  });
  globalThis.window.electronAPI.updateNote = async (...args) => updates.push(args);

  runAction(runBackgroundAction);
  await settle();

  assert.equal(calls.length, 2);
  assert.deepEqual(updates, []);
});

test("an ordinary title failure preserves the enhanced note without a generated title", async (t) => {
  const calls = [];
  const updates = [];
  const { runBackgroundAction } = await loadActionStore(t, async (...args) => {
    calls.push(args);
    if (calls.length === 1) return "enhanced note";
    throw new Error("Title provider unavailable");
  });
  globalThis.window.electronAPI.updateNote = async (...args) => updates.push(args);

  runAction(runBackgroundAction);
  await waitFor(() => updates.length === 1);

  assert.equal(calls.length, 2);
  assert.deepEqual(updates, [
    [
      1,
      {
        enhanced_content: "enhanced note",
        enhancement_prompt: "Summarize this note",
        enhanced_at_content_hash: "note-hash",
      },
    ],
  ]);
});

test("a cancelled operation cannot clear or error a replacement operation for the same note", async (t) => {
  const calls = [];
  const updates = [];
  let resolveFirst;
  let resolveSecond;
  const { runBackgroundAction, selectNoteActionState, useActionProcessingStore } =
    await loadActionStore(t, () => {
      calls.push([]);
      return new Promise((resolve) => {
        if (calls.length === 1) resolveFirst = resolve;
        else resolveSecond = resolve;
      });
    });
  globalThis.window.electronAPI.updateNote = async (...args) => updates.push(args);

  runAction(runBackgroundAction, { allowTitleGeneration: false });
  await waitFor(() => calls.length === 1);
  invalidateAuthorization();

  runAction(runBackgroundAction, { allowTitleGeneration: false });
  await waitFor(() => calls.length === 2);
  resolveFirst("first enhancement");
  await settle();

  assert.deepEqual(
    selectNoteActionState(useActionProcessingStore.getState(), 1),
    { status: "processing", actionName: "Enhance" }
  );
  assert.deepEqual(useActionProcessingStore.getState().errorEvents, []);

  resolveSecond("second enhancement");
  await waitFor(() => updates.length === 1);

  assert.deepEqual(updates, [
    [
      1,
      {
        enhanced_content: "second enhancement",
        enhancement_prompt: "Summarize this note",
        enhanced_at_content_hash: "note-hash",
      },
    ],
  ]);
});
