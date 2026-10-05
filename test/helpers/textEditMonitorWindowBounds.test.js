const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TextEditMonitor = require("../../src/helpers/textEditMonitor");

// The panel reposition and the screen-context capture both need to know which
// display the dictation target is on. A stub binary stands in for the real
// window-server read so the parsing, the fallback, and the cache are covered.
function withStubBinary(t, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-window-bounds-"));
  const binary = path.join(dir, "macos-text-monitor");
  fs.writeFileSync(binary, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const monitor = new TextEditMonitor();
  monitor.resolveBinary = () => ({ command: binary, args: [] });
  return monitor;
}

const darwinOnly = { skip: process.platform !== "darwin" };

test("a reported window rect is parsed", darwinOnly, async (t) => {
  const monitor = withStubBinary(t, 'echo "BOUNDS:-451,-1440,2560,1440"');

  assert.deepEqual(await monitor.getTargetWindowBounds(42), {
    x: -451,
    y: -1440,
    width: 2560,
    height: 1440,
  });
});

test("an app with no ordinary window resolves to null", darwinOnly, async (t) => {
  const monitor = withStubBinary(t, 'echo "NO_WINDOW"; exit 1');

  assert.equal(await monitor.getTargetWindowBounds(42), null);
});

test("a failing read resolves to null rather than throwing", darwinOnly, async (t) => {
  const monitor = withStubBinary(t, "exit 3");

  assert.equal(await monitor.getTargetWindowBounds(42), null);
});

// The panel and the screenshot both ask at press time; one spawn should serve
// both. A later dictation must still get a fresh read.
test("reads are cached per pid for one press, then re-read", darwinOnly, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-window-bounds-count-"));
  const counter = path.join(dir, "count");
  const binary = path.join(dir, "macos-text-monitor");
  fs.writeFileSync(
    binary,
    `#!/bin/sh\nprintf x >> ${counter}\necho "BOUNDS:0,33,1512,949"\n`,
    { mode: 0o755 }
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const monitor = new TextEditMonitor();
  monitor.resolveBinary = () => ({ command: binary, args: [] });

  await monitor.getTargetWindowBounds(42);
  await monitor.getTargetWindowBounds(42);
  assert.equal(fs.readFileSync(counter, "utf8").length, 1, "second read must hit the cache");

  // A different target is never served from another app's cached rect.
  await monitor.getTargetWindowBounds(43);
  assert.equal(fs.readFileSync(counter, "utf8").length, 2);

  monitor._windowBounds.at -= 1000;
  await monitor.getTargetWindowBounds(43);
  assert.equal(fs.readFileSync(counter, "utf8").length, 3, "a stale entry must be re-read");
});

test("no target pid means no spawn at all", darwinOnly, async (t) => {
  const monitor = withStubBinary(t, 'echo "BOUNDS:0,0,100,100"');

  assert.equal(await monitor.getTargetWindowBounds(null), null);
  assert.equal(await monitor.getTargetWindowBounds(0), null);
});
