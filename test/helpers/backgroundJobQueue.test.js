const test = require("node:test");
const assert = require("node:assert/strict");

test("processes jobs in FIFO order", async () => {
  const { BackgroundJobQueue } = await import("../../src/helpers/backgroundJobQueue.js");
  const queue = new BackgroundJobQueue();
  const order = [];

  queue.enqueue("a", async () => { order.push("a"); });
  queue.enqueue("b", async () => { order.push("b"); });
  queue.enqueue("c", async () => { order.push("c"); });

  await queue.drain();
  assert.deepStrictEqual(order, ["a", "b", "c"]);
});

test("runs only one job at a time", async () => {
  const { BackgroundJobQueue } = await import("../../src/helpers/backgroundJobQueue.js");
  const queue = new BackgroundJobQueue();
  let concurrency = 0;
  let maxConcurrency = 0;

  const makeJob = () => async () => {
    concurrency++;
    maxConcurrency = Math.max(maxConcurrency, concurrency);
    await new Promise((r) => setTimeout(r, 10));
    concurrency--;
  };

  queue.enqueue("x", makeJob());
  queue.enqueue("y", makeJob());
  await queue.drain();
  assert.equal(maxConcurrency, 1);
});

test("emits status events for each job", async () => {
  const { BackgroundJobQueue } = await import("../../src/helpers/backgroundJobQueue.js");
  const queue = new BackgroundJobQueue();
  const events = [];

  queue.on("status", (e) => events.push({ id: e.jobId, status: e.status }));
  queue.enqueue("j1", async () => {});
  await queue.drain();

  assert.deepStrictEqual(events, [
    { id: "j1", status: "running" },
    { id: "j1", status: "complete" },
  ]);
});

test("captures error and continues queue on job failure", async () => {
  const { BackgroundJobQueue } = await import("../../src/helpers/backgroundJobQueue.js");
  const queue = new BackgroundJobQueue();
  const events = [];

  queue.on("status", (e) => events.push({ id: e.jobId, status: e.status, error: e.error }));
  queue.enqueue("fail", async () => { throw new Error("boom"); });
  queue.enqueue("ok", async () => {});
  await queue.drain();

  assert.equal(events[1].status, "error");
  assert.equal(events[1].error, "boom");
  assert.equal(events[3].status, "complete");
});

test("returns queue length and active job info", async () => {
  const { BackgroundJobQueue } = await import("../../src/helpers/backgroundJobQueue.js");
  const queue = new BackgroundJobQueue();

  assert.equal(queue.length, 0);
  assert.equal(queue.activeJob, null);

  let resolve;
  const blocker = new Promise((r) => { resolve = r; });
  queue.enqueue("slow", () => blocker);
  queue.enqueue("waiting", async () => {});

  await new Promise((r) => setTimeout(r, 5));
  assert.equal(queue.activeJob, "slow");
  assert.equal(queue.length, 1);

  resolve();
  await queue.drain();
  assert.equal(queue.length, 0);
  assert.equal(queue.activeJob, null);
});

test("cancelPending removes unstarted jobs", async () => {
  const { BackgroundJobQueue } = await import("../../src/helpers/backgroundJobQueue.js");
  const queue = new BackgroundJobQueue();
  const ran = [];

  let resolve;
  const blocker = new Promise((r) => { resolve = r; });
  queue.enqueue("running", () => blocker);
  queue.enqueue("pending-1", async () => { ran.push("pending-1"); });
  queue.enqueue("pending-2", async () => { ran.push("pending-2"); });

  await new Promise((r) => setTimeout(r, 5));
  queue.cancelPending();
  resolve();
  await queue.drain();

  assert.equal(ran.length, 0);
});
