const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const SemanticSearchLifecycle = require("../../src/helpers/semanticSearchLifecycle");

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness() {
  const calls = [];
  const logs = [];
  const pending = new Map();
  const notes = new Map();
  const purges = new Set();
  const timers = new Map();
  let nextTimer = 0;
  let now = 0;
  const qdrant = new EventEmitter();
  Object.assign(qdrant, {
    ready: false,
    available: true,
    port: 6333,
    isAvailable() {
      return this.available;
    },
    isReady() {
      return this.ready;
    },
    getPort() {
      return this.port;
    },
    async start() {
      calls.push("start");
      this.ready = true;
    },
    async stop() {
      calls.push("stop");
      this.ready = false;
    },
  });
  const index = {
    init(port) {
      calls.push(["init", port]);
    },
    reset() {
      calls.push("reset");
    },
    async ensureCollection() {
      return { created: false };
    },
    async upsertNote(id, text, payload) {
      calls.push(["upsert", id, text, payload]);
      return true;
    },
    async deleteNote(id) {
      calls.push(["delete", id]);
      return true;
    },
    async deleteBySpace(id) {
      calls.push(["purge", id]);
      return true;
    },
    async search() {
      calls.push("search");
      return [{ noteId: 1, score: 0.9 }];
    },
  };
  const embeddings = {
    isAvailable() {
      return true;
    },
    async downloadModel() {
      calls.push("download");
    },
    async unload() {
      calls.push("unload");
    },
  };
  const database = {
    getPendingVectorChanges(limit = 50, afterRevision = 0) {
      return [...pending]
        .filter(([, revision]) => revision > afterRevision)
        .sort(([, a], [, b]) => a - b)
        .slice(0, limit)
        .map(([note_id, revision]) => ({ note_id, revision }));
    },
    clearPendingVectorChange(id, revision) {
      if (pending.get(id) === revision) pending.delete(id);
    },
    getNoteForVectorIndex(id) {
      return notes.get(id);
    },
    getPendingVectorPurges() {
      return [...purges].map((space_id) => ({ space_id }));
    },
    clearPendingVectorPurge(id) {
      purges.delete(id);
    },
    enqueueAllVectorChanges() {
      for (const id of notes.keys()) pending.set(id, (pending.get(id) || 0) + 1);
      return { success: true };
    },
  };
  const lifecycle = new SemanticSearchLifecycle({
    qdrant,
    vectorIndex: index,
    embeddings,
    database,
    noteEmbedText: (title, content, enhanced) => `${title}\n${enhanced || content}`.slice(0, 1500),
    logger: {
      debug(message, meta) {
        logs.push(["debug", message, meta]);
      },
      warn(message, meta) {
        logs.push(["warn", message, meta]);
      },
    },
    now: () => now,
    setTimeout(callback, delay) {
      timers.set(++nextTimer, { callback, delay });
      return nextTimer;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  return {
    lifecycle,
    qdrant,
    index,
    embeddings,
    database,
    pending,
    notes,
    purges,
    calls,
    logs,
    timers,
    fireTimer(delay) {
      const [id, timer] = [...timers].find(([, entry]) => entry.delay === delay);
      timers.delete(id);
      return timer.callback();
    },
    setNow(value) {
      now = value;
    },
  };
}

test("construction and background note changes do not start resources", () => {
  const h = harness();
  h.lifecycle.notifyChanges();
  assert.deepEqual(h.calls, []);
  assert.equal(h.lifecycle.isReady(), false);
});

function gateStart(h) {
  const gate = deferred();
  h.qdrant.start = async () => {
    h.calls.push("start");
    await gate.promise;
    h.qdrant.ready = true;
  };
  return gate;
}

test("cold searches answer with keywords at once and share one background activation", async () => {
  const h = harness();
  const gate = gateStart(h);
  assert.equal(await h.lifecycle.search("first"), null);
  assert.equal(await h.lifecycle.search("second"), null);
  gate.resolve();
  assert.equal(await h.lifecycle.warmUp(), true);
  assert.equal(h.calls.filter((call) => call === "start").length, 1);
  assert.deepEqual(await h.lifecycle.search("warm"), [{ noteId: 1, score: 0.9 }]);
});

test("a warm index keeps answering while an edit drains in the background", async () => {
  const h = harness();
  await h.lifecycle.warmUp();
  const gate = deferred();
  h.index.upsertNote = () => gate.promise;
  h.pending.set(1, 1);
  h.notes.set(1, { title: "Live note", content: "" });
  h.lifecycle.notifyChanges();
  assert.deepEqual(await h.lifecycle.search("query"), [{ noteId: 1, score: 0.9 }]);
  gate.resolve(true);
  assert.equal(await h.lifecycle.warmUp(), true);
  assert.equal(h.pending.size, 0);
});

test("an existing collection answers while activation drains; a new one waits for the drain", async () => {
  for (const created of [false, true]) {
    const h = harness();
    h.index.ensureCollection = async () => ({ created });
    const started = deferred();
    const gate = deferred();
    h.index.upsertNote = () => {
      started.resolve();
      return gate.promise;
    };
    h.notes.set(1, { title: "Queued", content: "" });
    h.pending.set(1, 1);
    const activation = h.lifecycle.warmUp();
    await started.promise;
    assert.deepEqual(
      await h.lifecycle.search("query"),
      created ? null : [{ noteId: 1, score: 0.9 }]
    );
    gate.resolve(true);
    assert.equal(await activation, true);
  }
});

test("activation drains purges, live updates and deletions before readiness", async () => {
  const h = harness();
  h.pending.set(1, 1);
  h.pending.set(2, 2);
  h.pending.set(3, 3);
  h.notes.set(1, {
    title: "Title",
    content: "old",
    enhanced_content: "latest",
    space_id: 4,
    folder_id: 5,
  });
  h.notes.set(3, { deleted_at: "today" });
  h.purges.add(8);
  assert.equal(await h.lifecycle.warmUp(), true);
  assert.deepEqual(h.calls.filter(Array.isArray), [
    ["init", 6333],
    ["purge", 8],
    ["upsert", 1, "Title\nlatest", { space_id: 4, folder_id: 5 }],
    ["delete", 2],
    ["delete", 3],
  ]);
  assert.equal(h.pending.size, 0);
  assert.equal(h.purges.size, 0);
});

test("an update arriving during indexing cannot be acknowledged by an older revision", async () => {
  const h = harness();
  h.pending.set(1, 1);
  h.notes.set(1, { title: "Before", content: "" });
  const original = h.index.upsertNote;
  let count = 0;
  h.index.upsertNote = async (...args) => {
    await original(...args);
    if (++count === 1) {
      h.pending.set(1, 2);
      h.notes.set(1, { title: "After", content: "" });
    }
    return true;
  };
  await h.lifecycle.warmUp();
  assert.deepEqual(
    h.calls.filter((call) => Array.isArray(call) && call[0] === "upsert").map((call) => call[2]),
    ["Before\n", "After\n"]
  );
  assert.equal(h.pending.size, 0);
});

function failUpsertFor(h, noteId) {
  const original = h.index.upsertNote;
  h.index.upsertNote = async (id, ...rest) => {
    await original(id, ...rest);
    return id !== noteId;
  };
}

function upsertsFor(h, noteId) {
  return h.calls.filter((call) => Array.isArray(call) && call[0] === "upsert" && call[1] === noteId)
    .length;
}

test("a row that keeps failing is skipped: later rows index, search works and Qdrant stays up", async () => {
  const h = harness();
  h.pending.set(1, 1);
  h.pending.set(2, 2);
  h.notes.set(1, { title: "Poison", content: "" });
  h.notes.set(2, { title: "Healthy", content: "" });
  failUpsertFor(h, 1);
  assert.equal(await h.lifecycle.warmUp(), true);
  assert.equal(upsertsFor(h, 2), 1);
  assert.equal(h.pending.has(1), true);
  assert.equal(h.pending.has(2), false);
  assert.equal(h.lifecycle.isReady(), true);
  assert.deepEqual(await h.lifecycle.search("query"), [{ noteId: 1, score: 0.9 }]);
  assert.equal(h.calls.includes("stop"), false);
  assert.equal(h.calls.includes("unload"), false);
  assert.ok(h.logs.some(([level, message]) => level === "debug" && /failed/i.test(message)));
});

test("a failing row is retried after the delay, parked after three failures, and re-walked after release", async () => {
  const h = harness();
  h.pending.set(1, 1);
  h.notes.set(1, { title: "Poison", content: "" });
  failUpsertFor(h, 1);
  assert.equal(await h.lifecycle.warmUp(), true);
  assert.equal(upsertsFor(h, 1), 1);
  await h.fireTimer(30000);
  assert.equal(upsertsFor(h, 1), 2);
  await h.fireTimer(30000);
  assert.equal(upsertsFor(h, 1), 3);
  assert.equal(
    [...h.timers.values()].some((timer) => timer.delay === 30000),
    false
  );
  assert.equal(h.lifecycle.isReady(), true);
  assert.equal(h.pending.has(1), true);
  await h.fireTimer(300000);
  assert.equal(await h.lifecycle.warmUp(), true);
  assert.equal(upsertsFor(h, 1), 4);
});

test("a new revision for a parked note is processed", async () => {
  const h = harness();
  h.pending.set(1, 1);
  h.notes.set(1, { title: "Poison", content: "" });
  failUpsertFor(h, 1);
  await h.lifecycle.warmUp();
  await h.fireTimer(30000);
  await h.fireTimer(30000);
  assert.equal(upsertsFor(h, 1), 3);
  h.pending.set(1, 2);
  h.notes.set(1, { title: "Fixed", content: "" });
  h.index.upsertNote = async (...args) => {
    h.calls.push(["upsert", ...args]);
    return true;
  };
  assert.equal(h.lifecycle.isReady(), false);
  assert.equal(await h.lifecycle.warmUp(), true);
  assert.equal(upsertsFor(h, 1), 4);
  assert.equal(h.pending.size, 0);
});

test("five minutes of idle releases resources and later search can wake them", async () => {
  const h = harness();
  await h.lifecycle.warmUp();
  const timer = [...h.timers.values()][0];
  assert.equal(timer.delay, 300000);
  await timer.callback();
  assert.equal(h.lifecycle.isReady(), false);
  assert.ok(h.calls.includes("unload"));
  assert.equal(await h.lifecycle.search("wake"), null);
  assert.equal(await h.lifecycle.warmUp(), true);
  assert.deepEqual(await h.lifecycle.search("wake"), [{ noteId: 1, score: 0.9 }]);
});

test("an in-flight search prevents idle teardown", async () => {
  const h = harness();
  await h.lifecycle.warmUp();
  const gate = deferred();
  h.index.search = () => gate.promise;
  const search = h.lifecycle.search("slow");
  assert.equal(h.timers.size, 0);
  gate.resolve([]);
  await search;
  assert.equal(h.timers.size, 1);
});

test("a search during idle shutdown waits for teardown before warming", async () => {
  const h = harness();
  await h.lifecycle.warmUp();
  const gate = deferred();
  h.qdrant.stop = async () => {
    h.calls.push("stop");
    await gate.promise;
    h.qdrant.ready = false;
  };
  const stopping = [...h.timers.values()][0].callback();
  assert.equal(await h.lifecycle.search("wake"), null);
  gate.resolve();
  await stopping;
  assert.equal(await h.lifecycle.warmUp(), true);
  assert.equal(h.lifecycle.isReady(), true);
});

test("quit during model preparation prevents a late child spawn", async () => {
  const h = harness();
  const gate = deferred();
  h.embeddings.isAvailable = () => false;
  h.embeddings.downloadModel = () => gate.promise;
  const warming = h.lifecycle.warmUp();
  await Promise.resolve();
  const stopping = h.lifecycle.stop();
  gate.resolve();
  await Promise.all([warming, stopping]);
  assert.equal(h.calls.includes("start"), false);
  assert.equal(await h.lifecycle.warmUp(), false);
});

test("missing binary remains dormant and retries once the retry window passes", async () => {
  const h = harness();
  h.qdrant.available = false;
  assert.equal(await h.lifecycle.warmUp(), false);
  assert.equal(h.calls.includes("start"), false);
  h.qdrant.available = true;
  assert.equal(await h.lifecycle.warmUp(), false);
  h.setNow(30000);
  assert.equal(await h.lifecycle.warmUp(), true);
});

test("Qdrant recovery rewires the new port and drains updates", async () => {
  const h = harness();
  await h.lifecycle.warmUp();
  h.qdrant.port = 6335;
  h.qdrant.emit("restarted", 6335);
  await h.lifecycle.warmUp();
  assert.ok(h.calls.some((call) => Array.isArray(call) && call[0] === "init" && call[1] === 6335));
});

test("successful final health restart does not prevent wake after a deliberate idle stop", async () => {
  const h = harness();
  h.qdrant.restartCount = 3;
  h.qdrant.ready = true;
  await h.lifecycle.warmUp();
  await [...h.timers.values()][0].callback();
  assert.equal(await h.lifecycle.warmUp(), true);
});

test("an exhausted unhealthy restart budget is not bypassed by queries", async () => {
  const h = harness();
  h.qdrant.restartBlocked = true;
  assert.equal(await h.lifecycle.warmUp(), false);
  assert.equal(h.calls.includes("start"), false);
});

test("restart event recovers after the manager finishes its restarting critical section", async () => {
  const h = harness();
  await h.lifecycle.warmUp();
  h.qdrant.restarting = true;
  h.qdrant.port = 6335;
  h.qdrant.emit("restarted", 6335);
  h.qdrant.restarting = false;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.lifecycle.isReady(), true);
  assert.ok(h.calls.some((call) => Array.isArray(call) && call[0] === "init" && call[1] === 6335));
});

test("failed model preparation releases resources and is retried without losing queued notes", async () => {
  const h = harness();
  h.pending.set(1, 1);
  h.notes.set(1, { title: "Queued", content: "" });
  h.embeddings.isAvailable = () => false;
  h.embeddings.downloadModel = async () => {
    throw new Error("download failed");
  };
  assert.equal(await h.lifecycle.warmUp(), false);
  assert.equal(h.pending.size, 1);
  assert.ok(h.calls.includes("unload"));
  h.embeddings.isAvailable = () => true;
  h.setNow(30000);
  assert.equal(await h.lifecycle.warmUp(), true);
  assert.equal(h.pending.size, 0);
});

test("a failed space purge is retried after the delay without blocking semantic search", async () => {
  const h = harness();
  h.purges.add(4);
  let purgeAttempts = 0;
  h.index.deleteBySpace = async () => {
    purgeAttempts++;
    return purgeAttempts > 1;
  };
  assert.equal(await h.lifecycle.warmUp(), true);
  assert.equal(h.purges.has(4), true);
  assert.equal(h.lifecycle.isReady(), true);
  assert.deepEqual(await h.lifecycle.search("query"), [{ noteId: 1, score: 0.9 }]);
  await h.fireTimer(30000);
  assert.equal(purgeAttempts, 2);
  assert.equal(h.purges.has(4), false);
});

test("collection recreation queues unchanged notes for embedding again", async () => {
  const h = harness();
  h.notes.set(1, { title: "Existing", content: "" });
  h.index.ensureCollection = async () => ({ created: true });
  assert.equal(await h.lifecycle.warmUp(), true);
  assert.ok(h.calls.some((call) => Array.isArray(call) && call[0] === "upsert" && call[1] === 1));
});

test("health recovery preserves the deadline when no search or indexing occurs", async () => {
  const h = harness();
  await h.lifecycle.warmUp();
  h.setNow(290000);
  h.qdrant.restarting = true;
  h.qdrant.emit("restarted", 6333);
  h.qdrant.restarting = false;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal([...h.timers.values()][0].delay, 10000);
});

test("indexing during recovery starts a new idle window", async () => {
  const h = harness();
  await h.lifecycle.warmUp();
  h.setNow(290000);
  h.pending.set(1, 1);
  h.notes.set(1, { title: "Changed", content: "" });
  h.qdrant.emit("restarted", 6333);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal([...h.timers.values()][0].delay, 300000);
});

test("stop releases without a second Qdrant stop and swallows cleanup errors", async () => {
  const h = harness();
  await h.lifecycle.warmUp();
  h.embeddings.unload = async () => {
    throw new Error("worker gone");
  };
  await h.lifecycle.stop();
  assert.equal(h.calls.filter((call) => call === "stop").length, 1);
  assert.ok(h.calls.includes("reset"));
  assert.ok(h.logs.some(([level]) => level === "warn"));
});

test("idle stop defers while Qdrant is restarting and lands after the restart settles", async () => {
  const h = harness();
  await h.lifecycle.warmUp();
  h.qdrant.restarting = true;
  await h.fireTimer(IDLE_TIMEOUT_MS);
  assert.equal(h.calls.includes("stop"), false);
  assert.equal(h.calls.includes("unload"), false);
  h.qdrant.restarting = false;
  await h.fireTimer(30000);
  assert.ok(h.calls.includes("stop"));
  assert.ok(h.calls.includes("unload"));
});

test("a change notification with a closed database logs instead of throwing", async () => {
  const h = harness();
  await h.lifecycle.warmUp();
  h.database.getPendingVectorChanges = () => {
    throw new Error("database closed");
  };
  assert.doesNotThrow(() => h.lifecycle.notifyChanges());
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    h.logs.some(([level, , meta]) => level === "warn" && meta?.error === "database closed")
  );
});
