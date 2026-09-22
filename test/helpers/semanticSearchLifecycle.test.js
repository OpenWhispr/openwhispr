const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const SemanticSearchLifecycle = require("../../src/helpers/semanticSearchLifecycle");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness() {
  const calls = [];
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
    getPendingVectorChanges(limit = 50) {
      return [...pending].slice(0, limit).map(([note_id, revision]) => ({ note_id, revision }));
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
    logger: { debug() {}, warn() {} },
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
    timers,
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

test("cold searches return fallback and share one activation", async () => {
  const h = harness();
  const gate = deferred();
  h.qdrant.start = async () => {
    h.calls.push("start");
    await gate.promise;
    h.qdrant.ready = true;
  };
  assert.equal(await h.lifecycle.search("first"), null);
  assert.equal(await h.lifecycle.search("second"), null);
  gate.resolve();
  await h.lifecycle.warmUp();
  assert.equal(h.calls.filter((call) => call === "start").length, 1);
  assert.deepEqual(await h.lifecycle.search("third"), [{ noteId: 1, score: 0.9 }]);
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

test("failed indexing retains work, releases resources and returns fallback", async () => {
  const h = harness();
  h.pending.set(1, 1);
  h.notes.set(1, { title: "Note", content: "" });
  h.index.upsertNote = async () => false;
  assert.equal(await h.lifecycle.warmUp(), false);
  assert.equal(h.pending.size, 1);
  assert.equal(await h.lifecycle.search("query"), null);
  assert.ok(h.calls.includes("stop"));
  assert.ok(h.calls.includes("unload"));
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
  await h.lifecycle.warmUp();
  assert.equal(h.lifecycle.isReady(), true);
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
  await h.lifecycle.warmUp();
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

test("missing binary remains dormant and explicit reindex can retry after recovery", async () => {
  const h = harness();
  h.qdrant.available = false;
  assert.equal(await h.lifecycle.warmUp(), false);
  assert.equal(h.calls.includes("start"), false);
  h.qdrant.available = true;
  const result = await h.lifecycle.reindex();
  assert.equal(result.success, true);
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

test("failed model preparation is retried by an explicit request without losing queued notes", async () => {
  const h = harness();
  h.pending.set(1, 1);
  h.notes.set(1, { title: "Queued", content: "" });
  h.embeddings.isAvailable = () => false;
  h.embeddings.downloadModel = async () => {
    throw new Error("download failed");
  };
  assert.equal(await h.lifecycle.warmUp(), false);
  assert.equal(h.pending.size, 1);
  h.embeddings.isAvailable = () => true;
  assert.equal((await h.lifecycle.reindex()).success, true);
  assert.equal(h.pending.size, 0);
});

test("a failed space purge is retained and prevents semantic readiness", async () => {
  const h = harness();
  h.purges.add(4);
  h.index.deleteBySpace = async () => false;
  assert.equal(await h.lifecycle.warmUp(), false);
  assert.equal(h.purges.has(4), true);
  assert.equal(h.lifecycle.isReady(), false);
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
