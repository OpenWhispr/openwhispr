const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise start/stop against controllable OS children and timers. A killed
// child can still deliver buffered stdout and its asynchronous exit event.
function harness(platform = "win32", { native = true } = {}) {
  const children = [];
  const queries = [];
  const timers = new Map();
  const intervals = new Map();
  let nextTimer = 0;
  const context = vm.createContext({
    module: { exports: {} },
    __dirname: path.resolve(__dirname, "../../src/helpers"),
    Buffer,
    process: { platform },
    setTimeout(callback, delay) {
      timers.set(++nextTimer, { callback, delay });
      return nextTimer;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval(callback, delay) {
      intervals.set(++nextTimer, { callback, delay });
      return nextTimer;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    require(name) {
      if (name === "./debugLogger") return { debug() {} };
      if (name === "fs") return { accessSync() {}, constants: { X_OK: 1 } };
      if (name === "child_process") {
        return {
          spawn(command, args) {
            const child = new EventEmitter();
            child.command = command;
            child.args = args;
            child.stdout = new EventEmitter();
            child.stdout.setEncoding = () => {};
            child.stderr = new EventEmitter();
            child.stderr.setEncoding = () => {};
            child.stdin = { write() {}, end() {} };
            child.kills = 0;
            child.kill = () => child.kills++;
            children.push(child);
            return child;
          },
          execFile(command, args, options, callback) {
            queries.push({ args, reply: (value) => callback(null, value) });
          },
        };
      }
      return require(name);
    },
  });
  vm.runInContext(
    fs.readFileSync(path.resolve(__dirname, "../../src/helpers/textEditMonitor.js"), "utf8"),
    context
  );
  const monitor = new context.module.exports();
  monitor.resolveBinary = () => (native ? { command: "text-monitor", args: [] } : null);
  const edits = [];
  monitor.on("text-edited", (edit) => edits.push({ ...edit }));
  return {
    monitor,
    children,
    queries,
    timers,
    intervals,
    edits,
    fire(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `expected a ${delay}ms timer`);
      const [id, timer] = entry;
      timers.delete(id);
      return timer.callback();
    },
    async start(text = "Ask Katherine about the invoice.", targetPid = 42) {
      monitor.startMonitoring(text, 30000, { targetPid });
      if (platform === "darwin" && native) {
        this.fire(500);
        await Promise.resolve();
      }
    },
  };
}

test("the current child reports corrections and is killed when monitoring stops", async () => {
  const h = harness();
  await h.start();
  h.children[0].stdout.emit("data", "CHANGED:Ask Catherine about the invoice.\n");
  assert.deepEqual(h.edits, [
    {
      originalText: "Ask Katherine about the invoice.",
      newFieldValue: "Ask Catherine about the invoice.",
    },
  ]);
  h.monitor.stopMonitoring();
  assert.equal(h.children[0].kills, 1);
  assert.equal(h.timers.size, 0);
});

test("a replaced child's buffered correction never belongs to the next dictation", async () => {
  const h = harness();
  await h.start();
  await h.start("Ask Kathryn about the invoice.");
  assert.equal(h.children[0].kills, 1);
  h.children[0].stdout.emit("data", "CHANGED:Ask Catherine about the invoice.\n");
  assert.deepEqual(h.edits, []);
  h.children[1].stdout.emit("data", "CHANGED:Ask Kathrin about the invoice.\n");
  assert.deepEqual(h.edits, [
    {
      originalText: "Ask Kathryn about the invoice.",
      newFieldValue: "Ask Kathrin about the invoice.",
    },
  ]);
  h.monitor.stopMonitoring();
});

for (const platform of ["win32", "linux", "darwin"]) {
  test(`${platform}: old output and termination cannot stop or detach an identical-text replacement`, async () => {
    const h = harness(platform);
    await h.start();
    await h.start();
    const [old, current] = h.children;
    const encoded = Buffer.from("Ask Catherine about the invoice.").toString("base64");
    current.stdout.emit("data", `CHANGED_B64:${encoded.slice(0, 8)}`);
    old.stdout.emit("data", "CHANGED:old edit\nNO_ELEMENT\n");
    current.stdout.emit("data", `${encoded.slice(8)}\n`);
    assert.deepEqual(h.edits, [
      {
        originalText: "Ask Katherine about the invoice.",
        newFieldValue: "Ask Catherine about the invoice.",
      },
    ]);
    old.emit("error", new Error("late old spawn failure"));
    old.emit("exit", null, "SIGTERM");
    assert.equal(h.monitor.process, current);
    assert.equal(h.timers.size, 1, "stale errors must not start macOS fallback polling");
    h.fire(30000);
    assert.equal(current.kills, 1, "the current monitor still has an owner at timeout");
    assert.equal(h.intervals.size, 0);
  });
}

test("macOS: a superseded native startup cannot spawn after its settle delay", async () => {
  const h = harness("darwin");
  h.monitor.startMonitoring("same dictated text", 30000, { targetPid: 41 });
  h.monitor.startMonitoring("same dictated text", 30000, { targetPid: 42 });
  h.fire(500);
  await Promise.resolve();
  assert.equal(h.children.length, 0);
  h.fire(500);
  await Promise.resolve();
  assert.equal(h.children.length, 1);
  assert.deepEqual(Array.from(h.children[0].args), ["42"]);
  h.monitor.stopMonitoring();
  assert.equal(h.children[0].kills, 1);
});

test("macOS polling reports current corrections and stops its interval", async () => {
  const h = harness("darwin", { native: false });
  await h.start();
  const initial = h.fire(500);
  h.queries[0].reply("Ask Katherine about the invoice.\n");
  await initial;
  const poll = [...h.intervals.values()][0].callback();
  h.queries[1].reply("Ask Catherine about the invoice.\n");
  await poll;
  assert.deepEqual(h.edits, [
    {
      originalText: "Ask Katherine about the invoice.",
      newFieldValue: "Ask Catherine about the invoice.",
    },
  ]);
  h.monitor.stopMonitoring();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.timers.size, 0);
});

