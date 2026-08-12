const test = require("node:test");
const assert = require("node:assert");

const {
  LocalInferenceScheduler,
} = require("../../src/helpers/localInferenceScheduler");

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("grants the slot immediately when free", async () => {
  const s = new LocalInferenceScheduler();
  const release = await s.acquire({ priority: "batch" });
  assert.equal(s.busy, true);
  release();
  assert.equal(s.busy, false);
});

test("holds a second acquire until the first releases", async () => {
  const s = new LocalInferenceScheduler();
  const first = await s.acquire({ priority: "batch" });

  let granted = false;
  const second = s.acquire({ priority: "batch" }).then((r) => {
    granted = true;
    return r;
  });

  await tick();
  assert.equal(granted, false, "second waiter must not be granted while held");

  first();
  const release = await second;
  assert.equal(granted, true);
  release();
});

test("an interactive waiter is granted before a batch waiter queued earlier", async () => {
  const s = new LocalInferenceScheduler();
  const held = await s.acquire({ priority: "batch" });

  const order = [];
  const batch = s.acquire({ priority: "batch" }).then((r) => {
    order.push("batch");
    return r;
  });
  await tick();
  const interactive = s.acquire({ priority: "interactive" }).then((r) => {
    order.push("interactive");
    return r;
  });
  await tick();

  held();
  (await interactive)();
  (await batch)();

  assert.deepEqual(order, ["interactive", "batch"]);
});

test("FIFO holds within a single priority", async () => {
  const s = new LocalInferenceScheduler();
  const held = await s.acquire({ priority: "batch" });

  const order = [];
  const a = s.acquire({ priority: "batch" }).then((r) => (order.push("a"), r));
  await tick();
  const b = s.acquire({ priority: "batch" }).then((r) => (order.push("b"), r));
  await tick();
  const c = s.acquire({ priority: "batch" }).then((r) => (order.push("c"), r));
  await tick();

  held();
  (await a)();
  (await b)();
  (await c)();

  assert.deepEqual(order, ["a", "b", "c"]);
});

test("an interactive flood does not permanently starve batch", async () => {
  const s = new LocalInferenceScheduler();
  const held = await s.acquire({ priority: "batch" });

  const order = [];
  const batch = s.acquire({ priority: "batch" }).then((r) => (order.push("batch"), r));
  await tick();
  const i1 = s.acquire({ priority: "interactive" }).then((r) => (order.push("i1"), r));
  await tick();

  held();
  (await i1)();
  // Queued only after i1 was granted — must not jump ahead of the waiting batch.
  const i2 = s.acquire({ priority: "interactive" }).then((r) => (order.push("i2"), r));
  await tick();
  (await batch)();
  (await i2)();

  assert.deepEqual(order, ["i1", "batch", "i2"]);
});

test("an interactive waiter rejects with LOCAL_INFERENCE_BUSY after its timeout", async () => {
  const s = new LocalInferenceScheduler();
  const held = await s.acquire({ priority: "batch" });

  await assert.rejects(
    () => s.acquire({ priority: "interactive", timeoutMs: 10 }),
    (err) => err.code === "LOCAL_INFERENCE_BUSY"
  );

  held();
  // The timed-out waiter must not later take the slot.
  const release = await s.acquire({ priority: "batch" });
  release();
});

test("a timed-out waiter is removed from the queue", async () => {
  const s = new LocalInferenceScheduler();
  const held = await s.acquire({ priority: "batch" });

  await assert.rejects(() => s.acquire({ priority: "interactive", timeoutMs: 10 }));
  assert.equal(s.waiting, 0);
  held();
});

test("an aborted waiter is removed and never takes the slot", async () => {
  const s = new LocalInferenceScheduler();
  const held = await s.acquire({ priority: "batch" });

  const controller = new AbortController();
  const aborted = s.acquire({ priority: "batch", signal: controller.signal });
  await tick();
  controller.abort();

  await assert.rejects(() => aborted, (err) => err.code === "LOCAL_INFERENCE_ABORTED");
  assert.equal(s.waiting, 0);

  held();
  assert.equal(s.busy, false, "an aborted waiter must not have taken the slot");
});

