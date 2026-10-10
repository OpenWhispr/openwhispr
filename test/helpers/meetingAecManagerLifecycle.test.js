const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createHarness() {
  const children = [];
  const timers = new Map();
  let nextTimer = 0;
  const context = vm.createContext({
    module: { exports: {} },
    __dirname: path.resolve("src/helpers"),
    process,
    Buffer,
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    require(name) {
      if (name === "child_process") {
        return {
          spawn() {
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.exitCode = null;
            child.stdin = {
              destroyed: false,
              ended: false,
              write() {},
              end() {
                this.ended = true;
              },
            };
            child.kill = () => {
              child.killed = true;
            };
            children.push(child);
            return child;
          },
        };
      }
      if (name === "fs") return { accessSync() {}, constants: { X_OK: 1 } };
      if (name === "./debugLogger") return { warn() {} };
      return require(name);
    },
  });
  vm.runInContext(
    fs.readFileSync(path.resolve("src/helpers/meetingAecManager.js"), "utf8"),
    context
  );
  const manager = new context.module.exports();
  manager.resolveBinary = () => "/fake/meeting-aec-helper";
  return { manager, children, timers };
}

function frame(pcm) {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(pcm.length);
  return Buffer.concat([header, pcm]);
}

async function start(h, onMicChunk, onError) {
  const started = h.manager.start({ onMicChunk, onError });
  const child = h.children.at(-1);
  child.stderr.emit("data", Buffer.from('{"type":"start"}\n'));
  assert.equal(await started, true);
  return child;
}

function exit(child) {
  child.exitCode = 0;
  child.emit("exit", 0, null);
}

test("stop preserves cleaned mic audio delivered before the helper exits", async () => {
  const h = createHarness();
  const received = [];
  const child = await start(h, (pcm) => received.push(pcm));
  const pcm = Buffer.alloc(4800, 0x12); // 100 ms of mono PCM16 at 24 kHz.
  h.manager.processMicBuffer(pcm);
  const stopped = h.manager.stop();
  assert.equal(child.stdin.ended, true);
  child.stdout.emit("data", frame(pcm));
  exit(child);
  child.emit("close", 0, null);
  await stopped;
  assert.deepEqual(Buffer.concat(received), pcm);
});

test("stop drains a final mic frame split across helper exit before resolving", async () => {
  const h = createHarness();
  const received = [];
  const child = await start(h, (pcm) => received.push(pcm));
  const pcm = Buffer.alloc(4800, 0x34);
  h.manager.processMicBuffer(pcm);
  let settled = false;
  const stopped = h.manager.stop().then(() => {
    settled = true;
  });
  const output = frame(pcm);
  child.stdout.emit("data", output.subarray(0, 103));
  exit(child);
  // A process can exit before its stdout pipe has drained. The native helper
  // also flushes a partial mic frame on stdin EOF before returning from main.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false, "meeting finalization must wait for the remaining PCM");
  child.stdout.emit("data", output.subarray(103));
  child.emit("close", 0, null);
  await stopped;
  assert.deepEqual(Buffer.concat(received), pcm);
});

test("sequential meetings each receive their own complete final frame", async () => {
  const h = createHarness();
  for (const value of [0x12, 0x34]) {
    const received = [];
    const child = await start(h, (pcm) => received.push(pcm));
    const pcm = Buffer.alloc(4800, value);
    const stopped = h.manager.stop();
    exit(child);
    child.stdout.emit("data", frame(pcm));
    child.emit("close", 0, null);
    await stopped;
    assert.deepEqual(Buffer.concat(received), pcm);
  }
});

test("stop still kills a helper that never closes and drops its late output", async () => {
  const h = createHarness();
  const received = [];
  const child = await start(h, (pcm) => received.push(pcm));
  const stopped = h.manager.stop();
  const timer = [...h.timers.values()].find(({ delay }) => delay === 2000);
  timer.callback();
  await stopped;
  assert.equal(child.killed, true);
  child.stdout.emit("data", frame(Buffer.alloc(4800, 0x12)));
  child.emit("close", 0, null);
  assert.deepEqual(received, []);
});

test("an unexpected exit reports its failure before stdio closes", async () => {
  const h = createHarness();
  const errors = [];
  const child = await start(
    h,
    () => {},
    (error) => errors.push(error)
  );
  child.exitCode = 1;
  child.emit("exit", 1, null);
  assert.equal(errors.length, 1);
  child.emit("close", 1, null);
  assert.equal(errors.length, 1);
});

test("a spawn error is reported once even though close follows without exit", async () => {
  const h = createHarness();
  const errors = [];
  const started = h.manager.start({ onError: (error) => errors.push(error) });
  const child = h.children.at(-1);
  child.emit("error", new Error("spawn failed"));
  child.emit("close", -2, null);
  assert.equal(await started, false);
  assert.equal(errors.length, 1);
});