test("macOS: a superseded polling startup does not query the old app", async () => {
  const h = harness("darwin", { native: false });
  await h.start("same dictated text", 41);
  await h.start("same dictated text", 42);
  h.fire(500);
  assert.equal(h.queries.length, 0);
  const current = h.fire(500);
  h.queries[0].reply("same dictated text\n");
  await current;
  assert.equal(h.intervals.size, 1);
  h.monitor.stopMonitoring();
});

test("macOS: an old initial AX query cannot install polling over a replacement", async () => {
  const h = harness("darwin", { native: false });
  await h.start();
  const oldInitial = h.fire(500);
  await h.start();
  h.queries[0].reply("Ask Katherine about the invoice.\n");
  await oldInitial;
  assert.equal(h.intervals.size, 0);
  const initial = h.fire(500);
  h.queries[1].reply("Ask Katherine about the invoice.\n");
  await initial;
  assert.equal(h.intervals.size, 1);
  h.monitor.stopMonitoring();
  assert.equal(h.intervals.size, 0);
});

test("macOS: a poll completed after restart cannot emit a correction for the new run", async () => {
  const h = harness("darwin", { native: false });
  await h.start();
  const initial = h.fire(500);
  h.queries[0].reply("Ask Katherine about the invoice.\n");
  await initial;
  const oldPoll = [...h.intervals.values()][0].callback();
  await h.start();
  h.queries[1].reply("Ask Catherine about the invoice.\n");
  await oldPoll;
  assert.deepEqual(h.edits, []);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.monitor.currentOriginalText, "Ask Katherine about the invoice.");
  h.monitor.stopMonitoring();
});

test("macOS: an empty initial query's retry is cancelled by a new monitoring run", async () => {
  const h = harness("darwin", { native: false });
  await h.start();
  const initial = h.fire(500);
  h.queries[0].reply("");
  await initial;
  await h.start();
  h.fire(300);
  assert.equal(h.queries.length, 1);
  assert.equal(h.intervals.size, 0);
  h.monitor.stopMonitoring();
  await h.fire(500);
  assert.equal(h.queries.length, 1, "stop also cancels the replacement's delayed startup");
});

test("the current child's final buffered edit is still read after its exit event", async () => {
  const h = harness();
  await h.start();
  h.children[0].emit("exit", 0, null);
  h.children[0].stdout.emit("data", "CHANGED:Ask Catherine about the invoice.\n");
  assert.equal(h.edits.length, 1);
  assert.equal(h.edits[0].newFieldValue, "Ask Catherine about the invoice.");
  h.monitor.stopMonitoring();
});
