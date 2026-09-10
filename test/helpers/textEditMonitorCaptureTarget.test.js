const test = require("node:test");
const assert = require("node:assert/strict");

const TextEditMonitor = require("../../src/helpers/textEditMonitor");

const darwinOnly = { skip: process.platform !== "darwin" };

const app = (pid) => ({ pid, bundleId: `com.example.app${pid}`, name: `App ${pid}` });

function stubFrontmostApp(monitor, pid) {
  let invocations = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = () => resolve(app(pid));
  });
  monitor._readFrontmostApp = () => {
    invocations += 1;
    return gate;
  };
  return { release, count: () => invocations };
}

test("concurrent captures share one frontmost lookup", darwinOnly, async () => {
  const m = new TextEditMonitor();
  const lookup = stubFrontmostApp(m, 4242);

  const first = m.captureTargetPid();
  const second = m.captureTargetPid();
  lookup.release();

  assert.deepEqual(await Promise.all([first, second]), [4242, 4242]);
  assert.equal(lookup.count(), 1);
  assert.equal(m.lastTargetPid, 4242);
  assert.deepEqual(m.lastTargetApp, app(4242));
});

test("a just-completed capture is reused instead of respawning osascript", darwinOnly, async () => {
  const m = new TextEditMonitor();
  const lookup = stubFrontmostApp(m, 4242);

  const first = m.captureTargetPid();
  lookup.release();
  await first;

  assert.equal(await m.captureTargetPid(), 4242);
  assert.equal(lookup.count(), 1);
});

test("a failed capture is retried, not reused", darwinOnly, async () => {
  const m = new TextEditMonitor();
  let invocations = 0;
  m._readFrontmostApp = () => {
    invocations += 1;
    return Promise.resolve(invocations === 1 ? null : app(4242));
  };

  assert.equal(await m.captureTargetPid(), null);
  assert.equal(m.lastTargetApp, null);
  assert.equal(await m.captureTargetPid(), 4242);
  assert.equal(invocations, 2);
});

test("captures refresh once the reuse window has passed", darwinOnly, async () => {
  const m = new TextEditMonitor();
  let invocations = 0;
  m._readFrontmostApp = () => {
    invocations += 1;
    return Promise.resolve(invocations === 1 ? app(1111) : app(2222));
  };

  assert.equal(await m.captureTargetPid(), 1111);
  m._lastCaptureAt = Date.now() - 10_000;
  assert.equal(await m.captureTargetPid(), 2222);
  assert.equal(m.lastTargetPid, 2222);
});

test("the target app waits for an in-flight capture", darwinOnly, async () => {
  const m = new TextEditMonitor();
  const lookup = stubFrontmostApp(m, 4242);

  void m.captureTargetPid();
  const pending = m.getTargetApp();
  lookup.release();

  assert.deepEqual(await pending, app(4242));
});

test("the PID reader derives from the app reader", darwinOnly, async () => {
  const m = new TextEditMonitor();
  m._readFrontmostApp = () => Promise.resolve(app(7));
  assert.equal(await m._readFrontmostPid(), 7);
  m._readFrontmostApp = () => Promise.resolve(null);
  assert.equal(await m._readFrontmostPid(), null);
});
