const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const REQUEST_TIMEOUT_MS = 60_000;

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Runs the real client against a fake utility process that never answers; timers are
// recorded, never fired, so the request timeout is driven explicitly.
function createHarness() {
  const forks = [];
  const timers = new Map();
  let nextTimerId = 0;
  const fakePort = () => ({ on() {}, start() {}, postMessage() {}, close() {} });
  const fork = () => {
    const child = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit("exit", 0));
    };
    child.postMessage = () => {};
    forks.push(child);
    setImmediate(() => child.emit("spawn"));
    return child;
  };
  const context = vm.createContext({
    module: { exports: {} },
    __dirname: path.resolve("src/helpers"),
    process,
    setTimeout(callback, delay) {
      timers.set(++nextTimerId, { callback, delay });
      return nextTimerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    require(name) {
      if (name === "electron")
        return {
          app: { getPath: () => "/tmp" },
          MessageChannelMain: class {
            port1 = fakePort();
            port2 = fakePort();
          },
          utilityProcess: { fork },
        };
      if (name === "./debugLogger") return { info() {}, warn() {}, error() {}, debug() {} };
      return require(name);
    },
  });
  vm.runInContext(
    fs.readFileSync(path.resolve("src/helpers/voiceWorkerClient.js"), "utf8"),
    context
  );
  const fire = (delay) => {
    const [id, timer] = [...timers].find(([, entry]) => entry.delay === delay);
    timers.delete(id);
    timer.callback();
  };
  return { client: new context.module.exports.VoiceWorkerClient(), forks, fire };
}

test("a hung request is rejected, the worker killed, and only that exit reports the timeout", async () => {
  const h = createHarness();
  const exits = [];
  h.client.on("exit", ({ code, killedForTimeout }) => exits.push([code, killedForTimeout]));

  const speak = h.client.request("speak", {});
  await nextTurn();
  h.fire(REQUEST_TIMEOUT_MS);
  await assert.rejects(speak, /voice worker timeout: speak/);
  assert.equal(h.forks[0].killed, true);
  await nextTurn();
  assert.deepEqual(exits, [[0, true]]);
  assert.equal(h.client.running, false);

  // The next request respawns the worker; a crash of that one is not a timeout.
  void h.client.request("speak", {}).catch(() => {});
  await nextTurn();
  assert.equal(h.forks.length, 2);
  h.forks[1].emit("exit", 1);
  assert.deepEqual(exits.at(-1), [1, false]);
});
