const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Meeting keyterms come from the effective dictionary: personal words, then the
// active workspace's shared words. Hidden and paused words never reach
// sharedDictionaryHints (selectSharedHintWords), so they never reach a meeting.

const SPACE_A = "11111111-1111-4111-8111-111111111111";

function entry(cloudId, spaceId, word) {
  return {
    cloudId,
    spaceId,
    word,
    addedByUserId: null,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
  };
}

// A synced snapshot: the member reads the workspace list and Space A.
function snapshot(entries, hiddenIds = []) {
  return {
    entries,
    hiddenIds,
    meta: {
      scopes: [
        { space_id: null, name: "Workspace", member_count: 3, word_count: 0 },
        { space_id: SPACE_A, name: "Space A", member_count: 2, word_count: 0 },
      ],
      contributors: [],
      paused: false,
      syncedAt: "2026-10-20T00:00:00.000Z",
    },
  };
}

// Runs the real path: snapshot → selectSharedHintWords → settings store →
// meeting transcription options. Corti BYOK is the route that carries keyterms.
async function prepareWithDictionary(t, { customDictionary, sharedSnapshot }) {
  const prepared = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        meetingTranscriptionPrepare: async (options) => {
          prepared.push(options);
          return { success: true };
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-keyterms-test-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { selectSharedHintWords } = await vite.ssrLoadModule("/utils/sharedDictionaryHints.ts");
  useSettingsStore.setState({
    meetingTranscriptionMode: "providers",
    meetingCloudTranscriptionProvider: "corti",
    customDictionary,
    sharedDictionaryHints: selectSharedHintWords(sharedSnapshot),
  });
  const store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  await store.prepareTranscription();
  assert.equal(prepared.length, 1, "prepare must reach main");
  return prepared[0];
}

test("meeting keyterms include shared words, exclude hidden", async (t) => {
  const options = await prepareWithDictionary(t, {
    customDictionary: ["Piha", "OpenWhispr"],
    sharedSnapshot: snapshot(
      [
        entry("s1", SPACE_A, "Openwhispr"),
        entry("s2", SPACE_A, "Qdrant"),
        entry("s3", SPACE_A, "Hidden"),
        entry("w1", null, "ARR"),
      ],
      ["s3"]
    ),
  });

  assert.deepEqual(options.keyterms, ["Piha", "OpenWhispr", "Qdrant", "ARR"]);
});

test("meeting keyterms keep every personal word and fill shared ones to 100 in all", async (t) => {
  const workspaceEntries = Array.from({ length: 500 }, (_, i) => entry(`w${i}`, null, `Team${i}`));
  const options = await prepareWithDictionary(t, {
    customDictionary: ["Piha"],
    sharedSnapshot: snapshot(workspaceEntries),
  });

  assert.equal(options.keyterms[0], "Piha");
  assert.equal(options.keyterms.length, 100);
});
