const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Mirrors the real electronAPI surface consumed by runCliAudioImport: the
// composition itself is exercised through the REAL fileTranscription.ts and
// uploadNotes.ts modules (not mocked), so these tests prove the actual
// transcribeFileWithSpeakers -> saveUploadNote pipeline runs end to end —
// only its window.electronAPI boundary is faked, same as every other
// renderer-service test in this suite.
function makeElectronAPI(overrides = {}) {
  return {
    transcribeAudioFile: async () => ({ success: true, text: "hello world" }),
    saveNote: async (title, text, noteType) => ({
      success: true,
      note: { id: 42, title, content: text, note_type: noteType },
    }),
    updateNote: async () => ({ success: true }),
    getSpaces: async () => [{ id: 1, kind: "private", name: "Personal Notes" }],
    getFolders: async () => [
      { id: 7, name: "Personal", is_default: 1 },
      { id: 8, name: "Work", is_default: 0 },
    ],
    ...overrides,
  };
}

// A minimal managed OrgPolicy fixture that forces upload transcription
// mode to "local" (mirrors the "managed" policy shape used throughout
// test/helpers/policyRules.test.js), used to prove selectPolicyEffectiveSettings
// is applied identically to how UploadAudioView reads it.
const LOCAL_ONLY_UPLOAD_POLICY = {
  version: 1,
  transcription: {
    allowedModes: ["local"],
    allowedByokProviders: [],
  },
  llm: {
    allowedModes: ["openwhispr", "providers", "local", "self-hosted", "enterprise"],
    allowedByokProviders: [],
    allowedEnterpriseProviders: [],
  },
  features: { agentEnabled: true, webSearchEnabled: true },
  sharing: { externalLinkSharing: "allowed" },
  dataRetention: {
    audioRetentionMaxDays: null,
    localHistoryMode: "user_choice",
    cloudBackupAllowed: true,
  },
  minAppVersion: null,
};

test("rejects when configured upload transcription is not local", async (t) => {
  installBrowserGlobals(t, { window: { electronAPI: makeElectronAPI() } });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cli-audio-import-notlocal-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({ uploadUseLocalWhisper: false });
  const { runCliAudioImport } = await vite.ssrLoadModule("/services/cliAudioImport.ts");

  const outcome = await runCliAudioImport("/abs/path/audio.mp3", "req-1");
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.code, "NOT_LOCAL");
});

