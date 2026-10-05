const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

function loadMeetingDetectionEngine() {
  const originalLoad = Module._load;
  Module._load = function loadWithMeetingMocks(request, parent, isMain) {
    if (request === "electron") {
      return { shell: { openExternal: async () => {} } };
    }
    if (request === "./windowBroadcast") {
      return { broadcastToWindows() {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const modulePath = require.resolve("../../src/helpers/meetingDetectionEngine");
    delete require.cache[modulePath];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

const blockedMeetingPolicy = {
  version: 1,
  transcription: { allowedModes: [], allowedByokProviders: [] },
  llm: {
    allowedModes: ["openwhispr"],
    allowedByokProviders: [],
    allowedEnterpriseProviders: [],
  },
  features: { agentEnabled: false, webSearchEnabled: false },
  sharing: { externalLinkSharing: "disabled" },
  dataRetention: {
    audioRetentionMaxDays: null,
    localHistoryMode: "user_choice",
    cloudBackupAllowed: false,
  },
  minAppVersion: null,
};

test("a policy-rejected automatic meeting start restores manager mode before clearing", async (t) => {
  const MeetingDetectionEngine = loadMeetingDetectionEngine();
  const reminderScheduler = { getActiveMeetingState: () => ({}) };
  const processDetector = new EventEmitter();
  const audioDetector = Object.assign(new EventEmitter(), {
    resetPrompt() {},
    setUserRecording() {},
  });
  let navigationRequest = null;
  const windowManager = {
    notificationPrefs: {},
    queueMeetingNoteNavigation: async (request) => {
      navigationRequest = request;
    },
  };
  const databaseManager = {
    getActiveEvents: () => [],
    saveNote: () => ({ note: { id: 41, title: "New note" } }),
    getMeetingsFolder: () => ({ id: 7 }),
  };
  const engine = new MeetingDetectionEngine(
    reminderScheduler,
    processDetector,
    audioDetector,
    windowManager,
    databaseManager
  );

  await engine.startManualMeeting();
  assert.equal(engine._meetingModeActive, true);
  assert.deepEqual(
    { noteId: navigationRequest.noteId, folderId: navigationRequest.folderId },
    { noteId: 41, folderId: 7 }
  );

  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-policy-test-",
  });

  const { handleMeetingRecordingRequest } = await vite.ssrLoadModule(
    "/helpers/meetingRecordingRequest.ts"
  );
  const { startRecording, useMeetingRecordingStore } = await vite.ssrLoadModule(
    "/stores/meetingRecordingStore.ts"
  );
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({
    status: "managed",
    appVersion: "1.8.1",
    policy: blockedMeetingPolicy,
  });

  const lifecycle = [];
  await handleMeetingRecordingRequest({
    args: {
      noteId: navigationRequest.noteId,
      noteTitle: "New note",
      folderId: navigationRequest.folderId,
    },
    startRecording,
    restoreFromMeetingMode: async () => {
      lifecycle.push("restored");
      engine.setMeetingModeActive(false);
    },
    onHandled: () => lifecycle.push("handled"),
  });

  assert.equal(engine._meetingModeActive, false);
  assert.deepEqual(lifecycle, ["restored", "handled"]);
  assert.equal(
    useMeetingRecordingStore.getState().error,
    "policyRestricted",
    "the store must hold the sentinel key so the mount can localize it"
  );

  const rejectionLifecycle = [];
  await assert.rejects(
    handleMeetingRecordingRequest({
      args: { noteId: 42, noteTitle: "New note", folderId: null },
      startRecording: async () => {
        throw new Error("start failed");
      },
      restoreFromMeetingMode: () => rejectionLifecycle.push("restored"),
      onHandled: () => rejectionLifecycle.push("handled"),
    }),
    /start failed/,
    "a failed start must still propagate its error"
  );
  assert.deepEqual(
    rejectionLifecycle,
    ["handled"],
    "a failed start must still clear the pending request so it is not re-attempted"
  );
});

test("a repeated policy denial re-notifies the toast effect", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-denial-test-",
  });

  const { startRecording, useMeetingRecordingStore } = await vite.ssrLoadModule(
    "/stores/meetingRecordingStore.ts"
  );
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({
    status: "managed",
    appVersion: "1.8.1",
    policy: blockedMeetingPolicy,
  });

  assert.equal(await startRecording({ noteId: 1, noteTitle: "A", folderId: null }), false);
  const first = useMeetingRecordingStore.getState();
  assert.equal(first.error, "policyRestricted");

  assert.equal(await startRecording({ noteId: 1, noteTitle: "A", folderId: null }), false);
  assert.equal(
    useMeetingRecordingStore.getState().errorNonce,
    first.errorNonce + 1,
    "an identical repeated denial must still produce a distinct notification"
  );
});
