const test = require("node:test");
const assert = require("node:assert/strict");

const createElectronProcessIdProvider = require("../../src/helpers/electronProcessIds");

test("returns the main PID plus the current Electron child PIDs on every call", () => {
  let metrics = [{ pid: 22 }, { pid: 33 }];
  const getProcessIds = createElectronProcessIdProvider(11, () => metrics);

  assert.deepEqual(getProcessIds(), [11, 22, 33]);

  metrics = [{ pid: 44 }];
  assert.deepEqual(getProcessIds(), [11, 44]);
});