test("a managed policy forcing local upload transcription applies exactly like the normal UI, even when the raw preference is cloud", async (t) => {
  let sawFilePath;
  installBrowserGlobals(t, {
    window: {
      electronAPI: makeElectronAPI({
        transcribeAudioFile: async (filePath) => {
          sawFilePath = filePath;
          return { success: true, text: "the quick brown fox" };
        },
      }),
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cli-audio-import-policy-forced-local-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  // Raw preference is cloud/OpenWhispr-managed — selectResolvedUploadTranscription
  // on the raw settings alone would reject this as NOT_LOCAL. Only applying
  // selectPolicyEffectiveSettings first (as UploadAudioView does) forces it
  // to local, matching what the org policy actually mandates.
  useSettingsStore.setState({
    uploadUseLocalWhisper: false,
    uploadTranscriptionMode: "openwhispr",
    uploadCloudTranscriptionMode: "openwhispr",
  });
  usePolicyStore.setState({
    status: "managed",
    policy: LOCAL_ONLY_UPLOAD_POLICY,
    appVersion: "1.9.1",
  });
  const { runCliAudioImport } = await vite.ssrLoadModule("/services/cliAudioImport.ts");

  const outcome = await runCliAudioImport("/abs/path/audio.mp3", "req-policy-local");

  assert.equal(outcome.status, "completed");
  assert.equal(sawFilePath, "/abs/path/audio.mp3", "the real local transcription route ran");
});

test("local happy path creates a normal upload note via the real save pipeline", async (t) => {
  let sawFilePath;
  let sawOptions;
  let saveArgs;
  installBrowserGlobals(t, {
    window: {
      electronAPI: makeElectronAPI({
        transcribeAudioFile: async (filePath, options) => {
          sawFilePath = filePath;
          sawOptions = options;
          return { success: true, text: "the quick brown fox" };
        },
        saveNote: async (...args) => {
          saveArgs = args;
          return { success: true, note: { id: 99, title: args[0] } };
        },
      }),
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-cli-audio-import-happy-" });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({
    uploadUseLocalWhisper: true,
    uploadLocalTranscriptionProvider: "whisper",
    uploadWhisperModel: "base",
  });
  const { runCliAudioImport } = await vite.ssrLoadModule("/services/cliAudioImport.ts");

  const outcome = await runCliAudioImport("/abs/path/audio.mp3", "req-2");

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.noteId, 99);
  assert.equal(outcome.text, "the quick brown fox");
  assert.equal(sawFilePath, "/abs/path/audio.mp3");
  assert.equal(sawOptions.provider, "whisper");
  assert.equal(sawOptions.model, "base");
  assert.equal(saveArgs[2], "upload");
  assert.equal(saveArgs[3], "audio.mp3");
  assert.equal(saveArgs[5], 7, "resolves the default Personal folder");
});

test("maps an UPLOAD_CANCELLED transcription result to a cancelled outcome", async (t) => {
  installBrowserGlobals(t, {
    window: {
      electronAPI: makeElectronAPI({
        transcribeAudioFile: async () => ({
          success: false,
          error: "Cancelled",
          code: "UPLOAD_CANCELLED",
        }),
      }),
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-cli-audio-import-cancel-" });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({ uploadUseLocalWhisper: true });
  const { runCliAudioImport } = await vite.ssrLoadModule("/services/cliAudioImport.ts");

  const outcome = await runCliAudioImport("/abs/path/audio.mp3", "req-3");
  assert.equal(outcome.status, "cancelled");
});

test("a cancel latched after transcription succeeds is honored before saving a note", async (t) => {
  // Reproduces the race the bridge can't fully close on its own: the
  // underlying transcription resolves successfully (no UPLOAD_CANCELLED)
  // before the caller's cancel signal was ever observed. shouldAbort is
  // runCliAudioImport's last chance to make sure that still can't create a
  // note or report "completed".
  let saveNoteCalled = false;
  let getFoldersCalled = false;
  installBrowserGlobals(t, {
    window: {
      electronAPI: makeElectronAPI({
        transcribeAudioFile: async () => ({ success: true, text: "hello world" }),
        getFolders: async () => {
          getFoldersCalled = true;
          return [{ id: 7, name: "Personal", is_default: 1 }];
        },
        saveNote: async () => {
          saveNoteCalled = true;
          return { success: true, note: { id: 1 } };
        },
      }),
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cli-audio-import-latched-cancel-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({ uploadUseLocalWhisper: true });
  const { runCliAudioImport } = await vite.ssrLoadModule("/services/cliAudioImport.ts");

  const outcome = await runCliAudioImport("/abs/path/audio.mp3", "req-3b", () => true);

  assert.equal(outcome.status, "cancelled");
  assert.equal(getFoldersCalled, false, "must not even look up a folder for a cancelled job");
  assert.equal(saveNoteCalled, false, "a cancelled job must never create a note");
});

test("beginPersist resolving not-ok (cancel won the race) is honored before saving a note", async (t) => {
  // Reproduces the race the local shouldAbort() latch alone can't close:
  // the bridge (main process) may have already recorded a cancel before
  // this renderer's IPC notification even arrives. beginPersist is the
  // single, authoritative point that must be consulted immediately before
  // saveUploadNote — a not-ok result must block persistence outright, even
  // though getFolders (a read, not a persist) already ran.
  let saveNoteCalled = false;
  let getFoldersCalled = false;
  let beginPersistCalled = false;
  installBrowserGlobals(t, {
    window: {
      electronAPI: makeElectronAPI({
        transcribeAudioFile: async () => ({ success: true, text: "hello world" }),
        getFolders: async () => {
          getFoldersCalled = true;
          return [{ id: 7, name: "Personal", is_default: 1 }];
        },
        saveNote: async () => {
          saveNoteCalled = true;
          return { success: true, note: { id: 1 } };
        },
      }),
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cli-audio-import-beginpersist-cancel-wins-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({ uploadUseLocalWhisper: true });
  const { runCliAudioImport } = await vite.ssrLoadModule("/services/cliAudioImport.ts");

  const beginPersist = async () => {
    beginPersistCalled = true;
    return { ok: false, reason: "cancelling" };
  };

  const outcome = await runCliAudioImport("/abs/path/audio.mp3", "req-3c", () => false, beginPersist);

  assert.equal(beginPersistCalled, true, "the commit gate was consulted");
  assert.equal(getFoldersCalled, true, "the folder lookup (a read) is allowed before the gate");
  assert.equal(outcome.status, "cancelled");
  assert.equal(saveNoteCalled, false, "a cancelled job must never create a note");
});

test("beginPersist resolving ok (commit won the race) proceeds to save and complete normally", async (t) => {
  let saveNoteCalled = false;
  let beginPersistCalled = false;
  installBrowserGlobals(t, {
    window: {
      electronAPI: makeElectronAPI({
        transcribeAudioFile: async () => ({ success: true, text: "hello world" }),
        saveNote: async (...args) => {
          saveNoteCalled = true;
          return { success: true, note: { id: 55, title: args[0] } };
        },
      }),
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cli-audio-import-beginpersist-commit-wins-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({ uploadUseLocalWhisper: true });
  const { runCliAudioImport } = await vite.ssrLoadModule("/services/cliAudioImport.ts");

  const beginPersist = async () => {
    beginPersistCalled = true;
    return { ok: true };
  };

  const outcome = await runCliAudioImport("/abs/path/audio.mp3", "req-3d", () => false, beginPersist);

  assert.equal(beginPersistCalled, true);
  assert.equal(saveNoteCalled, true, "commit winning must still create the note");
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.noteId, 55);
});

test("a beginPersist call that throws fails closed: no note is saved, outcome is a distinct failure", async (t) => {
  let saveNoteCalled = false;
  installBrowserGlobals(t, {
    window: {
      electronAPI: makeElectronAPI({
        transcribeAudioFile: async () => ({ success: true, text: "hello world" }),
        saveNote: async () => {
          saveNoteCalled = true;
          return { success: true, note: { id: 1 } };
        },
      }),
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cli-audio-import-beginpersist-throws-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({ uploadUseLocalWhisper: true });
  const { runCliAudioImport } = await vite.ssrLoadModule("/services/cliAudioImport.ts");

  const beginPersist = async () => {
    throw new Error("IPC channel closed");
  };

  const outcome = await runCliAudioImport("/abs/path/audio.mp3", "req-3e", () => false, beginPersist);

  assert.equal(saveNoteCalled, false, "must not save a note when the commit gate itself errors");
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.code, "BEGIN_PERSIST_ERROR");
});

test("an absent commit gate (the exact reason useCliAudioImportHost reports when the IPC method is missing) fails closed: no note saved, reported as an explicit failure, never mislabeled cancelled", async (t) => {
  // Reproduces useCliAudioImportHost's own fallback for a partially rolled
  // out preload/main (updated renderer, stale preload): the gate method is
  // absent entirely, so the host reports {ok:false, reason:
  // "begin_persist_unavailable"} rather than tacitly permitting the save.
  // This is not a legitimate user cancel (only reason "cancelling" is), so
  // the outcome must be an explicit "failed", not "cancelled".
  let saveNoteCalled = false;
  installBrowserGlobals(t, {
    window: {
      electronAPI: makeElectronAPI({
        transcribeAudioFile: async () => ({ success: true, text: "hello world" }),
        saveNote: async () => {
          saveNoteCalled = true;
          return { success: true, note: { id: 1 } };
        },
      }),
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cli-audio-import-beginpersist-absent-gate-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({ uploadUseLocalWhisper: true });
  const { runCliAudioImport } = await vite.ssrLoadModule("/services/cliAudioImport.ts");

  const beginPersist = async () => ({ ok: false, reason: "begin_persist_unavailable" });

  const outcome = await runCliAudioImport("/abs/path/audio.mp3", "req-3f", () => false, beginPersist);

  assert.equal(saveNoteCalled, false, "an absent/unreachable gate must never permit a save");
  assert.equal(outcome.status, "failed", "must be an explicit failure, not mislabeled cancelled");
  assert.equal(outcome.code, "COMMIT_REJECTED");
  assert.match(outcome.error, /begin_persist_unavailable/);
});

test("surfaces a failed transcription without saving a note", async (t) => {
  let saveNoteCalled = false;
  installBrowserGlobals(t, {
    window: {
      electronAPI: makeElectronAPI({
        transcribeAudioFile: async () => ({ success: false, error: "boom", code: "ENGINE_ERROR" }),
        saveNote: async () => {
          saveNoteCalled = true;
          return { success: true, note: { id: 1 } };
        },
      }),
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-cli-audio-import-fail-" });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({ uploadUseLocalWhisper: true });
  const { runCliAudioImport } = await vite.ssrLoadModule("/services/cliAudioImport.ts");

  const outcome = await runCliAudioImport("/abs/path/audio.mp3", "req-4");
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.code, "ENGINE_ERROR");
  assert.equal(saveNoteCalled, false);
});

test("a failed note save is reported, not silently swallowed as success", async (t) => {
  installBrowserGlobals(t, {
    window: {
      electronAPI: makeElectronAPI({
        saveNote: async () => ({ success: false }),
      }),
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cli-audio-import-savefail-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({ uploadUseLocalWhisper: true });
  const { runCliAudioImport } = await vite.ssrLoadModule("/services/cliAudioImport.ts");

  const outcome = await runCliAudioImport("/abs/path/audio.mp3", "req-5");
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.code, "SAVE_NOTE_FAILED");
});

test("resolves folders scoped to the private space, ignoring a same-named team default folder", async (t) => {
  // A multi-space workspace: a team space happens to have its own
  // "Personal"/default folder (e.g. a team member replicated the personal
  // layout). Uploads must never resolve into it — only the user's own
  // private space is ever a valid destination for a CLI-submitted note.
  let getFoldersSawSpaceId;
  let saveArgs;
  installBrowserGlobals(t, {
    window: {
      electronAPI: makeElectronAPI({
        getSpaces: async () => [
          { id: 2, kind: "team", name: "Engineering" },
          { id: 1, kind: "private", name: "Personal Notes" },
        ],
        getFolders: async (spaceId) => {
          getFoldersSawSpaceId = spaceId;
          if (spaceId === 2) {
            // The trap: a team-space folder that would also satisfy
            // findDefaultFolder if folder lookup weren't space-scoped.
            return [{ id: 999, name: "Personal", is_default: 1 }];
          }
          return [{ id: 7, name: "Personal", is_default: 1 }];
        },
        saveNote: async (...args) => {
          saveArgs = args;
          return { success: true, note: { id: 100, title: args[0] } };
        },
      }),
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cli-audio-import-multispace-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({ uploadUseLocalWhisper: true });
  const { runCliAudioImport } = await vite.ssrLoadModule("/services/cliAudioImport.ts");

  const outcome = await runCliAudioImport("/abs/path/audio.mp3", "req-6");

  assert.equal(outcome.status, "completed");
  assert.equal(getFoldersSawSpaceId, 1, "folders must be looked up in the private space, id 1");
  assert.equal(saveArgs[5], 7, "the note is saved into the private space's own default folder");
});

test("fails clearly without saving when no private space can be resolved", async (t) => {
  let saveNoteCalled = false;
  installBrowserGlobals(t, {
    window: {
      electronAPI: makeElectronAPI({
        // Only a team space is visible/mirrored — no private space exists
        // to resolve, e.g. a still-syncing or misconfigured account.
        getSpaces: async () => [{ id: 2, kind: "team", name: "Engineering" }],
        saveNote: async () => {
          saveNoteCalled = true;
          return { success: true, note: { id: 1 } };
        },
      }),
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cli-audio-import-no-private-space-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({ uploadUseLocalWhisper: true });
  const { runCliAudioImport } = await vite.ssrLoadModule("/services/cliAudioImport.ts");

  const outcome = await runCliAudioImport("/abs/path/audio.mp3", "req-7");

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.code, "NO_PRIVATE_SPACE");
  assert.equal(saveNoteCalled, false, "must never save a note when no private space is resolved");
});

test("fails clearly without saving when the private space has no default folder", async (t) => {
  let saveNoteCalled = false;
  installBrowserGlobals(t, {
    window: {
      electronAPI: makeElectronAPI({
        getFolders: async () => [{ id: 3, name: "Random Folder", is_default: 0 }],
        saveNote: async () => {
          saveNoteCalled = true;
          return { success: true, note: { id: 1 } };
        },
      }),
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cli-audio-import-no-default-folder-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({ uploadUseLocalWhisper: true });
  const { runCliAudioImport } = await vite.ssrLoadModule("/services/cliAudioImport.ts");

  const outcome = await runCliAudioImport("/abs/path/audio.mp3", "req-8");

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.code, "NO_DEFAULT_FOLDER");
  assert.equal(saveNoteCalled, false, "must never save a note when no default folder is resolved");
});
