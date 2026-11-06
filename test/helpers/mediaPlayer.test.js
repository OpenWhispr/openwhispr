const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const childProcess = require("node:child_process");
const fs = require("node:fs");

const modulePath = require.resolve("../../src/helpers/mediaPlayer");
// Re-load this too so Windows timeout cleanup uses each test's spawn stub.
const processUtilPath = require.resolve("../../src/utils/process");
const originalLoad = Module._load;
const originalPlatform = process.platform;

function setPlatform(platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

test.afterEach(() => {
  setPlatform(originalPlatform);
  Module._load = originalLoad;
});

// Controllable child for missing executables, late closes, and inherited-pipe timeouts.
function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdoutDestroyed = false;
  child.stderrDestroyed = false;
  child.stdout.destroy = () => {
    child.stdoutDestroyed = true;
  };
  child.stderr.destroy = () => {
    child.stderrDestroyed = true;
  };
  child.exitCode = null;
  child.pid = 4242;
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    return true;
  };
  child.fail = (err) => {
    child.emit("error", err);
    child.emit("close", -2);
  };
  child.finish = (status, stdout = "", stderr = "") => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", status);
  };
  // Models a child that exited while a descendant still holds its pipes open.
  child.exitLeavingPipesOpen = (status, stdout = "") => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    child.exitCode = status;
    child.emit("exit", status, null);
  };
  return child;
}

function createFakeBus() {
  const connection = new EventEmitter();
  connection.stream = new EventEmitter();
  connection.endCount = 0;
  connection.end = () => {
    connection.endCount += 1;
  };
  const calls = [];
  return {
    connection,
    calls,
    invoke(message, callback) {
      calls.push({
        message: { ...message, body: message.body ? [...message.body] : undefined },
        respond: (...values) => callback(null, ...values),
        fail: (name, message) => callback({ name, message, body: [message] }),
      });
    },
  };
}