test("batch waiters beyond the cap are rejected", async () => {
  const s = new LocalInferenceScheduler({ maxBatchWaiters: 2 });
  const held = await s.acquire({ priority: "batch" });

  const a = s.acquire({ priority: "batch" });
  const b = s.acquire({ priority: "batch" });
  await tick();

  await assert.rejects(
    () => s.acquire({ priority: "batch" }),
    (err) => err.code === "LOCAL_INFERENCE_QUEUE_FULL"
  );

  held();
  (await a)();
  (await b)();
});

test("release is idempotent and cannot free the slot twice", async () => {
  const s = new LocalInferenceScheduler();
  const release = await s.acquire({ priority: "batch" });
  const second = s.acquire({ priority: "batch" });

  release();
  release(); // double release must not grant the slot to two holders

  const held = await second;
  assert.equal(s.busy, true);

  let thirdGranted = false;
  s.acquire({ priority: "batch" }).then(() => {
    thirdGranted = true;
  });
  await tick();
  assert.equal(thirdGranted, false, "double release must not have freed an extra slot");
  held();
});

test("runExclusive frees the slot when the body throws", async () => {
  const s = new LocalInferenceScheduler();
  await assert.rejects(() =>
    s.runExclusive({ priority: "batch" }, async () => {
      throw new Error("boom");
    })
  );
  assert.equal(s.busy, false);

  const release = await s.acquire({ priority: "batch" });
  release();
});

// ── Leases (review C1: the renderer's chat-agent stream) ────────────────────

test("a lease holds the slot until released", async () => {
  const s = new LocalInferenceScheduler();
  const lease = await s.acquireLease({ owner: "wc-1", priority: "interactive" });
  assert.equal(s.busy, true);

  s.releaseLease(lease.id);
  assert.equal(s.busy, false);
});

test("releasing an unknown or already-released lease is a no-op", async () => {
  const s = new LocalInferenceScheduler();
  const lease = await s.acquireLease({ owner: "wc-1" });
  s.releaseLease(lease.id);
  s.releaseLease(lease.id);
  s.releaseLease("nope");
  assert.equal(s.busy, false);

  const release = await s.acquire({ priority: "batch" });
  release();
});

test("releaseLeasesForOwner frees a lease whose owner went away", async () => {
  const s = new LocalInferenceScheduler();
  await s.acquireLease({ owner: "wc-1" });
  assert.equal(s.busy, true);

  s.releaseLeasesForOwner("wc-1");
  assert.equal(s.busy, false);
});

test("a lease is reclaimed after its max hold elapses", async () => {
  const reclaimed = [];
  const s = new LocalInferenceScheduler({
    leaseMaxHoldMs: 10,
    onLeaseReclaimed: (id) => reclaimed.push(id),
  });
  const lease = await s.acquireLease({ owner: "wc-1" });

  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(s.busy, false, "an expired lease must not hold the slot forever");
  assert.deepEqual(reclaimed, [lease.id]);
});

test("a model switch cannot begin while another holder has the slot", async () => {
  // The scheduler is the only thing standing between a batch pass and the chat
  // agent's llamaServerStart, which stops the running server.
  const s = new LocalInferenceScheduler();
  const pass = await s.acquire({ priority: "batch" });

  let switchStarted = false;
  const lease = s.acquireLease({ owner: "wc-1", priority: "interactive" }).then((l) => {
    switchStarted = true;
    return l;
  });

  await tick();
  assert.equal(switchStarted, false, "the server switch must wait for the pass");

  pass();
  const l = await lease;
  assert.equal(switchStarted, true);
  s.releaseLease(l.id);
});
