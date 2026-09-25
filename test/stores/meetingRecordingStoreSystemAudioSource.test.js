const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// #1546: a meeting start reads the Windows "System Audio Source" once and hands
// the same value to the access check (which decides whether this renderer opens
// Chromium loopback up front) and to main's start (which decides whether the
// native helper runs). If they disagreed, the renderer would open a capture
// main never uses, or wait on one main expected it to have opened already.

const START_ARGS = {
  noteId: null,
  noteTitle: null,
  folderId: null,
  autoEndEligible: false,
};

function installDisplayCaptureGlobals(t, { displayFails = false } = {}) {
  installMicCaptureGlobals(t);

  const calls = { getDisplayMedia: 0 };
  const makeTrack = (kind) => ({ kind, readyState: "live", stop() {}, getSettings: () => ({}) });
  navigator.mediaDevices.getDisplayMedia = async () => {
    calls.getDisplayMedia += 1;
    if (displayFails) throw new Error("Could not start audio source");
    const audio = makeTrack("audio");
    const video = makeTrack("video");
    return {
      getTracks: () => [audio, video],
      getAudioTracks: () => [audio],
      getVideoTracks: () => [video],
    };
  };
  return calls;
}

// Stands in for main: the opt-in means renderer loopback, anything else the helper.
const strategyFor = (source) => (source === "default-device" ? "loopback" : "wasapi-loopback");

function createElectronAPI({ onCheck } = {}) {
  const seen = { check: [], start: [], systemAudioAvailable: [] };
  const noopListener = () => () => {};
  const api = {
    checkSystemAudioAccess: async (options) => {
      seen.check.push(options);
      onCheck?.();
      return {
        granted: true,
        status: "granted",
        mode: "loopback",
        strategy: strategyFor(options?.systemAudioSource),
      };
    },
    meetingTranscriptionStart: async (options) => {
      seen.start.push(options);
      return {
        success: true,
        systemAudioMode: "loopback",
        systemAudioStrategy: strategyFor(options?.systemAudioSource),
      };
    },
    meetingTranscriptionSetSystemAudioAvailable: async (_sessionId, available) => {
      seen.systemAudioAvailable.push(available);
      return { success: true };
    },
    meetingTranscriptionStop: async () => ({ success: true }),
    meetingTranscriptionSend: () => {},
    onMeetingTranscriptionSegment: noopListener,
    onMeetingSpeakerIdentified: noopListener,
    onMeetingSpeakersMerged: noopListener,
    onMeetingSessionSpeakerConfigUpdated: noopListener,
    onMeetingTranscriptionError: noopListener,
    onMeetingTranscriptionFatalError: noopListener,
    onMeetingSystemAudioSilent: noopListener,
    onMeetingSystemAudioDegraded: noopListener,
  };
  return { api, seen };
}

async function startWith(t, storedSource, { displayFails = false, onCheck } = {}) {
  const calls = installDisplayCaptureGlobals(t, { displayFails });
  let settings;
  const { api, seen } = createElectronAPI({ onCheck: onCheck && (() => onCheck(settings)) });
  installBrowserGlobals(t, {
    initialStorage: storedSource === undefined ? {} : { systemAudioSource: storedSource },
    window: { electronAPI: api, setTimeout: (fn, ms) => setTimeout(fn, ms) },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-system-audio-source-start-test-",
  });
  const store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  ({ useSettingsStore: settings } = await vite.ssrLoadModule("/stores/settingsStore.ts"));

  assert.equal(await store.startRecording(START_ARGS), true);
  return { calls, seen, store };
}

async function recordOnce(t, storedSource) {
  const { calls, seen, store } = await startWith(t, storedSource);
  await store.stopRecording();
  return { calls, seen };
}

test("default playback device only reaches the check and the start", async (t) => {
  const { calls, seen } = await recordOnce(t, "default-device");

  assert.deepEqual(seen.check, [{ systemAudioSource: "default-device" }]);
  assert.equal(seen.start.length, 1);
  assert.equal(seen.start[0].systemAudioSource, "default-device");
  // The renderer owns capture on this path and opens Chromium loopback up front.
  assert.equal(calls.getDisplayMedia, 1);
});

test("a fresh profile sends all playback devices to both calls", async (t) => {
  const { calls, seen } = await recordOnce(t, undefined);

  assert.deepEqual(seen.check, [{ systemAudioSource: "all-devices" }]);
  assert.equal(seen.start[0].systemAudioSource, "all-devices");
  // Main owns the helper, so the renderer opens no capture of its own.
  assert.equal(calls.getDisplayMedia, 0);
});

test("an unknown stored value is sent as all playback devices", async (t) => {
  const { seen } = await recordOnce(t, "virtual-cable");

  assert.deepEqual(seen.check, [{ systemAudioSource: "all-devices" }]);
  assert.equal(seen.start[0].systemAudioSource, "all-devices");
});

test("a failed Chromium capture leaves an opted-in user on the microphone", async (t) => {
  const { calls, seen, store } = await startWith(t, "default-device", { displayFails: true });

  // Honest mic-only fallback: the user hears why, auto-end knows there is no
  // system channel, and main is never asked for the helper they opted out of.
  assert.equal(
    store.useMeetingRecordingStore.getState().error,
    "System audio capture failed. Continuing with microphone only."
  );
  assert.deepEqual(seen.systemAudioAvailable, [false]);
  assert.equal(calls.getDisplayMedia, 1);
  assert.equal(seen.start.length, 1);
  assert.equal(seen.start[0].systemAudioSource, "default-device");

  await store.stopRecording();
});

test("a change during a start waits for the next recording", async (t) => {
  // Flipped while the access check is in flight: a start that read the setting
  // again for main would send it a different choice than the check was given.
  const { calls, seen, store } = await startWith(t, "default-device", {
    onCheck: (settings) => settings.getState().setSystemAudioSource("all-devices"),
  });

  assert.deepEqual(seen.check, [{ systemAudioSource: "default-device" }]);
  assert.equal(seen.start.length, 1);
  assert.equal(seen.start[0].systemAudioSource, "default-device");
  assert.equal(calls.getDisplayMedia, 1);
  await store.stopRecording();

  // The next recording reads the new choice and sends it to both calls, so
  // main's helper captures and the renderer opens nothing of its own.
  assert.equal(await store.startRecording(START_ARGS), true);
  assert.deepEqual(seen.check[1], { systemAudioSource: "all-devices" });
  assert.equal(seen.start[1].systemAudioSource, "all-devices");
  assert.equal(calls.getDisplayMedia, 1);
  await store.stopRecording();
});
