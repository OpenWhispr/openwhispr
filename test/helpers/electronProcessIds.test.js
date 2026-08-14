const test = require("node:test");
const assert = require("node:assert/strict");

const createElectronProcessIdProvider = require("../../src/helpers/electronProcessIds");
const { collectAudioCaptureHelperPids } = require("../../src/helpers/electronProcessIds");

test("returns the main PID plus the current Electron child PIDs on every call", () => {
  let metrics = [{ pid: 22 }, { pid: 33 }];
  const getProcessIds = createElectronProcessIdProvider(11, () => metrics);

  assert.deepEqual(getProcessIds(), [11, 22, 33]);

  metrics = [{ pid: 44 }];
  assert.deepEqual(getProcessIds(), [11, 44]);
});

test("appends live audio capture helper PIDs so own capture never reads as external", () => {
  let helperPids = [55];
  const getProcessIds = createElectronProcessIdProvider(
    11,
    () => [{ pid: 22 }],
    () => helperPids
  );

  assert.deepEqual(getProcessIds(), [11, 22, 55]);

  helperPids = [];
  assert.deepEqual(getProcessIds(), [11, 22]);
});

test("collectAudioCaptureHelperPids reads only live helper processes", () => {
  const managers = [
    null,
    undefined,
    {},
    { process: null },
    { process: { pid: 77 } },
    { process: { pid: 0 } },
    { process: { pid: "88" } },
    { process: { pid: 99 } },
  ];

  assert.deepEqual(collectAudioCaptureHelperPids(managers), [77, 99]);
});
