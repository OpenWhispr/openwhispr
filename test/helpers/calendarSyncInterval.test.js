const test = require("node:test");
const assert = require("node:assert/strict");

const CalendarSyncInterval = require("../../src/helpers/calendarSyncInterval.js");
const { FOCUS_SYNC_THROTTLE_MS } = CalendarSyncInterval;

function createRunner(syncFn, overrides = {}) {
  return new CalendarSyncInterval(syncFn, {
    intervalMs: 1000,
    maxIntervalMs: 4000,
    logScope: "test",
    ...overrides,
  });
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("backoff doubles the interval per consecutive failure up to the cap", () => {
  const runner = createRunner(() => Promise.resolve());

  assert.equal(runner._getInterval(), 1000);
  runner._consecutiveFailures = 1;
  assert.equal(runner._getInterval(), 2000);
  runner._consecutiveFailures = 2;
  assert.equal(runner._getInterval(), 4000);
  runner._consecutiveFailures = 5;
  assert.equal(runner._getInterval(), 4000);
});

test("notifySuccess resets the backoff to the base interval", () => {
  const runner = createRunner(() => Promise.resolve());

  runner._consecutiveFailures = 3;
  runner.notifySuccess();

  assert.equal(runner._getInterval(), 1000);
  runner.stop();
});

test("a failed sync reschedules the next run at the backed-off interval", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const runner = createRunner(() => {
    calls += 1;
    return Promise.reject(new Error("boom"));
  });

  runner.start();
  t.mock.timers.tick(1000);
  assert.equal(calls, 1);
  await flushPromises();

  // The 1000ms interval was replaced by a 2000ms one after the failure
  t.mock.timers.tick(1000);
  assert.equal(calls, 1);
  t.mock.timers.tick(1000);
  assert.equal(calls, 2);

  runner.stop();
});

test("focus syncs are throttled to one per window", async () => {
  let calls = 0;
  const runner = createRunner(() => {
    calls += 1;
    return Promise.resolve();
  });

  runner.syncOnFocus();
  runner.syncOnFocus();
  assert.equal(calls, 1);

  runner._lastFocusSync = Date.now() - FOCUS_SYNC_THROTTLE_MS - 1;
  runner.syncOnFocus();
  assert.equal(calls, 2);

  await flushPromises();
  runner.stop();
});
