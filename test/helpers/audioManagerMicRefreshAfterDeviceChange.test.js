const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// Records the options each resolution is called with, so a test can assert
// whether the expensive system-default lookup was asked to bypass its cache.
// `setCacheable(false)` keeps the resolution unpinnable, which is how a test
// gets two consecutive resolutions instead of one plus a cache hit.
const MICROPHONE_SELECTION_MOCK = `
export const resolveCalls = [];
let cacheable = true;
export function setCacheable(next) {
  cacheable = next;
}
export function resolvePreferredMicrophone(options) {
  resolveCalls.push(options);
  return Promise.resolve({
    mode: "system",
    status: "native-exact",
    device: { deviceId: "mic-1", label: "Desk Microphone" },
  });
}
export function isCacheableMicrophoneResolution(resolution) {
  return cacheable && Boolean(resolution?.device?.deviceId);
}
`;

async function setupManager(t) {
  const loaded = await loadAudioManager(t, {
    cachePrefix: "openwhispr-audio-manager-mic-refresh-",
    settingsKey: "__micRefreshAfterDeviceChangeSettings",
    settings: {},
    mockModules: { "/microphoneSelection": MICROPHONE_SELECTION_MOCK },
  });
  const selection = await loaded.vite.ssrLoadModule("/helpers/microphoneSelection");
  const manager = loaded.createManager({
    cachedMicDeviceId: null,
    rejectedMicDeviceId: null,
    micStreamHold: { drop() {} },
    preparedMicCapture: { cancel() {} },
  });
  return { manager, selection };
}

const refreshFlags = (selection) => selection.resolveCalls.map((call) => call.refreshSystemDefault);

test("a device change makes the next microphone resolution bypass the system-default cache", async (t) => {
  const { manager, selection } = await setupManager(t);

  manager._handleDeviceChange();
  await manager.getAudioConstraints();

  assert.deepEqual(refreshFlags(selection), [true]);
});

test("a resolution with no device change reuses the system-default cache", async (t) => {
  const { manager, selection } = await setupManager(t);

  await manager.getAudioConstraints();

  assert.deepEqual(refreshFlags(selection), [false]);
});

test("only the first resolution after a device change bypasses the cache", async (t) => {
  const { manager, selection } = await setupManager(t);
  selection.setCacheable(false);

  manager._handleDeviceChange();
  await manager.getAudioConstraints();
  await manager.getAudioConstraints();

  assert.deepEqual(refreshFlags(selection), [true, false]);
});
