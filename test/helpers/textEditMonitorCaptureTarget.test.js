const test = require("node:test");
const assert = require("node:assert/strict");

const TextEditMonitor = require("../../src/helpers/textEditMonitor");

const darwinOnly = { skip: process.platform !== "darwin" };

function stubFrontmostPid(monitor, pid) {
  let invocations = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = () => resolve(pid);
  });
  monitor._readFrontmostPid = () => {
    invocations += 1;
    return gate;
  };
  return { release, count: () => invocations };
}

test("concurrent captures share one frontmost lookup", darwinOnly, async () => {
  const m = new TextEditMonitor();
  const lookup = stubFrontmostPid(m, 4242);

  const first = m.captureTargetPid();
  const second = m.captureTargetPid();
  lookup.release();

  assert.deepEqual(await Promise.all([first, second]), [4242, 4242]);
  assert.equal(lookup.count(), 1);
  assert.equal(m.lastTargetPid, 4242);
});

test("a just-completed capture is reused instead of respawning osascript", darwinOnly, async () => {
  const m = new TextEditMonitor();
  const lookup = stubFrontmostPid(m, 4242);

  const first = m.captureTargetPid();
  lookup.release();
  await first;

  assert.equal(await m.captureTargetPid(), 4242);
  assert.equal(lookup.count(), 1);
});

test("a failed capture is retried, not reused", darwinOnly, async () => {
  const m = new TextEditMonitor();
  let invocations = 0;
  m._readFrontmostPid = () => {
    invocations += 1;
    return Promise.resolve(invocations === 1 ? null : 4242);
  };

  assert.equal(await m.captureTargetPid(), null);
  assert.equal(await m.captureTargetPid(), 4242);
  assert.equal(invocations, 2);
});

test("captures refresh once the reuse window has passed", darwinOnly, async () => {
  const m = new TextEditMonitor();
  let invocations = 0;
  m._readFrontmostPid = () => {
    invocations += 1;
    return Promise.resolve(invocations === 1 ? 1111 : 2222);
  };

  assert.equal(await m.captureTargetPid(), 1111);
  m._lastCaptureAt = Date.now() - 10_000;
  assert.equal(await m.captureTargetPid(), 2222);
  assert.equal(m.lastTargetPid, 2222);
});
