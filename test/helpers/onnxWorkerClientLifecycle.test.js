const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const REQUEST_TIMEOUT_MS = 30000;

// Timers are recorded, never fired: request timeouts and respawn backoff are driven explicitly.
function createTimers() {
  const timers = new Map();
  let nextId = 0;
  return {
    timers,
    setTimeout(callback, delay) {
      timers.set(++nextId, { callback, delay });
      return nextId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    fire(delay) {
      const [id, timer] = [...timers].find(([, entry]) => entry.delay === delay);
      timers.delete(id);
      return timer.callback();
    },
  };
}

class FakePort extends EventEmitter {
  constructor() {
    super();
    this.peer = null;
    this.closed = false;
  }

  start() {}

  postMessage(data) {
    const { peer } = this;
    setImmediate(() => {
      if (!peer.closed) peer.emit("message", { data });
    });
  }

  close() {
    this.closed = true;
    this.peer.emit("close");
  }
}

class FakeMessageChannelMain {
  constructor() {
    this.port1 = new FakePort();
    this.port2 = new FakePort();
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Runs the real client against a fake utility process whose worker side is `respond`.
function createHarness({ killExitCode = 0 } = {}) {
  const forks = [];
  const logs = [];
  const timers = createTimers();
  const sessions = { speaker: false, text: false };
  const hanging = new Set();
  const respond = (method) => {
    if (hanging.has(method)) return new Promise(() => {});
    if (method === "ping") return { ok: true, sessions: { ...sessions } };
    return { ok: true };
  };
  const fork = () => {
    const child = new EventEmitter();
    child.pid = 100 + forks.length;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit("exit", killExitCode));
    };
    child.postMessage = (data, ports) => {
      const [port] = ports;
      port.on("message", async ({ data: { id, method } }) => {
        port.postMessage({ id, result: await respond(method) });
      });
      port.start();
    };
    forks.push(child);
    setImmediate(() => child.emit("spawn"));
    return child;
  };
  const context = vm.createContext({
    module: { exports: {} },
    __dirname: path.resolve("src/helpers"),
    process,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    require(name) {
      if (name === "electron")
        return {
          app: { getPath: () => "/tmp" },
          MessageChannelMain: FakeMessageChannelMain,
          utilityProcess: { fork },
        };
      if (name === "./debugLogger")
        return Object.fromEntries(
          ["debug", "info", "warn", "error"].map((level) => [
            level,
            (message, meta) => logs.push({ level, message, meta }),
          ])
        );
      return require(name);
    },
  });
  vm.runInContext(
    fs.readFileSync(path.resolve("src/helpers/onnxWorkerClient.js"), "utf8"),
    context
  );
  return {
    client: context.module.exports,
    forks,
    logs,
    timers,
    sessions,
    hang(method) {
      hanging.add(method);
    },
  };
}

test("unloading unused text does not spawn a worker", async () => {
  const h = createHarness();
  await h.client.request("text.unload", {});
  assert.equal(h.client.child, null);
  assert.equal(h.forks.length, 0);
});

test("unloading after worker exit succeeds without restarting it", async () => {
  const h = createHarness();
  await h.client.request("ping", {});
  const generation = h.client.generation;
  h.forks[0].emit("exit", 0);
  assert.equal(h.client.generation, generation + 1);
  await h.client.request("text.unload", {});
  assert.equal(h.client.child, null);
  assert.equal(h.forks.length, 1);
});

test("releasing an idle worker kills it without counting a crash, and the next request respawns it", async () => {
  const h = createHarness({ killExitCode: 15 });
  await h.client.request("text.unload", {});
  await h.client.request("ping", {});
  const generation = h.client.generation;
  assert.equal(await h.client.releaseIfIdle(), true);
  assert.equal(h.forks[0].killed, true);
  await nextTurn();
  assert.equal(h.client.child, null);
  assert.equal(h.client.generation, generation + 1);
  assert.equal(h.client.crashCount, 0);
  assert.equal(h.client.respawnTimer, null);
  assert.equal(h.client.gaveUp, false);
  assert.equal(h.client.shuttingDown, false);
  assert.ok(h.logs.some((entry) => entry.level === "info" && /released/.test(entry.message)));
  assert.equal(
    h.logs.some((entry) => entry.level === "warn" && /exited/.test(entry.message)),
    false
  );
  await h.client.request("ping", {});
  assert.equal(h.forks.length, 2);
});

test("a worker with a loaded speaker session is left alone", async () => {
  const h = createHarness();
  h.sessions.speaker = true;
  await h.client.request("speaker.load", {});
  assert.equal(await h.client.releaseIfIdle(), false);
  await nextTurn();
  assert.equal(h.forks[0].killed, false);
  assert.ok(h.client.child);
});

test("a worker with an in-flight request is left alone", async () => {
  const h = createHarness();
  h.hang("speaker.extract");
  await h.client.request("ping", {});
  const extract = h.client.request("speaker.extract", {});
  await nextTurn();
  assert.equal(h.client.pending.size, 1);
  assert.equal(await h.client.releaseIfIdle(), false);
  await nextTurn();
  assert.equal(h.forks[0].killed, false);
  assert.ok(h.client.child);
  assert.equal(h.client.pending.size, 1);
  h.forks[0].emit("exit", 0);
  await assert.rejects(extract, /crashed/);
});

test("releasing does nothing without a worker", async () => {
  const h = createHarness();
  assert.equal(await h.client.releaseIfIdle(), false);
  assert.equal(h.forks.length, 0);
});

test("text unload resolves while the worker is shutting down", async () => {
  const h = createHarness();
  await h.client.request("ping", {});
  const stopping = h.client.stop();
  assert.equal((await h.client.request("text.unload", {})).ok, true);
  h.forks[0].emit("exit", 0);
  await stopping;
});

test("text unload resolves while a crash respawn is pending", async () => {
  const h = createHarness();
  await h.client.request("ping", {});
  h.forks[0].emit("exit", 1);
  assert.ok(h.client.respawnTimer);
  assert.equal((await h.client.request("text.unload", {})).ok, true);
  assert.equal(h.forks.length, 1);
});

test("a request timeout kills the worker so the crash path respawns it", async () => {
  const h = createHarness({ killExitCode: 0 });
  h.hang("text.embed");
  await h.client.request("ping", {});
  const embed = h.client.request("text.embed", {});
  await nextTurn();
  await h.timers.fire(REQUEST_TIMEOUT_MS);
  await assert.rejects(embed, /timeout/);
  assert.equal(h.forks[0].killed, true);
  assert.ok(h.logs.some((entry) => entry.level === "warn" && /timeout/i.test(entry.message)));
  await nextTurn();
  assert.equal(h.client.child, null);
  assert.equal(h.client.crashCount, 1);
  assert.ok(h.client.respawnTimer);
});
