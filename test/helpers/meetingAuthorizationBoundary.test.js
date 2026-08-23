const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const blockedPolicy = {
  version: 1,
  transcription: { allowedModes: [], allowedByokProviders: [] },
  llm: { allowedModes: [], allowedByokProviders: [], allowedEnterpriseProviders: [] },
  features: { agentEnabled: false, webSearchEnabled: false },
  sharing: { externalLinkSharing: "disabled" },
  dataRetention: {
    audioRetentionMaxDays: null,
    localHistoryMode: "user_choice",
    cloudBackupAllowed: false,
  },
  minAppVersion: null,
};

const nativeSystemAudioAccess = {
  granted: true,
  status: "granted",
  mode: "native",
  strategy: "native",
  supportsNativeCapture: true,
};

function installUnavailableMicrophone(t) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        enumerateDevices: async () => [],
        getUserMedia: async () => {
          throw new Error("No microphone in renderer test");
        },
      },
    },
  });
  t.after(() => {
    if (originalDescriptor) Object.defineProperty(globalThis, "navigator", originalDescriptor);
    else delete globalThis.navigator;
  });
}

test("an authorization change aborts an in-flight prepare and prevents stale reuse", async (t) => {
  const preparation = createDeferred();
  const prepareCalls = [];
  const abortCalls = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        meetingTranscriptionPrepare: async (options) => {
          prepareCalls.push(options);
          if (prepareCalls.length === 1) return preparation.promise;
          return { success: true };
        },
        meetingTranscriptionAbort: async (sessionId) => {
          abortCalls.push(sessionId);
          return { success: true };
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-authorization-boundary-test-",
  });
  const meeting = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.8.4", policy: null });

  const firstPrepare = meeting.prepareTranscription();
  while (prepareCalls.length === 0) await Promise.resolve();
  usePolicyStore.setState({
    status: "managed",
    appVersion: "1.8.4",
    policy: blockedPolicy,
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(abortCalls, [undefined]);
  preparation.resolve({ success: true });
  await firstPrepare;

  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.8.4", policy: null });
  await Promise.resolve();
  abortCalls.length = 0;
  await meeting.prepareTranscription();
  assert.equal(prepareCalls.length, 2, "the stale prepared connection must not be reused");
});

for (const seedSegments of [
  [],
  [{ id: "segment-1", text: "stale segment", source: "system", timestamp: 1 }],
]) {
  test(`stop overtaken by authorization abort never persists ${
    seedSegments.length > 0 ? "captured segments" : "an empty-segment fallback"
  }`, async (t) => {
    const stopping = createDeferred();
    const stopCalls = [];
    const abortCalls = [];
    const commits = [];
    installUnavailableMicrophone(t);
    installBrowserGlobals(t, {
      window: {
        electronAPI: {
          checkSystemAudioAccess: async () => nativeSystemAudioAccess,
          meetingTranscriptionStart: async ({ sessionId }) => ({
            success: true,
            sessionId,
            commitToken: "meeting-commit-token",
            systemAudioMode: "native",
            systemAudioStrategy: "native",
          }),
          meetingTranscriptionStop: async (sessionId) => {
            stopCalls.push(sessionId);
            return stopping.promise;
          },
          meetingTranscriptionAbort: async (sessionId) => {
            abortCalls.push(sessionId);
            return { success: true };
          },
          commitMeetingTranscript: async (...args) => {
            commits.push(args);
            return { success: true };
          },
        },
      },
    });
    const vite = await createRendererServer(t, {
      cachePrefix: "openwhispr-meeting-stop-authorization-boundary-test-",
    });
    const meeting = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
    const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
    usePolicyStore.setState({ status: "unmanaged", appVersion: "1.8.4", policy: null });

    assert.equal(
      await meeting.startRecording({
        noteId: 41,
        noteTitle: "Boundary meeting",
        folderId: null,
        seedSegments,
        autoEndEligible: false,
      }),
      true
    );
    if (seedSegments.length === 0) {
      meeting.useMeetingRecordingStore.setState({ transcript: "stale fallback" });
    }

    const stopPromise = meeting.stopRecording();
    while (stopCalls.length === 0) await Promise.resolve();
    assert.deepEqual(commits, [], "renderer persistence must wait for main stop");

    usePolicyStore.setState({
      status: "managed",
      appVersion: "1.8.4",
      policy: blockedPolicy,
    });
    while (abortCalls.length === 0) await Promise.resolve();
    stopping.resolve({
      success: false,
      reason: "authorization-changed",
      code: "AUTHORIZATION_BOUNDARY_CHANGED",
    });

    assert.deepEqual(await stopPromise, { diarizationSessionId: null });
    assert.deepEqual(commits, []);
  });
}

test("delayed diarization keeps one authorization lease across note read and commit", async (t) => {
  const noteRead = createDeferred();
  const noteReadStarted = createDeferred();
  const commits = [];
  let onDiarizationComplete;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        onMeetingDiarizationComplete: (callback) => {
          onDiarizationComplete = callback;
          return () => {};
        },
        getNote: async () => {
          noteReadStarted.resolve();
          return noteRead.promise;
        },
        commitMeetingTranscript: async (...args) => {
          commits.push(args);
          return { success: true };
        },
        meetingTranscriptionAbort: async () => ({ success: true }),
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-diarization-authorization-boundary-test-",
  });
  await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.8.4", policy: null });

  assert.equal(typeof onDiarizationComplete, "function");
  onDiarizationComplete({
    noteId: 41,
    sessionId: "diarization-session",
    commitToken: "meeting-commit-token",
    segments: [{ id: "segment-1", text: "speaker text", source: "mic", timestamp: 1 }],
  });
  await noteReadStarted.promise;

  usePolicyStore.setState({
    status: "managed",
    appVersion: "1.8.4",
    policy: blockedPolicy,
  });
  noteRead.resolve({ id: 41, transcript: "[]", deleted_at: null });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(commits, []);
});
