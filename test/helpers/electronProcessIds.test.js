const test = require("node:test");
const assert = require("node:assert/strict");

const {
  collectAudioCaptureHelperPids,
  createExcludedProcessIdProvider,
} = require("../../src/helpers/electronProcessIds");

test("combines the Electron process tree with live audio capture helper PIDs on every call", () => {
  let ownPids = new Set([11, 22]);
  let helperPids = [55];
  const getProcessIds = createExcludedProcessIdProvider(
    () => helperPids,
    () => ownPids
  );

  assert.deepEqual(getProcessIds(), [11, 22, 55]);

  ownPids = new Set([11, 33]);
  helperPids = [];
  assert.deepEqual(getProcessIds(), [11, 33]);
});

test("defaults to the shared own-process set so the main pid is always excluded", () => {
  const getProcessIds = createExcludedProcessIdProvider();

  assert.ok(getProcessIds().includes(process.pid));
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
