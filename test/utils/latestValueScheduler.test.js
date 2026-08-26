const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/latestValueScheduler.ts");

function createFakeClock() {
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map();

  const clock = {
    now: () => now,
    setTimer: (callback, delayMs) => {
      const id = nextTimerId++;
      timers.set(id, { callback, dueAt: now + delayMs });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  };

  const advance = (durationMs) => {
    const target = now + durationMs;
    while (true) {
      const dueTimers = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((a, b) => a[1].dueAt - b[1].dueAt);
      if (dueTimers.length === 0) break;

      const [id, timer] = dueTimers[0];
      timers.delete(id);
      now = timer.dueAt;
      timer.callback();
    }
    now = target;
  };

  return { clock, advance };
}

test("latest-value scheduler renders the first delta and coalesces a burst", async () => {
  const { createLatestValueScheduler } = await load();
  const { clock, advance } = createFakeClock();
  const commits = [];
  const scheduler = createLatestValueScheduler((value) => commits.push(value), 50, clock);

  scheduler.push("first");
  advance(10);
  scheduler.push("second");
  advance(10);
  scheduler.push("latest");

  assert.deepEqual(commits, ["first"]);
  advance(29);
  assert.deepEqual(commits, ["first"]);
  advance(1);
  assert.deepEqual(commits, ["first", "latest"]);
});

test("latest-value scheduler can flush final text immediately", async () => {
  const { createLatestValueScheduler } = await load();
  const { clock, advance } = createFakeClock();
  const commits = [];
  const scheduler = createLatestValueScheduler((value) => commits.push(value), 50, clock);

  scheduler.push("partial");
  advance(10);
  scheduler.push("final", { immediate: true });
  advance(100);

  assert.deepEqual(commits, ["partial", "final"]);
});

test("latest-value scheduler drops pending work when a preview closes", async () => {
  const { createLatestValueScheduler } = await load();
  const { clock, advance } = createFakeClock();
  const commits = [];
  const scheduler = createLatestValueScheduler((value) => commits.push(value), 50, clock);

  scheduler.push("visible");
  advance(10);
  scheduler.push("stale");
  scheduler.cancel();
  advance(100);

  assert.deepEqual(commits, ["visible"]);
});
