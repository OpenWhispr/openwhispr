const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

function loadInputRegion(t, { binary = "/app/linux-fast-paste", windowId = 0xfedcba98 } = {}) {
  const app = new EventEmitter();
  const win = new EventEmitter();
  win.getNativeWindowHandle = () => {
    const handle = Buffer.alloc(8);
    handle.writeUInt32LE(windowId);
    return handle;
  };
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  const killSignals = [];
  // Keep close under test control: requesting SIGKILL is not proof that the
  // old helper has stopped writing native input regions.
  child.kill = (signal) => {
    killSignals.push(signal);
    return true;
  };
  const writes = [];
  child.stdin.on("data", (chunk) => writes.push(chunk.toString()));
  const spawns = [];
  const warnings = [];
  const originalLoad = Module._load;
  const modulePath = require.resolve("../../src/helpers/linuxWindowInputRegion");
  const cachedModule = require.cache[modulePath];
  delete require.cache[modulePath];
  Module._load = function loadWithInputRegionDependencies(request, parent, isMain) {
    if (request === "electron") return { app };
    if (request === "./binaryResolver") return { resolveBundledBinary: () => binary };
    if (request === "./debugLogger") return { warn: (...args) => warnings.push(args) };
    if (request === "child_process") {
      return {
        spawn: (...args) => {
          spawns.push(args);
          return child;
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  let createLinuxWindowInputRegion;
  try {
    ({ createLinuxWindowInputRegion } = require(modulePath));
  } finally {
    Module._load = originalLoad;
    if (cachedModule) require.cache[modulePath] = cachedModule;
    else delete require.cache[modulePath];
  }
  const writer = createLinuxWindowInputRegion(win);
  t.after(() => {
    writer.stop();
    child.emit("close", 0);
    child.stdin.destroy();
    child.stdout.destroy();
  });
  return { writer, child, app, win, writes, spawns, warnings, killSignals };
}

function trackSettlement(promise) {
  const result = { state: "pending" };
  void promise.then(
    () => {
      result.state = "fulfilled";
    },
    () => {
      result.state = "rejected";
    }
  );
  return result;
}

const REGION = { x: 104, y: 60, width: 84, height: 40, viewportWidth: 208, viewportHeight: 120 };

test("the helper starts lazily with the old-binary safeguard and waits for native acknowledgement", async (t) => {
  const { writer, child, writes, spawns } = loadInputRegion(t);
  assert.deepEqual(spawns, []);
  const applied = writer.set(REGION);
  const result = trackSettlement(applied);
  assert.deepEqual(writes, ["208 120 104 60 84 40\n"]);
  // An older helper recognizes --capabilities and exits instead of falling
  // through to its default paste action on the new, unrecognized server flag.
  assert.deepEqual(spawns, [
    [
      "/app/linux-fast-paste",
      ["--capabilities", "--input-region-server", "--window", "4275878552"],
      { stdio: ["pipe", "pipe", "ignore"] },
    ],
  ]);
  await Promise.resolve();
  assert.equal(result.state, "pending");
  child.stdout.write("OK\n");
  await applied;
});

test("overlapping narrow, full and narrow updates retain FIFO acknowledgement order", async (t) => {
  const { writer, child, writes, spawns } = loadInputRegion(t);
  const applied = [writer.set(REGION), writer.set(null), writer.set({ ...REGION, x: 12 })];
  const results = applied.map(trackSettlement);
  assert.deepEqual(writes, ["208 120 104 60 84 40\n", "full\n", "208 120 12 60 84 40\n"]);
  child.stdout.write("OK\n");
  await applied[0];
  assert.deepEqual(
    results.map((result) => result.state),
    ["fulfilled", "pending", "pending"]
  );
  child.stdout.write("OK\n");
  await applied[1];
  assert.deepEqual(
    results.map((result) => result.state),
    ["fulfilled", "fulfilled", "pending"]
  );
  child.stdout.write("OK\n");
  await Promise.all(applied);
  assert.equal(spawns.length, 1);
});

test("fragmented and combined acknowledgement chunks settle each queued update once", async (t) => {
  const { writer, child } = loadInputRegion(t);
  const applied = [writer.set(REGION), writer.set(null)];
  const results = applied.map(trackSettlement);
  child.stdout.write("O");
  await Promise.resolve();
  assert.deepEqual(
    results.map((result) => result.state),
    ["pending", "pending"]
  );
  child.stdout.write("K\nOK\n");
  await Promise.all(applied);
  assert.deepEqual(
    results.map((result) => result.state),
    ["fulfilled", "fulfilled"]
  );
});

test("fractional or clipped coordinates and an empty region are valid", async (t) => {
  const { writer, child, writes } = loadInputRegion(t);
  const applied = writer.set({ ...REGION, x: -12.5, y: 60.25, width: 0, height: 0 });
  assert.deepEqual(writes, ["208 120 -12.5 60.25 0 0\n"]);
  child.stdout.write("OK\n");
  await applied;
});

test("timeout blocks pending and later callers until the old native writer closes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { writer, child, writes, spawns, killSignals, warnings } = loadInputRegion(t);
  const applied = [writer.set(REGION), writer.set(null)];
  const results = applied.map(trackSettlement);
  t.mock.timers.tick(1000);
  const later = writer.set(REGION);
  applied.push(later);
  results.push(trackSettlement(later));
  child.stdout.write("OK\nOK\n");
  await Promise.resolve();
  assert.deepEqual(killSignals, ["SIGKILL"]);
  assert.deepEqual(
    results.map((result) => result.state),
    ["pending", "pending", "pending"]
  );
  assert.equal(writes.length, 2, "failed writers must not receive subsequent region commands");
  child.emit("close", null, "SIGKILL");
  await Promise.all(applied.map((promise) => assert.rejects(promise, /update timed out/)));
  await assert.rejects(writer.set(null), /update timed out/);
  assert.equal(spawns.length, 1);
  assert.equal(warnings.length, 1);
});

test("acknowledged updates clear their timeout and allow later region changes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { writer, child, killSignals } = loadInputRegion(t);
  const applied = writer.set(REGION);
  child.stdout.write("OK\n");
  await applied;
  t.mock.timers.tick(2000);
  assert.deepEqual(killSignals, []);
  const full = writer.set(null);
  child.stdout.write("OK\n");
  await full;
});

for (const stream of ["process", "stdin", "stdout"]) {
  test(`${stream} errors wait for close before rejecting queued updates`, async (t) => {
    const { writer, child, killSignals, app, win } = loadInputRegion(t);
    const applied = [writer.set(REGION), writer.set(null)];
    const results = applied.map(trackSettlement);
    const emitter = stream === "process" ? child : child[stream];
    emitter.emit("error", new Error("broken helper"));
    await Promise.resolve();
    assert.deepEqual(killSignals, ["SIGKILL"]);
    assert.deepEqual(
      results.map((result) => result.state),
      ["pending", "pending"]
    );
    child.emit("close", 1);
    await Promise.all(applied.map((promise) => assert.rejects(promise, /broken helper/)));
    assert.equal(app.listenerCount("before-quit"), 0);
    assert.equal(win.listenerCount("closed"), 0);
  });
}

test("process exit does not reject an update until its streams close", async (t) => {
  const { writer, child, app, win } = loadInputRegion(t);
  const applied = writer.set(REGION);
  const result = trackSettlement(applied);
  child.emit("exit", 1);
  await Promise.resolve();
  assert.equal(result.state, "pending");
  child.emit("close", 1);
  await assert.rejects(applied, /helper exited/);
  assert.equal(app.listenerCount("before-quit"), 0);
  assert.equal(win.listenerCount("closed"), 0);
});

test("a thrown stdin write also waits for process closure before enabling fallback", async (t) => {
  const { writer, child, killSignals } = loadInputRegion(t);
  t.mock.method(child.stdin, "write", () => {
    throw new Error("closed pipe");
  });
  const applied = writer.set(REGION);
  const result = trackSettlement(applied);
  await Promise.resolve();
  assert.equal(result.state, "pending");
  assert.deepEqual(killSignals, ["SIGKILL"]);
  child.emit("close", 1);
  await assert.rejects(applied, /closed pipe/);
});

for (const [name, options, message] of [
  ["missing binary", { binary: null }, /helper not found/],
  ["zero X11 window handle", { windowId: 0 }, /X11 window handle unavailable/],
]) {
  test(`${name} rejects without waiting for a nonexistent subprocess`, async (t) => {
    const { writer, spawns, writes, app, win } = loadInputRegion(t, options);
    await assert.rejects(writer.set(REGION), message);
    assert.deepEqual(spawns, []);
    assert.deepEqual(writes, []);
    assert.equal(app.listenerCount("before-quit"), 0);
    assert.equal(win.listenerCount("closed"), 0);
  });
}

for (const [name, response] of [
  ["old helper capabilities", "paste-v1 selection-copy-v1 target-window-v1\n"],
  ["unexpected acknowledgement", "ERROR\n"],
  ["oversized unterminated output", "x".repeat(1025)],
]) {
  test(`${name} stops the helper and waits for close`, async (t) => {
    const { writer, child, killSignals } = loadInputRegion(t);
    const applied = writer.set(REGION);
    const result = trackSettlement(applied);
    child.stdout.write(response);
    await Promise.resolve();
    assert.equal(result.state, "pending");
    assert.deepEqual(killSignals, ["SIGKILL"]);
    child.emit("close", 0);
    await assert.rejects(applied, /Invalid input region response/);
  });
}

for (const [name, region] of [
  ["missing region", undefined],
  ["missing coordinates", {}],
  ["string coordinate", { ...REGION, x: "104" }],
  ["infinite coordinate", { ...REGION, y: Infinity }],
  ["zero viewport width", { ...REGION, viewportWidth: 0 }],
  ["NaN viewport height", { ...REGION, viewportHeight: NaN }],
  ["negative width", { ...REGION, width: -1 }],
  ["negative height", { ...REGION, height: -1 }],
]) {
  test(`${name} never reaches native stdin`, async (t) => {
    const { writer, spawns, writes } = loadInputRegion(t);
    await assert.rejects(writer.set(region), /Invalid input region/);
    assert.deepEqual(spawns, []);
    assert.deepEqual(writes, []);
  });
}

test("an invalid payload waits for an existing native writer to close before rejection", async (t) => {
  const { writer, child, writes, killSignals } = loadInputRegion(t);
  const applied = writer.set(REGION);
  const invalid = writer.set({ ...REGION, width: -1 });
  const results = [applied, invalid].map(trackSettlement);
  await Promise.resolve();
  assert.deepEqual(
    results.map((result) => result.state),
    ["pending", "pending"]
  );
  assert.deepEqual(killSignals, ["SIGKILL"]);
  assert.deepEqual(writes, ["208 120 104 60 84 40\n"]);
  child.emit("close", null, "SIGKILL");
  await assert.rejects(applied, /Invalid input region/);
  await assert.rejects(invalid, /Invalid input region/);
});

for (const event of ["closed", "before-quit"]) {
  test(`${event} terminates the helper once and settles pending work after close`, async (t) => {
    const { writer, child, app, win, killSignals, warnings } = loadInputRegion(t);
    const applied = writer.set(REGION);
    const result = trackSettlement(applied);
    const owner = event === "closed" ? win : app;
    owner.emit(event);
    owner.emit(event);
    writer.stop();
    await Promise.resolve();
    assert.equal(result.state, "pending");
    assert.deepEqual(killSignals, ["SIGKILL"]);
    child.emit("close", 0);
    await assert.rejects(applied, /Input region writer stopped/);
    await assert.rejects(writer.set(null), /Input region writer stopped/);
    assert.deepEqual(warnings, []);
    assert.equal(app.listenerCount("before-quit"), 0);
    assert.equal(win.listenerCount("closed"), 0);
  });
}

test("stopping an unused writer prevents subsequent native spawning", async (t) => {
  const { writer, app, win, spawns } = loadInputRegion(t);
  writer.stop();
  await assert.rejects(writer.set(REGION), /Input region writer stopped/);
  assert.deepEqual(spawns, []);
  assert.equal(app.listenerCount("before-quit"), 0);
  assert.equal(win.listenerCount("closed"), 0);
});
