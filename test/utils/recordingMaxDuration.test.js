const test = require("node:test");
const assert = require("node:assert/strict");

const { armMaxRecordingDurationTimer } = require("../../src/utils/recordingMaxDuration.ts");

test("fires onLimit exactly once when the limit elapses", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const disarm = armMaxRecordingDurationTimer(5, () => {
    calls += 1;
  });
  assert.notEqual(disarm, null);
  t.mock.timers.tick(4999);
  assert.equal(calls, 0);
  t.mock.timers.tick(1);
  assert.equal(calls, 1);
  t.mock.timers.tick(60000);
  assert.equal(calls, 1);
});

test("disarming before the limit prevents onLimit", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const disarm = armMaxRecordingDurationTimer(5, () => {
    calls += 1;
  });
  disarm();
  t.mock.timers.tick(10000);
  assert.equal(calls, 0);
});

test("invalid durations return null and never schedule anything", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  for (const value of [0, -5, NaN, undefined, Infinity]) {
    assert.equal(
      armMaxRecordingDurationTimer(value, () => {
        calls += 1;
      }),
      null,
      `expected null for ${value}`
    );
  }
  t.mock.timers.tick(1e9);
  assert.equal(calls, 0);
});

test("durations past the setTimeout cap return null instead of firing immediately", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  assert.equal(
    armMaxRecordingDurationTimer(2147484, () => {
      calls += 1;
    }),
    null
  );
  t.mock.timers.tick(1e10);
  assert.equal(calls, 0);
});
