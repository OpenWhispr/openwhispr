const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { parseLayoutLine, WindowsLayoutProbe } = require("../../src/helpers/windowsLayoutProbe");

// Fake --layout-server child. `reply` (optional) is emitted on stdout for each QUERY.
function makeChild(reply) {
  const child = new EventEmitter();
  child.writes = [];
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stdin = Object.assign(new EventEmitter(), {
    write(chunk) {
      child.writes.push(chunk);
      if (reply) setImmediate(() => child.stdout.emit("data", reply));
    },
  });
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

function makeProbe({ reply, platform = "win32", now } = {}) {
  const children = [];
  const spawn = () => {
    const child = makeChild(reply);
    children.push(child);
    return child;
  };
  const probe = new WindowsLayoutProbe({
    spawn,
    resolveBinary: () => "windows-key-listener.exe",
    platform,
    now,
  });
  return { probe, children };
}

test("parseLayoutLine parses success line with spaces in name", () => {
  assert.deepEqual(parseLayoutLine("LAYOUT 00020422 uk Ukrainian (Enhanced)"), {
    ok: true,
    klid: "00020422",
    iso: "uk",
    layoutName: "Ukrainian (Enhanced)",
  });
});

test("parseLayoutLine parses error line", () => {
  assert.deepEqual(parseLayoutLine("LAYOUT_ERROR no-foreground-window"), {
    ok: false,
    reason: "no-foreground-window",
  });
});

test("parseLayoutLine ignores READY and junk", () => {
  assert.equal(parseLayoutLine("READY"), null);
  assert.equal(parseLayoutLine("KEY_DOWN"), null);
});

test("capture writes QUERY and getLastCapture resolves with the reply", async () => {
  const { probe, children } = makeProbe({ reply: "LAYOUT 00000419 ru Russian\r\n" });
  probe.capture();
  assert.deepEqual(children[0].writes, ["QUERY\n"]);
  assert.deepEqual(await probe.getLastCapture(), {
    ok: true,
    klid: "00000419",
    iso: "ru",
    layoutName: "Russian",
  });
  probe.stop();
});

test("getLastCapture resolves { ok:false, reason:'timeout' } within 300ms when no reply", async () => {
  const { probe } = makeProbe();
  const started = Date.now();
  probe.capture();
  assert.deepEqual(await probe.getLastCapture(), { ok: false, reason: "timeout" });
  assert.ok(Date.now() - started < 600, "must not hang");
  probe.stop();
});

test("child exit before reply resolves { ok:false, reason:'helper-exited' }", async () => {
  const { probe, children } = makeProbe();
  probe.capture();
  children[0].emit("exit", 1);
  assert.deepEqual(await probe.getLastCapture(), { ok: false, reason: "helper-exited" });
});

test("getLastCapture before any capture resolves { ok:false, reason:'not-captured' }", async () => {
  const { probe } = makeProbe();
  assert.deepEqual(await probe.getLastCapture(), { ok: false, reason: "not-captured" });
});

test("on non-win32 capture is a no-op and resolves { ok:false, reason:'unsupported-platform' }", async () => {
  const { probe, children } = makeProbe({ platform: "linux" });
  probe.capture();
  assert.equal(children.length, 0);
  assert.deepEqual(await probe.getLastCapture(), { ok: false, reason: "unsupported-platform" });
});

test("replies match captures in FIFO order across consecutive captures", async () => {
  const { probe, children } = makeProbe();
  probe.capture();
  const first = probe.getLastCapture();
  probe.capture();
  const second = probe.getLastCapture();
  children[0].stdout.emit("data", "LAYOUT 00000409 en US\nLAYOUT 00000419 ru Russian\n");
  assert.equal((await first).iso, "en");
  assert.equal((await second).iso, "ru");
  probe.stop();
});

test("a late reply to a timed-out query does not answer the next capture", async () => {
  const { probe, children } = makeProbe();
  probe.capture();
  assert.equal((await probe.getLastCapture()).reason, "timeout");
  probe.capture();
  const second = probe.getLastCapture();
  children[0].stdout.emit("data", "LAYOUT 00000409 en US\n"); // late answer to query #1
  children[0].stdout.emit("data", "LAYOUT 00000419 ru Russian\n"); // answer to query #2
  assert.equal((await second).iso, "ru");
  probe.stop();
});

test("a dead helper is respawned at most once per 5s", async () => {
  let clock = 1000;
  const { probe, children } = makeProbe({ now: () => clock });
  probe.capture();
  children[0].emit("exit", 1);
  clock += 1000;
  probe.capture();
  assert.equal(children.length, 1, "no respawn inside the 5s window");
  assert.equal((await probe.getLastCapture()).ok, false);
  clock += 5000;
  probe.capture();
  assert.equal(children.length, 2, "respawn after the window");
  probe.stop();
});
