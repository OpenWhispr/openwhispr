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

test("a pending failure cannot restart a stopped runner", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const pending = Promise.withResolvers();
  let calls = 0;
  const runner = createRunner(() => {
    calls += 1;
    return pending.promise;
  });
  t.after(() => runner.stop());

  runner.start();
  t.mock.timers.tick(1000);
  assert.equal(calls, 1);
  runner.stop();
  pending.reject(new Error("database connection is not open"));
  await flushPromises();

  t.mock.timers.tick(10000);
  await flushPromises();
  assert.equal(calls, 1, "the stopped runner must not sync again");
});

for (const [source, outcome, restartWithoutStop] of [
  ["interval", "failure", false],
  ["interval", "success", false],
  ["focus", "success", false],
  ["interval", "failure", true],
]) {
  const restart = restartWithoutStop ? "started again" : "restarted";
  test(`an old ${source} ${outcome} cannot change backoff after the runner is ${restart}`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const pending = Promise.withResolvers();
    let calls = 0;
    const runner = createRunner(() => {
      calls += 1;
      if (calls === 1) return pending.promise;
      if (calls === 2) return Promise.reject(new Error("current run failed"));
      return Promise.resolve();
    });
    t.after(() => runner.stop());

    runner.start();
    if (source === "focus") runner.syncOnFocus();
    else t.mock.timers.tick(1000);
    assert.equal(calls, 1);
    if (!restartWithoutStop) runner.stop();
    runner.start();
    t.mock.timers.tick(1000);
    await flushPromises();
    assert.equal(calls, 2);

    if (outcome === "failure") pending.reject(new Error("old run failed"));
    else pending.resolve();
    await flushPromises();

    t.mock.timers.tick(1000);
    await flushPromises();
    assert.equal(calls, 2, "the current run must retain its 2000ms backoff");
    t.mock.timers.tick(1000);
    await flushPromises();
    assert.equal(calls, 3, "the old run must not extend the current backoff");
  });
}

test("an out-of-band success does not start a stopped runner", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const runner = createRunner(() => {
    calls += 1;
    return Promise.reject(new Error("boom"));
  });
  t.after(() => runner.stop());

  runner.start();
  t.mock.timers.tick(1000);
  await flushPromises();
  runner.stop();
  runner.notifySuccess();

  t.mock.timers.tick(10000);
  await flushPromises();
  assert.equal(calls, 1);
});

for (const source of ["interval", "focus"]) {
  test(`a current ${source} success restores the base interval after a failure`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    let calls = 0;
    const runner = createRunner(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve();
    });
    t.after(() => runner.stop());

    runner.start();
    t.mock.timers.tick(1000);
    await flushPromises();
    if (source === "focus") runner.syncOnFocus();
    else t.mock.timers.tick(2000);
    await flushPromises();
    assert.equal(calls, 2);

    t.mock.timers.tick(1000);
    await flushPromises();
    assert.equal(calls, 3, "a current success must restore the base 1000ms interval");
  });
}
