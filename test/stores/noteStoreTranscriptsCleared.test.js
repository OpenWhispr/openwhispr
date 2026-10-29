const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const TRANSCRIPT = '[{"id":"segment-0","text":"Welcome, everyone","speaker":"SPEAKER_00"}]';

const note = (id, title) => ({
  id,
  title,
  content: "My own notes",
  transcript: TRANSCRIPT,
  folder_id: 1,
  space_id: 1,
  updated_at: "2026-10-01 09:00:00",
});

// A retention clean-up clears transcripts of old notes in place. A window must update
// the ones it shows, and must not pull the others into its lists.
async function loadStore(t) {
  const listeners = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: new Proxy(
        {
          getNotes: async () => [note(2, "Standup"), note(3, "Planning")],
          onNoteTranscriptsCleared: (callback) => {
            listeners.push(callback);
            return () => {};
          },
        },
        {
          get: (target, name) =>
            name in target
              ? target[name]
              : String(name).startsWith("on")
                ? () => () => {}
                : async () => undefined,
        }
      ),
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-note-store-transcripts-cleared-test-",
  });
  const store = await vite.ssrLoadModule("/stores/noteStore.ts");
  await store.initializeNotes();
  return {
    transcriptOf: (id) => store.getNoteFromStore(id)?.transcript,
    held: (id) => store.getNoteFromStore(id) !== null,
    clear: (ids) => listeners.forEach((listener) => listener({ ids })),
  };
}

test("a cleared transcript disappears from a note the window shows", async (t) => {
  const store = await loadStore(t);

  store.clear([3]);

  assert.equal(store.transcriptOf(3), null);
  assert.equal(store.transcriptOf(2), TRANSCRIPT);
});

test("a note the window has not loaded stays out of its lists", async (t) => {
  const store = await loadStore(t);

  store.clear([40]);

  assert.equal(store.held(40), false);
  assert.equal(store.transcriptOf(2), TRANSCRIPT);
  assert.equal(store.transcriptOf(3), TRANSCRIPT);
});