// Load a fresh singleton per platform; sync child-process APIs throw to guard #2073.
function loadMediaPlayer(
  platform,
  {
    existingPaths = () => false,
    warnThrows = false,
    dbusLoadError = null,
    createBus = createFakeBus,
  } = {}
) {
  delete require.cache[modulePath];
  delete require.cache[processUtilPath];
  setPlatform(platform);
  const calls = [];
  const buses = [];
  const logs = [];
  const spawn = (cmd, args, options) => {
    const child = createFakeChild();
    calls.push({ cmd: path.basename(cmd), args, options, child });
    return child;
  };
  const syncSpawn = () => {
    throw new Error(
      "no synchronous child-process call may run on the media pause/resume path (#2073)"
    );
  };
  const mockedRequesters = new Set([modulePath, processUtilPath]);
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (!mockedRequesters.has(parent?.filename)) {
      return originalLoad.call(this, request, parent, isMain);
    }
    const builtin = request.startsWith("node:") ? request.slice(5) : request;
    if (request === "./debugLogger") {
      return {
        debug: (message, meta) => logs.push({ level: "debug", message, meta }),
        info() {},
        warn: (message, meta) => {
          logs.push({ level: "warn", message, meta });
          if (warnThrows) throw new Error("log stream is broken");
        },
        error() {},
      };
    }
    if (request === "@homebridge/dbus-native") {
      if (dbusLoadError) throw dbusLoadError;
      return {
        sessionBus: () => {
          const bus = createBus();
          buses.push(bus);
          return bus;
        },
      };
    }
    if (builtin === "child_process") {
      return {
        ...childProcess,
        spawn,
        spawnSync: syncSpawn,
        execSync: syncSpawn,
        execFileSync: syncSpawn,
      };
    }
    if (builtin === "fs") {
      // Pin binary discovery so host downloads cannot change fallback selection.
      return {
        ...fs,
        existsSync: (p) => existingPaths(String(p)),
        accessSync: (p, ...args) =>
          existingPaths(String(p)) ? undefined : fs.accessSync(p, ...args),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  return { mediaPlayer: require(modulePath), calls, buses, logs };
}

async function drain() {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitForCall(calls, index) {
  for (let i = 0; i < 50 && calls.length <= index; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(calls.length > index, `expected spawn call #${index + 1}, saw ${calls.length}`);
  return calls[index];
}

async function waitForBus(buses, index = 0) {
  for (let i = 0; i < 50 && buses.length <= index; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(buses.length > index, `expected D-Bus connection #${index + 1}, saw ${buses.length}`);
  return buses[index];
}

async function waitForDbusCall(bus, predicate, description, occurrence = 0) {
  for (let i = 0; i < 50; i += 1) {
    const matches = bus.calls.filter(predicate);
    if (matches.length > occurrence) return matches[occurrence];
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`expected ${description}, saw ${bus.calls.length} D-Bus calls`);
}

const dbusMember = (member) => (call) => call.message.member === member;
const dbusCall = (member, destination) => (call) =>
  call.message.member === member && call.message.destination === destination;
const statusVariant = (status, signature = "s") => [[{ type: signature }], [status]];
const MPRIS_PLAYER_PATH = "/org/mpris/MediaPlayer2";
const MPRIS_PLAYER_INTERFACE = "org.mpris.MediaPlayer2.Player";
const WIN_STDIO = ["ignore", "pipe", "pipe"];

function seedMediaSession(mediaPlayer, id, pausedPlayers = []) {
  mediaPlayer._mediaSessions.set(id, {
    active: true,
    restore: true,
    pausedPlayers: [...pausedPlayers],
  });
}

const pausedPlayersFor = (mediaPlayer, id) =>
  mediaPlayer._mediaSessions.get(id)?.pausedPlayers ?? [];

test("win32: GSMTC pause runs asynchronously and records acknowledged apps", async () => {
  const { mediaPlayer, calls } = loadMediaPlayer("win32");
  const pausing = mediaPlayer.pauseMedia();
  const gsmtc = await waitForCall(calls, 0);
  assert.equal(gsmtc.cmd, "powershell.exe");
  assert.deepEqual(gsmtc.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(gsmtc.args[3], /TryPauseAsync/);
  assert.deepEqual(gsmtc.options.stdio, WIN_STDIO);
  assert.equal(gsmtc.options.windowsHide, true);
  gsmtc.child.finish(0, "Spotify.exe|Chrome.exe\n");
  assert.equal(await pausing, true);
  assert.deepEqual(mediaPlayer._pausedWinApps, ["Spotify.exe", "Chrome.exe"]);
});

test("win32: GSMTC failure falls through nircmd then PowerShell media key", async () => {
  const { mediaPlayer, calls } = loadMediaPlayer("win32", {
    existingPaths: (p) => /nircmd\.exe$/.test(p),
  });
  const pausing = mediaPlayer.pauseMedia();
  (await waitForCall(calls, 0)).child.finish(1, "", "boom");
  const nircmd = await waitForCall(calls, 1);
  assert.equal(nircmd.cmd, "nircmd.exe");
  assert.deepEqual(nircmd.args, ["sendkeypress", "0xB3"]);
  nircmd.child.finish(1);
  const powershell = await waitForCall(calls, 2);
  assert.match(powershell.args[3], /keybd_event/);
  powershell.child.finish(0);
  assert.equal(await pausing, true);
  assert.equal(mediaPlayer._didPause, true);
});

test("win32: missing PowerShell fails closed instead of blocking", async () => {
  const { mediaPlayer, calls } = loadMediaPlayer("win32");
  const pausing = mediaPlayer.pauseMedia();
  const enoent = new Error("spawn powershell.exe ENOENT");
  (await waitForCall(calls, 0)).child.fail(enoent);
  (await waitForCall(calls, 1)).child.fail(enoent);
  assert.equal(await pausing, false);
  assert.equal(mediaPlayer._didPause, false);
});

test("win32: GSMTC_FAIL falls back to the PowerShell media key when nircmd is absent", async () => {
  const { mediaPlayer, calls } = loadMediaPlayer("win32");
  const pausing = mediaPlayer.pauseMedia();
  (await waitForCall(calls, 0)).child.finish(0, "GSMTC_FAIL\n");
  const fallback = await waitForCall(calls, 1);
  assert.equal(fallback.cmd, "powershell.exe");
  assert.match(fallback.args[3], /keybd_event/);
  fallback.child.finish(0);
  assert.equal(await pausing, true);
  assert.equal(mediaPlayer._didPause, true);
});

test("win32: bundled nircmd succeeds before the PowerShell media key", async () => {
  const { mediaPlayer, calls } = loadMediaPlayer("win32", {
    existingPaths: (p) => /nircmd\.exe$/.test(p),
  });
  const pausing = mediaPlayer.pauseMedia();
  (await waitForCall(calls, 0)).child.finish(1);
  const nircmd = await waitForCall(calls, 1);
  assert.equal(nircmd.cmd, "nircmd.exe");
  nircmd.child.finish(0);
  assert.equal(await pausing, true);
  assert.equal(calls.length, 2);
});

test("win32: resume without a prior pause spawns nothing", async () => {
  const { mediaPlayer, calls } = loadMediaPlayer("win32");
  assert.equal(await mediaPlayer.resumeMedia(), false);
  assert.equal(calls.length, 0);
});

test("win32: resume after a media-key pause toggles the media key again", async () => {
  const { mediaPlayer, calls } = loadMediaPlayer("win32");
  const pausing = mediaPlayer.pauseMedia();
  (await waitForCall(calls, 0)).child.finish(0, "GSMTC_FAIL\n");
  (await waitForCall(calls, 1)).child.finish(0);
  assert.equal(await pausing, true);
  const resuming = mediaPlayer.resumeMedia();
  (await waitForCall(calls, 2)).child.finish(0);
  assert.equal(await resuming, true);
  assert.equal(mediaPlayer._didPause, false);
});

test("win32: a stuck helper is killed with descendants and its pipes are destroyed", async (t) => {
  // wait helpers use setImmediate, so only the helper deadline is mocked.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { mediaPlayer, calls, logs } = loadMediaPlayer("win32");
  const pausing = mediaPlayer.pauseMedia();
  const gsmtc = await waitForCall(calls, 0);
  t.mock.timers.tick(5000);
  const taskkill = await waitForCall(calls, 1);
  assert.equal(taskkill.cmd, "taskkill");
  assert.deepEqual(taskkill.args, ["/pid", "4242", "/f", "/t"]);
  assert.equal(gsmtc.child.stdoutDestroyed, true);
  assert.equal(gsmtc.child.stderrDestroyed, true);
  assert.ok(logs.some((entry) => entry.message === "Media helper timed out"));
  const fallback = await waitForCall(calls, 2);
  fallback.child.finish(0);
  assert.equal(await pausing, true);
  gsmtc.child.finish(0, "Spotify.exe\n");
  assert.deepEqual(mediaPlayer._pausedWinApps, []);
});

// Preserve an exit code already known before inherited pipes hit the deadline (#2073).
test("win32: an exited helper with inherited open pipes keeps its real result", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { mediaPlayer, calls } = loadMediaPlayer("win32");
  const pausing = mediaPlayer.pauseMedia();
  const gsmtc = await waitForCall(calls, 0);
  gsmtc.child.exitLeavingPipesOpen(0, "Spotify.exe\n");
  t.mock.timers.tick(5000);
  await drain();
  assert.equal(calls.length, 1);
  assert.equal(await pausing, true);
  assert.deepEqual(mediaPlayer._pausedWinApps, ["Spotify.exe"]);
});

test("win32: helper output remains bounded", async () => {
  const { mediaPlayer, calls } = loadMediaPlayer("win32");
  const pausing = mediaPlayer.pauseMedia();
  const gsmtc = await waitForCall(calls, 0);
  const chunk = "A".repeat(512 * 1024);
  for (let i = 0; i < 4; i += 1) gsmtc.child.stdout.emit("data", Buffer.from(chunk));
  gsmtc.child.finish(0);
  assert.equal(await pausing, true);
  const buffered = mediaPlayer._pausedWinApps.join("").length;
  assert.ok(buffered > 0 && buffered <= 1024 * 1024 + chunk.length);
});

test("win32: timeout logging failure still leaves the queue usable", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { mediaPlayer, calls } = loadMediaPlayer("win32", { warnThrows: true });
  const pausing = mediaPlayer.pauseMedia();
  await waitForCall(calls, 0);
  t.mock.timers.tick(5000);
  (await waitForCall(calls, 2)).child.finish(0);
  assert.equal(await pausing, true);
  const resuming = mediaPlayer.resumeMedia();
  (await waitForCall(calls, 3)).child.finish(0);
  assert.equal(await resuming, true);
});

// A quick stop must queue resume behind incomplete pause bookkeeping (#2073).
test("win32: queued resume waits for pause bookkeeping", async () => {
  const { mediaPlayer, calls } = loadMediaPlayer("win32");
  const pausing = mediaPlayer.pauseMedia();
  const resuming = mediaPlayer.resumeMedia();
  const pause = await waitForCall(calls, 0);
  await drain();
  assert.equal(calls.length, 1);
  pause.child.finish(0, "Spotify.exe\n");
  assert.equal(await pausing, true);
  const play = await waitForCall(calls, 1);
  assert.match(play.args[3], /TryPlayAsync/);
  assert.match(play.args[3], /'Spotify\.exe'/);
  play.child.finish(0, "OK\n");
  assert.equal(await resuming, true);
});

test("win32: toggle sends the media key asynchronously", async () => {
  const { mediaPlayer, calls } = loadMediaPlayer("win32");
  const toggling = mediaPlayer.toggleMedia();
  const key = await waitForCall(calls, 0);
  assert.match(key.args[3], /keybd_event/);
  key.child.finish(0);
  assert.equal(await toggling, true);
});

const MAC_ADAPTER_PATHS = (p) =>
  p === "/usr/bin/perl" ||
  p.endsWith("mediaremote-adapter.pl") ||
  p.endsWith("MediaRemoteAdapter.framework");

test("darwin: queued resume waits for adapter pause bookkeeping", async () => {
  const { mediaPlayer, calls } = loadMediaPlayer("darwin", { existingPaths: MAC_ADAPTER_PATHS });
  const pausing = mediaPlayer.pauseMedia();
  const resuming = mediaPlayer.resumeMedia();
  (await waitForCall(calls, 0)).child.finish(0, '{"playing":true}');
  const pause = await waitForCall(calls, 1);
  assert.deepEqual(pause.args.slice(-2), ["send", "1"]);
  await drain();
  assert.equal(calls.length, 2);
  pause.child.finish(0);
  assert.equal(await pausing, true);
  const play = await waitForCall(calls, 2);
  assert.deepEqual(play.args.slice(-2), ["send", "0"]);
  play.child.finish(0);
  assert.equal(await resuming, true);
});

test("linux: one lazy bus is reused and a slow owner does not delay a healthy Pause", async () => {
  const { mediaPlayer, calls, buses, logs } = loadMediaPlayer("linux");
  assert.equal(buses.length, 0, "importing the helper must not connect");

  const sessionId = "slow-and-healthy";
  let pauseSettled = false;
  const pausing = mediaPlayer.pauseMedia(sessionId).then((result) => {
    pauseSettled = true;
    return result;
  });
  const bus = await waitForBus(buses);
  const list = await waitForDbusCall(bus, dbusMember("ListNames"), "ListNames");
  assert.deepEqual(list.message, {
    destination: "org.freedesktop.DBus",
    path: "/org/freedesktop/DBus",
    interface: "org.freedesktop.DBus",
    member: "ListNames",
    body: undefined,
  });
  list.respond([
    "org.freedesktop.DBus",
    "org.mpris.MediaPlayer2.slow",
    "org.mpris.MediaPlayer2.healthy",
  ]);

  const slowOwner = await waitForDbusCall(
    bus,
    (call) => call.message.member === "GetNameOwner" && call.message.body?.[0].endsWith("slow"),
    "slow GetNameOwner"
  );
  const healthyOwner = await waitForDbusCall(
    bus,
    (call) => call.message.member === "GetNameOwner" && call.message.body?.[0].endsWith("healthy"),
    "healthy GetNameOwner"
  );
  assert.deepEqual(healthyOwner.message, {
    destination: "org.freedesktop.DBus",
    path: "/org/freedesktop/DBus",
    interface: "org.freedesktop.DBus",
    member: "GetNameOwner",
    signature: "s",
    body: ["org.mpris.MediaPlayer2.healthy"],
  });
  slowOwner.respond(":1.20");
  healthyOwner.respond(":1.21");

  const slowStatus = await waitForDbusCall(bus, dbusCall("Get", ":1.20"), "slow status");
  const healthyStatus = await waitForDbusCall(bus, dbusCall("Get", ":1.21"), "healthy status");
  assert.deepEqual(healthyStatus.message, {
    destination: ":1.21",
    path: MPRIS_PLAYER_PATH,
    interface: "org.freedesktop.DBus.Properties",
    member: "Get",
    signature: "ss",
    body: [MPRIS_PLAYER_INTERFACE, "PlaybackStatus"],
  });
  healthyStatus.respond(statusVariant("Playing"));

  const pause = await waitForDbusCall(bus, dbusCall("Pause", ":1.21"), "healthy Pause");
  assert.deepEqual(pause.message, {
    destination: ":1.21",
    path: MPRIS_PLAYER_PATH,
    interface: MPRIS_PLAYER_INTERFACE,
    member: "Pause",
    body: undefined,
  });
  assert.ok(logs.some((entry) => entry.message === "MPRIS Pause dispatched"));
  assert.equal(
    logs.some((entry) => entry.message === "MPRIS Pause acknowledged"),
    false
  );
  pause.respond();

  const resuming = mediaPlayer.resumeMedia(sessionId);
  await drain();
  assert.equal(pauseSettled, false);
  assert.equal(bus.calls.some(dbusMember("Play")), false);
  slowStatus.respond(statusVariant("Paused"));
  assert.equal(await pausing, true);

  const play = await waitForDbusCall(bus, dbusCall("Play", ":1.21"), "targeted Play");
  assert.deepEqual(play.message, {
    destination: ":1.21",
    path: MPRIS_PLAYER_PATH,
    interface: MPRIS_PLAYER_INTERFACE,
    member: "Play",
    body: undefined,
  });
  play.respond();
  assert.equal(await resuming, true);
  assert.equal(buses.length, 1, "pause and resume reuse the media-owned bus");
  assert.equal(mediaPlayer._mediaSessions.has(sessionId), false);

  const nextSessionId = "next";
  const nextPause = mediaPlayer.pauseMedia(nextSessionId);
  (await waitForDbusCall(bus, dbusMember("ListNames"), "next ListNames", 1)).respond([
    "org.mpris.MediaPlayer2.next",
  ]);
  const nextOwner = await waitForDbusCall(
    bus,
    (call) => call.message.member === "GetNameOwner" && call.message.body?.[0].endsWith("next"),
    "next owner"
  );
  nextOwner.respond(":1.22");
  (await waitForDbusCall(bus, dbusCall("Get", ":1.22"), "next status")).respond(
    statusVariant("Playing")
  );
  (await waitForDbusCall(bus, dbusCall("Pause", ":1.22"), "next Pause")).respond();
  assert.equal(await nextPause, true);
  assert.deepEqual(pausedPlayersFor(mediaPlayer, nextSessionId), [":1.22"]);
  assert.equal(buses.length, 1, "the next serialized operation still reuses the bus");
  assert.deepEqual(calls, [], "automatic Linux MPRIS never spawns a helper");
});

test("linux: ending before queued pause work starts avoids opening D-Bus", async () => {
  const { mediaPlayer, buses } = loadMediaPlayer("linux");
  const sessionId = "ended-before-start";

  const pausing = mediaPlayer.pauseMedia(sessionId);
  const resuming = mediaPlayer.resumeMedia(sessionId);

  assert.equal(await pausing, false);
  assert.equal(await resuming, false);
  assert.equal(buses.length, 0);
  assert.equal(mediaPlayer._mediaSessions.has(sessionId), false);
});

test("linux: ending during discovery or owner lookup stops that session's chain", async () => {
  for (const stage of ["discovery", "owner"]) {
    const { mediaPlayer, buses } = loadMediaPlayer("linux");
    const sessionId = `quick-stop-${stage}`;
    const pausing = mediaPlayer.pauseMedia(sessionId);
    const bus = await waitForBus(buses);
    const list = await waitForDbusCall(bus, dbusMember("ListNames"), `${stage} ListNames`);

    if (stage === "discovery") {
      const resuming = mediaPlayer.resumeMedia(sessionId);
      list.respond(["org.mpris.MediaPlayer2.slow"]);
      assert.equal(await pausing, false);
      assert.equal(await resuming, false);
      assert.equal(bus.calls.some(dbusMember("GetNameOwner")), false);
    } else {
      list.respond(["org.mpris.MediaPlayer2.slow"]);
      const owner = await waitForDbusCall(bus, dbusMember("GetNameOwner"), "pending owner");
      const resuming = mediaPlayer.resumeMedia(sessionId);
      owner.respond(":1.22");
      assert.equal(await pausing, false);
      assert.equal(await resuming, false);
      assert.equal(bus.calls.some(dbusMember("Get")), false);
    }
    assert.equal(mediaPlayer._mediaSessions.has(sessionId), false);
    mediaPlayer.close();
  }
});

test("linux: ending a session during status lookup suppresses its unsent Pause", async () => {
  const { mediaPlayer, buses } = loadMediaPlayer("linux");
  const sessionId = "quick-stop-before-pause";
  const pausing = mediaPlayer.pauseMedia(sessionId);
  const bus = await waitForBus(buses);
  (await waitForDbusCall(bus, dbusMember("ListNames"), "ListNames")).respond([
    "org.mpris.MediaPlayer2.slow",
  ]);
  (await waitForDbusCall(bus, dbusMember("GetNameOwner"), "GetNameOwner")).respond(":1.23");
  const status = await waitForDbusCall(bus, dbusCall("Get", ":1.23"), "pending status");

  const resuming = mediaPlayer.resumeMedia(sessionId);
  status.respond(statusVariant("Playing"));

  assert.equal(await pausing, false);
  assert.equal(await resuming, false);
  assert.equal(bus.calls.some(dbusMember("Pause")), false);
  assert.equal(bus.calls.some(dbusMember("Play")), false);
  assert.equal(mediaPlayer._mediaSessions.has(sessionId), false);
});

test("linux: ending after Pause dispatch restores only after its acknowledgment", async () => {
  const { mediaPlayer, buses } = loadMediaPlayer("linux");
  const sessionId = "quick-stop-after-dispatch";
  const pausing = mediaPlayer.pauseMedia(sessionId);
  const bus = await waitForBus(buses);
  (await waitForDbusCall(bus, dbusMember("ListNames"), "ListNames")).respond([
    "org.mpris.MediaPlayer2.healthy",
  ]);
  (await waitForDbusCall(bus, dbusMember("GetNameOwner"), "GetNameOwner")).respond(":1.24");
  (await waitForDbusCall(bus, dbusCall("Get", ":1.24"), "status")).respond(
    statusVariant("Playing")
  );
  const pause = await waitForDbusCall(bus, dbusCall("Pause", ":1.24"), "pending Pause");

  const resuming = mediaPlayer.resumeMedia(sessionId);
  pause.respond();
  assert.equal(await pausing, true);
  const play = await waitForDbusCall(bus, dbusCall("Play", ":1.24"), "targeted Play");
  play.respond();

  assert.equal(await resuming, true);
  assert.equal(mediaPlayer._mediaSessions.has(sessionId), false);
});

test("linux: a stale end cannot resume media while a newer recording is active", async () => {
  const { mediaPlayer, buses } = loadMediaPlayer("linux");
  const firstPause = mediaPlayer.pauseMedia("recording-a");
  const bus = await waitForBus(buses);
  (await waitForDbusCall(bus, dbusMember("ListNames"), "A ListNames")).respond([
    "org.mpris.MediaPlayer2.zen",
  ]);
  (await waitForDbusCall(bus, dbusMember("GetNameOwner"), "A owner")).respond(":1.25");
  (await waitForDbusCall(bus, dbusCall("Get", ":1.25"), "A status")).respond(
    statusVariant("Playing")
  );
  (await waitForDbusCall(bus, dbusCall("Pause", ":1.25"), "A Pause")).respond();
  assert.equal(await firstPause, true);

  const secondPause = mediaPlayer.pauseMedia("recording-b");
  const staleResume = mediaPlayer.resumeMedia("recording-a");
  (await waitForDbusCall(bus, dbusMember("ListNames"), "B ListNames", 1)).respond([
    "org.mpris.MediaPlayer2.zen",
  ]);
  const secondOwner = await waitForDbusCall(bus, dbusMember("GetNameOwner"), "B owner", 1);
  secondOwner.respond(":1.25");
  (await waitForDbusCall(bus, dbusCall("Get", ":1.25"), "B status", 1)).respond(
    statusVariant("Paused")
  );

  assert.equal(await secondPause, false);
  assert.equal(await staleResume, false);
  assert.equal(bus.calls.some(dbusMember("Play")), false, "A cannot resume during B");

  const finalResume = mediaPlayer.resumeMedia("recording-b");
  const play = await waitForDbusCall(bus, dbusCall("Play", ":1.25"), "Play after B ends");
  play.respond();
  assert.equal(await finalResume, true);
  assert.equal(await mediaPlayer.resumeMedia("recording-a"), false, "stale ends are one-shot");
});

test("linux: a stuck player does not delay healthy restoration", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { mediaPlayer, buses } = loadMediaPlayer("linux");
  seedMediaSession(mediaPlayer, "recording-a", [":1.27", ":1.28"]);

  const endingA = mediaPlayer.resumeMedia("recording-a");
  const bus = await waitForBus(buses);
  await waitForDbusCall(bus, dbusCall("Play", ":1.27"), "stuck Play");
  const healthyPlay = await waitForDbusCall(bus, dbusCall("Play", ":1.28"), "healthy Play");
  healthyPlay.respond();

  t.mock.timers.tick(2000);
  assert.equal(await endingA, true);
  assert.equal(mediaPlayer._mediaSessions.size, 0);
});

test("linux: ending with restoration disabled also releases a pending timeout recycle", async () => {
  const { mediaPlayer, buses } = loadMediaPlayer("linux");
  const sessionId = "setting-disabled";
  const pausing = mediaPlayer.pauseMedia(sessionId);
  const bus = await waitForBus(buses);
  (await waitForDbusCall(bus, dbusMember("ListNames"), "ListNames")).respond([
    "org.mpris.MediaPlayer2.zen",
  ]);
  (await waitForDbusCall(bus, dbusMember("GetNameOwner"), "owner")).respond(":1.26");
  (await waitForDbusCall(bus, dbusCall("Get", ":1.26"), "status")).respond(
    statusVariant("Playing")
  );
  (await waitForDbusCall(bus, dbusCall("Pause", ":1.26"), "Pause")).respond();
  assert.equal(await pausing, true);

  // An unrelated timed-out call can leave this connection waiting for its saved owners.
  mediaPlayer._mprisRecycleGeneration = mediaPlayer._mprisBus.generation;
  assert.equal(await mediaPlayer.resumeMedia(sessionId, false), false);
  assert.equal(bus.calls.some(dbusMember("Play")), false);
  assert.equal(mediaPlayer._mediaSessions.has(sessionId), false);
  assert.equal(bus.connection.endCount, 1);
});

test("linux: an already paused player is never controlled automatically", async () => {
  const { mediaPlayer, calls, buses } = loadMediaPlayer("linux");
  const sessionId = "already-paused";
  const pausing = mediaPlayer.pauseMedia(sessionId);
  const bus = await waitForBus(buses);
  (await waitForDbusCall(bus, dbusMember("ListNames"), "ListNames")).respond([
    "org.mpris.MediaPlayer2.paused",
  ]);
  (await waitForDbusCall(bus, dbusMember("GetNameOwner"), "paused owner")).respond(":1.23");
  (await waitForDbusCall(bus, dbusCall("Get", ":1.23"), "paused status")).respond(
    statusVariant("Paused")
  );

  assert.equal(await pausing, false);
  assert.equal(await mediaPlayer.resumeMedia(sessionId), false);
  assert.equal(bus.calls.some(dbusMember("Pause")), false);
  assert.equal(bus.calls.some(dbusMember("Play")), false);
  assert.deepEqual(calls, []);
});

test("linux: aliases deduplicate unique owners and malformed owners or variants fail closed", async () => {
  const { mediaPlayer, calls, buses } = loadMediaPlayer("linux");
  const pausing = mediaPlayer.pauseMedia("aliases");
  const bus = await waitForBus(buses);
  (await waitForDbusCall(bus, dbusMember("ListNames"), "ListNames")).respond([
    "org.mpris.MediaPlayer2.alias_one",
    "org.mpris.MediaPlayer2.alias_two",
    "org.mpris.MediaPlayer2.bad_owner",
    "org.mpris.MediaPlayer2.missing",
    "org.mpris.MediaPlayer2.bad_variant",
  ]);

  const owners = await Promise.all(
    ["alias_one", "alias_two", "bad_owner", "missing", "bad_variant"].map((name) =>
      waitForDbusCall(
        bus,
        (call) => call.message.member === "GetNameOwner" && call.message.body?.[0].endsWith(name),
        `${name} owner`
      )
    )
  );
  owners[0].respond(":1.30");
  owners[1].respond(":1.30");
  owners[2].respond("org.mpris.MediaPlayer2.replacement");
  owners[3].fail("org.freedesktop.DBus.Error.NameHasNoOwner", "vanished");
  owners[4].respond(":1.31");

  const aliasStatus = await waitForDbusCall(bus, dbusCall("Get", ":1.30"), "alias status");
  const malformedStatus = await waitForDbusCall(bus, dbusCall("Get", ":1.31"), "malformed status");
  aliasStatus.respond(statusVariant("Playing", "g"));
  malformedStatus.respond([[{ type: "b" }], [true]]);

  assert.equal(await pausing, false);
  assert.equal(bus.calls.filter(dbusCall("Get", ":1.30")).length, 1);
  assert.equal(bus.calls.some(dbusMember("Pause")), false);
  assert.deepEqual(calls, []);
});

test("linux: only acknowledged Pauses are restored once and D-Bus errors stay truthful", async () => {
  const { mediaPlayer, calls, buses, logs } = loadMediaPlayer("linux");
  const sessionId = "acknowledged-only";
  const pausing = mediaPlayer.pauseMedia(sessionId);
  const bus = await waitForBus(buses);
  (await waitForDbusCall(bus, dbusMember("ListNames"), "ListNames")).respond([
    "org.mpris.MediaPlayer2.first",
    "org.mpris.MediaPlayer2.second",
    "org.mpris.MediaPlayer2.failed",
  ]);

  for (const [name, owner] of [
    ["first", ":1.40"],
    ["second", ":1.41"],
    ["failed", ":1.42"],
  ]) {
    const ownerCall = await waitForDbusCall(
      bus,
      (call) => call.message.member === "GetNameOwner" && call.message.body?.[0].endsWith(name),
      `${name} owner`
    );
    ownerCall.respond(owner);
    (await waitForDbusCall(bus, dbusCall("Get", owner), `${name} status`)).respond(
      statusVariant("Playing")
    );
  }

  const firstPause = await waitForDbusCall(bus, dbusCall("Pause", ":1.40"), "first Pause");
  const secondPause = await waitForDbusCall(bus, dbusCall("Pause", ":1.41"), "second Pause");
  const failedPause = await waitForDbusCall(bus, dbusCall("Pause", ":1.42"), "failed Pause");
  firstPause.respond();
  secondPause.respond();
  failedPause.fail("org.freedesktop.DBus.Error.AccessDenied", "denied".repeat(100));
  assert.equal(await pausing, true);
  assert.deepEqual(new Set(pausedPlayersFor(mediaPlayer, sessionId)), new Set([":1.40", ":1.41"]));

  const failure = logs.find(
    (entry) => entry.message === "MPRIS Pause not acknowledged" && entry.meta.owner === ":1.42"
  );
  assert.equal(failure.meta.errorName, "org.freedesktop.DBus.Error.AccessDenied");
  assert.match(failure.meta.error, /^denied/);
  assert.equal(failure.meta.error.length, 200, "D-Bus error logs stay bounded");
  assert.equal(failure.meta.timedOut, false);

  const resuming = mediaPlayer.resumeMedia(sessionId);
  const firstPlay = await waitForDbusCall(bus, dbusMember("Play"), "first Play");
  firstPlay.respond();
  const secondPlay = await waitForDbusCall(bus, dbusMember("Play"), "second Play", 1);
  secondPlay.fail("org.freedesktop.DBus.Error.NameHasNoOwner", "player restarted");
  assert.equal(await resuming, true);
  assert.ok([":1.40", ":1.41"].includes(firstPlay.message.destination));
  assert.ok([":1.40", ":1.41"].includes(secondPlay.message.destination));
  assert.equal(
    bus.calls.some((call) => call.message.destination?.startsWith("org.mpris")),
    false
  );

  const callCount = bus.calls.length;
  assert.equal(await mediaPlayer.resumeMedia(sessionId), false);
  assert.equal(bus.calls.length, callCount, "resume records are consumed before Play");
  assert.deepEqual(calls, []);
});

test("linux: timeout preserves healthy restoration before recycling and ignores late replies", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { mediaPlayer, calls, buses, logs } = loadMediaPlayer("linux");
  const sessionId = "timeout";
  let settled = false;
  const pausing = mediaPlayer.pauseMedia(sessionId).then((result) => {
    settled = true;
    return result;
  });
  const bus = await waitForBus(buses);
  (await waitForDbusCall(bus, dbusMember("ListNames"), "ListNames")).respond([
    "org.mpris.MediaPlayer2.slow",
    "org.mpris.MediaPlayer2.healthy",
  ]);
  const slowOwner = await waitForDbusCall(
    bus,
    (call) => call.message.member === "GetNameOwner" && call.message.body?.[0].endsWith("slow"),
    "slow owner"
  );
  const healthyOwner = await waitForDbusCall(
    bus,
    (call) => call.message.member === "GetNameOwner" && call.message.body?.[0].endsWith("healthy"),
    "healthy owner"
  );
  slowOwner.respond(":1.50");
  healthyOwner.respond(":1.51");
  const slowStatus = await waitForDbusCall(bus, dbusCall("Get", ":1.50"), "slow status");
  const healthyStatus = await waitForDbusCall(bus, dbusCall("Get", ":1.51"), "healthy status");
  slowStatus.respond(statusVariant("Playing"));
  const slowPause = await waitForDbusCall(bus, dbusCall("Pause", ":1.50"), "slow Pause");

  t.mock.timers.tick(500);
  healthyStatus.respond(statusVariant("Playing"));
  const healthyPause = await waitForDbusCall(
    bus,
    dbusCall("Pause", ":1.51"),
    "healthy Pause before slow timeout"
  );
  t.mock.timers.tick(1500);
  await drain();
  assert.equal(settled, false, "a timed-out sibling does not release the operation early");
  assert.equal(bus.connection.endCount, 0, "timeout recycle waits for the operation boundary");
  healthyPause.respond();
  assert.equal(await pausing, true, "the healthy Pause was still acknowledged");
  assert.equal(bus.connection.endCount, 0, "healthy restoration keeps its original connection");
  assert.deepEqual(pausedPlayersFor(mediaPlayer, sessionId), [":1.51"]);
  const timeoutLog = logs.find(
    (entry) => entry.message === "MPRIS Pause not acknowledged" && entry.meta.owner === ":1.50"
  );
  assert.equal(timeoutLog.meta.timedOut, true);
  assert.equal(timeoutLog.meta.generation, 1);

  slowPause.respond();
  await drain();
  assert.deepEqual(pausedPlayersFor(mediaPlayer, sessionId), [":1.51"]);
  const resuming = mediaPlayer.resumeMedia(sessionId);
  const play = await waitForDbusCall(bus, dbusCall("Play", ":1.51"), "healthy Play");
  assert.equal(buses.length, 1, "restoration never crosses connections");
  assert.equal(bus.connection.endCount, 0);
  play.respond();
  assert.equal(await resuming, true);
  assert.equal(bus.calls.filter(dbusMember("Play")).length, 1, "unknown Pause is not restored");
  assert.equal(bus.connection.endCount, 1, "recycle follows completed restoration");
  assert.equal(await mediaPlayer.resumeMedia(sessionId), false);

  const nextPause = mediaPlayer.pauseMedia("after-timeout");
  const nextBus = await waitForBus(buses, 1);
  (await waitForDbusCall(nextBus, dbusMember("ListNames"), "fresh ListNames")).respond([]);
  assert.equal(await nextPause, false);
  assert.deepEqual(calls, []);
});

test("linux: a timeout without acknowledged owners recycles immediately", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { mediaPlayer, buses } = loadMediaPlayer("linux");
  const pausing = mediaPlayer.pauseMedia("timeout-no-owners");
  const bus = await waitForBus(buses);
  const list = await waitForDbusCall(bus, dbusMember("ListNames"), "pending discovery");
  t.mock.timers.tick(2000);
  assert.equal(await pausing, false);
  assert.equal(bus.connection.endCount, 1);
  list.respond(["org.mpris.MediaPlayer2.late"]);
  await drain();
  assert.equal(bus.calls.length, 1, "late discovery cannot send player requests");
  assert.equal(await mediaPlayer.resumeMedia("timeout-no-owners"), false);
  assert.equal(buses.length, 1);
});

test("linux: connection error, end, and stream close reject pending work and reconnect", async () => {
  const { mediaPlayer, buses, logs } = loadMediaPlayer("linux", { warnThrows: true });
  const events = [
    (bus) => bus.connection.emit("error", new Error("socket failed")),
    (bus) => bus.connection.emit("end"),
    (bus) => bus.connection.stream.emit("close"),
  ];
  const staleCalls = [];

  for (let index = 0; index < events.length; index += 1) {
    const pausing = mediaPlayer.pauseMedia(`disconnect-${index}`);
    const bus = await waitForBus(buses, index);
    const list = await waitForDbusCall(bus, dbusMember("ListNames"), "pending ListNames");
    staleCalls.push(list);
    assert.doesNotThrow(() => events[index](bus));
    assert.equal(await pausing, false);
  }

  const finalPause = mediaPlayer.pauseMedia("after-disconnects");
  const finalBus = await waitForBus(buses, 3);
  (await waitForDbusCall(finalBus, dbusMember("ListNames"), "reconnected ListNames")).respond([]);
  assert.equal(await finalPause, false);
  assert.equal(buses.length, 4);

  for (const call of staleCalls) call.respond(["org.mpris.MediaPlayer2.stale"]);
  await drain();
  for (const session of mediaPlayer._mediaSessions.values()) {
    assert.deepEqual(session.pausedPlayers, []);
  }
  const disconnectLogs = logs.filter((entry) => entry.message === "MPRIS D-Bus connection lost");
  assert.equal(disconnectLogs.length, 3);
  assert.deepEqual(
    disconnectLogs.map((entry) => entry.meta.generation),
    [1, 2, 3],
    "disconnect logs retain the invalidated connection generation"
  );
});

test("linux: disconnect during multi-owner resume cannot reconnect within the operation", async () => {
  const { mediaPlayer, buses } = loadMediaPlayer("linux");
  const sessionId = "multi-owner-resume";
  seedMediaSession(mediaPlayer, sessionId, [":1.55", ":1.56"]);
  const resuming = mediaPlayer.resumeMedia(sessionId);
  const bus = await waitForBus(buses);
  await waitForDbusCall(bus, dbusCall("Play", ":1.55"), "first Play");
  await waitForDbusCall(bus, dbusCall("Play", ":1.56"), "second Play");

  bus.connection.emit("end");
  assert.equal(await resuming, false);
  assert.equal(bus.calls.filter(dbusMember("Play")).length, 2);
  assert.equal(buses.length, 1);
  assert.equal(mediaPlayer._mediaSessions.has(sessionId), false);

  const nextPause = mediaPlayer.pauseMedia("after-resume-disconnect");
  const nextBus = await waitForBus(buses, 1);
  (await waitForDbusCall(nextBus, dbusMember("ListNames"), "fresh ListNames")).respond([]);
  assert.equal(await nextPause, false);
});

test("linux: disconnect after a Pause reply cannot repopulate restoration tracking", async () => {
  const { mediaPlayer, buses } = loadMediaPlayer("linux");
  const sessionId = "pause-reply-disconnect";
  const pausing = mediaPlayer.pauseMedia(sessionId);
  const bus = await waitForBus(buses);
  (await waitForDbusCall(bus, dbusMember("ListNames"), "ListNames")).respond([
    "org.mpris.MediaPlayer2.vlc",
  ]);
  (await waitForDbusCall(bus, dbusMember("GetNameOwner"), "GetNameOwner")).respond(":1.57");
  (await waitForDbusCall(bus, dbusCall("Get", ":1.57"), "status")).respond(
    statusVariant("Playing")
  );
  const pause = await waitForDbusCall(bus, dbusCall("Pause", ":1.57"), "Pause");
  pause.respond();
  bus.connection.emit("end");

  assert.equal(await pausing, false);
  assert.deepEqual(pausedPlayersFor(mediaPlayer, sessionId), []);
  assert.equal(buses.length, 1);
});

test("linux: disconnect after status resolution cannot dispatch Pause on a new connection", async () => {
  const { mediaPlayer, buses } = loadMediaPlayer("linux");
  const pausing = mediaPlayer.pauseMedia("status-disconnect");
  const bus = await waitForBus(buses);
  (await waitForDbusCall(bus, dbusMember("ListNames"), "ListNames")).respond([
    "org.mpris.MediaPlayer2.vlc",
  ]);
  (await waitForDbusCall(bus, dbusMember("GetNameOwner"), "GetNameOwner")).respond(":1.58");
  const status = await waitForDbusCall(bus, dbusCall("Get", ":1.58"), "status");
  status.respond(statusVariant("Playing"));
  bus.connection.emit("end");

  assert.equal(await pausing, false);
  assert.equal(bus.calls.some(dbusMember("Pause")), false);
  assert.equal(buses.length, 1);
});

test("linux: idle disconnect clears records and stale events cannot clear new records", async () => {
  const { mediaPlayer, buses } = loadMediaPlayer("linux");
  const firstSessionId = "first-idle-disconnect";
  const firstPause = mediaPlayer.pauseMedia(firstSessionId);
  const firstBus = await waitForBus(buses);
  (await waitForDbusCall(firstBus, dbusMember("ListNames"), "first ListNames")).respond([
    "org.mpris.MediaPlayer2.first",
  ]);
  (await waitForDbusCall(firstBus, dbusMember("GetNameOwner"), "first owner")).respond(":1.59");
  (await waitForDbusCall(firstBus, dbusCall("Get", ":1.59"), "first status")).respond(
    statusVariant("Playing")
  );
  (await waitForDbusCall(firstBus, dbusCall("Pause", ":1.59"), "first Pause")).respond();
  assert.equal(await firstPause, true);
  assert.deepEqual(pausedPlayersFor(mediaPlayer, firstSessionId), [":1.59"]);

  firstBus.connection.emit("end");
  assert.deepEqual(pausedPlayersFor(mediaPlayer, firstSessionId), []);
  assert.equal(await mediaPlayer.resumeMedia(firstSessionId), false);
  assert.equal(buses.length, 1);

  const secondSessionId = "second-idle-disconnect";
  const secondPause = mediaPlayer.pauseMedia(secondSessionId);
  const secondBus = await waitForBus(buses, 1);
  (await waitForDbusCall(secondBus, dbusMember("ListNames"), "second ListNames")).respond([
    "org.mpris.MediaPlayer2.second",
  ]);
  (await waitForDbusCall(secondBus, dbusMember("GetNameOwner"), "second owner")).respond(":1.60");
  (await waitForDbusCall(secondBus, dbusCall("Get", ":1.60"), "second status")).respond(
    statusVariant("Playing")
  );
  (await waitForDbusCall(secondBus, dbusCall("Pause", ":1.60"), "second Pause")).respond();
  assert.equal(await secondPause, true);
  assert.deepEqual(pausedPlayersFor(mediaPlayer, secondSessionId), [":1.60"]);

  firstBus.connection.stream.emit("close");
  assert.deepEqual(
    pausedPlayersFor(mediaPlayer, secondSessionId),
    [":1.60"],
    "a delayed old-generation event cannot clear current records"
  );
});

test("linux: ordinary disconnect suppresses explicit toggle fallbacks", async () => {
  const { mediaPlayer, calls, buses } = loadMediaPlayer("linux", {
    existingPaths: (p) => p.endsWith("linux-fast-paste"),
  });
  const toggling = mediaPlayer.toggleMedia();
  const bus = await waitForBus(buses);
  await waitForDbusCall(bus, dbusMember("ListNames"), "pending ListNames");
  bus.connection.emit("end");

  assert.equal(await toggling, false);
  assert.deepEqual(calls, []);
  assert.equal(buses.length, 1);
});

test("linux: disconnect during linux-fast-paste prevents playerctl fallback", async () => {
  const { mediaPlayer, calls, buses } = loadMediaPlayer("linux", {
    existingPaths: (p) => p.endsWith("linux-fast-paste"),
  });
  const toggling = mediaPlayer.toggleMedia();
  const bus = await waitForBus(buses);
  (await waitForDbusCall(bus, dbusMember("ListNames"), "ListNames")).respond([]);
  const fastPaste = await waitForCall(calls, 0);
  assert.equal(fastPaste.cmd, "linux-fast-paste");

  bus.connection.emit("end");
  fastPaste.child.finish(1);
  assert.equal(await toggling, false);
  assert.equal(calls.length, 1, "playerctl is not dispatched after invalidation");
});

test("linux: close is idempotent and terminal for pending, queued, and future work", async () => {
  const { mediaPlayer, calls, buses } = loadMediaPlayer("linux");
  const pausing = mediaPlayer.pauseMedia("shutdown");
  const queuedToggle = mediaPlayer.toggleMedia();
  const bus = await waitForBus(buses);
  const list = await waitForDbusCall(bus, dbusMember("ListNames"), "pending ListNames");

  mediaPlayer.close();
  assert.equal(bus.connection.endCount, 1);
  assert.equal(mediaPlayer._mediaSessions.size, 0);
  assert.equal(await pausing, false);
  assert.equal(await queuedToggle, false);
  assert.equal(await mediaPlayer.pauseMedia("after-shutdown"), false);
  assert.equal(await mediaPlayer.toggleMedia(), false);
  assert.equal(buses.length, 1, "shutdown work cannot reconnect");
  assert.deepEqual(calls, [], "shutdown work cannot spawn explicit fallbacks");

  mediaPlayer.close();
  assert.equal(bus.connection.endCount, 1);
  list.respond(["org.mpris.MediaPlayer2.stale"]);
  await drain();
  assert.equal(mediaPlayer._mediaSessions.size, 0);
});

test("linux: close during multi-owner resume rejects every pending request", async () => {
  const { mediaPlayer, buses } = loadMediaPlayer("linux");
  const sessionId = "shutdown-resume";
  seedMediaSession(mediaPlayer, sessionId, [":1.62", ":1.63"]);
  const resuming = mediaPlayer.resumeMedia(sessionId);
  const bus = await waitForBus(buses);
  await waitForDbusCall(bus, dbusCall("Play", ":1.62"), "first Play");
  await waitForDbusCall(bus, dbusCall("Play", ":1.63"), "second Play");

  mediaPlayer.close();
  assert.equal(await resuming, false);
  assert.equal(bus.calls.filter(dbusMember("Play")).length, 2);
  assert.equal(buses.length, 1);
  assert.equal(mediaPlayer._mediaSessions.size, 0);
});

test("linux: close after a Pause reply cannot restore tracking", async () => {
  const { mediaPlayer, buses } = loadMediaPlayer("linux");
  const pausing = mediaPlayer.pauseMedia("shutdown-after-pause");
  const bus = await waitForBus(buses);
  (await waitForDbusCall(bus, dbusMember("ListNames"), "ListNames")).respond([
    "org.mpris.MediaPlayer2.vlc",
  ]);
  (await waitForDbusCall(bus, dbusMember("GetNameOwner"), "GetNameOwner")).respond(":1.61");
  (await waitForDbusCall(bus, dbusCall("Get", ":1.61"), "status")).respond(
    statusVariant("Playing")
  );
  const pause = await waitForDbusCall(bus, dbusCall("Pause", ":1.61"), "Pause");
  pause.respond();
  mediaPlayer.close();

  assert.equal(await pausing, false);
  assert.equal(mediaPlayer._mediaSessions.size, 0);
  assert.equal(bus.connection.endCount, 1);
});

test("linux: close during native toggle never starts an explicit fallback", async () => {
  const { mediaPlayer, calls, buses } = loadMediaPlayer("linux", {
    existingPaths: (p) => p.endsWith("linux-fast-paste"),
  });
  const toggling = mediaPlayer.toggleMedia();
  const bus = await waitForBus(buses);
  await waitForDbusCall(bus, dbusMember("ListNames"), "pending ListNames");
  mediaPlayer.close();

  assert.equal(await toggling, false);
  assert.deepEqual(calls, []);
  assert.equal(buses.length, 1);
});

test("linux: package failure keeps explicit fallback while automatic control fails closed", async () => {
  const missing = loadMediaPlayer("linux", { dbusLoadError: new Error("module missing") });
  assert.equal(await missing.mediaPlayer.pauseMedia("missing-package"), false);
  assert.equal(missing.buses.length, 0);
  assert.deepEqual(missing.calls, []);

  const toggling = missing.mediaPlayer.toggleMedia();
  const playerctl = await waitForCall(missing.calls, 0);
  assert.equal(playerctl.cmd, "playerctl");
  assert.deepEqual(playerctl.args, ["play-pause"]);
  playerctl.child.finish(0);
  assert.equal(
    await toggling,
    true,
    "failure before acquiring a generation keeps explicit fallback"
  );

  const throwing = loadMediaPlayer("linux", {
    createBus: () => {
      const bus = createFakeBus();
      bus.invoke = () => {
        throw new Error("invoke exploded");
      };
      return bus;
    },
  });
  assert.equal(await throwing.mediaPlayer.pauseMedia("throwing-invoke"), false);
  assert.equal(throwing.mediaPlayer._mprisPending.size, 0);
  assert.deepEqual(throwing.calls, []);
  throwing.mediaPlayer.close();
  assert.equal(throwing.buses[0].connection.endCount, 1);
});

test("linux: native PlayPause uses the unique owner and reuses the lazy bus", async () => {
  const { mediaPlayer, calls, buses } = loadMediaPlayer("linux");
  const toggling = mediaPlayer.toggleMedia();
  const bus = await waitForBus(buses);
  (await waitForDbusCall(bus, dbusMember("ListNames"), "ListNames")).respond([
    "org.mpris.MediaPlayer2.vlc",
  ]);
  const owner = await waitForDbusCall(bus, dbusMember("GetNameOwner"), "GetNameOwner");
  owner.respond(":1.70");
  const playPause = await waitForDbusCall(bus, dbusCall("PlayPause", ":1.70"), "PlayPause");
  assert.deepEqual(playPause.message, {
    destination: ":1.70",
    path: MPRIS_PLAYER_PATH,
    interface: MPRIS_PLAYER_INTERFACE,
    member: "PlayPause",
    body: undefined,
  });
  playPause.respond();
  assert.equal(await toggling, true);
  assert.equal(buses.length, 1);
  assert.deepEqual(calls, []);
});

test("linux: explicit toggle falls back from native to linux-fast-paste then playerctl", async () => {
  const { mediaPlayer, calls, buses } = loadMediaPlayer("linux", {
    existingPaths: (p) => p.endsWith("linux-fast-paste"),
  });
  const toggling = mediaPlayer.toggleMedia();
  const bus = await waitForBus(buses);
  (await waitForDbusCall(bus, dbusMember("ListNames"), "ListNames")).respond([]);

  const nativeHelper = await waitForCall(calls, 0);
  assert.equal(nativeHelper.cmd, "linux-fast-paste");
  assert.deepEqual(nativeHelper.args, ["--media-play-pause"]);
  nativeHelper.child.finish(1);
  const playerctl = await waitForCall(calls, 1);
  assert.equal(playerctl.cmd, "playerctl");
  assert.deepEqual(playerctl.args, ["play-pause"]);
  playerctl.child.finish(0);
  assert.equal(await toggling, true);
  assert.equal(
    calls.some((call) => call.cmd === "dbus-send"),
    false
  );
});
