const test = require("node:test");
const { afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const managerModulePath = require.resolve("../../src/helpers/qdrantManager");
const originalLoad = Module._load;

const HEALTH_CHECK_INTERVAL_MS = 5000;

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

// Loads a fresh QdrantManager with spawn, http health checks, pid-file
// bookkeeping, and process teardown all stubbed, so tests can wedge and
// recover the sidecar without real processes or sockets.
function loadManager({ gracefulStop } = {}) {
  delete require.cache[managerModulePath];

  const state = {
    healthy: true,
    spawnCalls: [],
    pidFileOps: [],
    warns: [],
    errors: [],
    waitForExitResult: true,
    nextPid: 1001,
    failNextFindPort: false,
    portGate: null,
  };

  const defaultGracefulStop = async (proc) => {
    proc.exitCode = 0;
    proc.emit("close", 0);
  };

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "./debugLogger") {
      return {
        debug() {},
        info() {},
        warn: (msg, meta) => state.warns.push({ msg, meta }),
        error: (msg, meta) => state.errors.push({ msg, meta }),
      };
    }
    if (request === "child_process") {
      return {
        spawn: () => {
          const child = makeChild(state.nextPid++);
          state.spawnCalls.push(child);
          return child;
        },
      };
    }
    if (request === "http") {
      return {
        request: (options, onResponse) => {
          const req = new EventEmitter();
          req.destroy = () => {};
          req.end = () => {
            queueMicrotask(() => {
              if (state.healthy) onResponse({ resume() {} });
              else req.emit("error", new Error("connect ECONNREFUSED"));
            });
          };
          return req;
        },
      };
    }
    if (request === "fs") {
      return { mkdirSync() {}, writeFileSync() {} };
    }
    if (request === "../utils/serverUtils") {
      return {
        findAvailablePort: async () => {
          if (state.failNextFindPort) {
            state.failNextFindPort = false;
            throw new Error("no ports");
          }
          if (state.portGate) await state.portGate;
          return 6333;
        },
        resolveBinaryPath: () => "/fake/bin/qdrant",
        gracefulStopProcess: (proc) => (gracefulStop || defaultGracefulStop)(proc),
      };
    }
    if (request === "./sidecarPidFile") {
      return {
        write: (name, pid) => state.pidFileOps.push(["write", name, pid]),
        clear: (name) => state.pidFileOps.push(["clear", name]),
      };
    }
    if (request === "./sidecarReaper") {
      return { waitForExit: async () => state.waitForExitResult };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    const QdrantManager = require(managerModulePath);
    return { QdrantManager, manager: new QdrantManager(), state };
  } finally {
    Module._load = originalLoad;
  }
}

afterEach(() => {
  Module._load = originalLoad;
});

async function tickHealthCheck(t, times) {
  for (let i = 0; i < times; i++) {
    t.mock.timers.tick(HEALTH_CHECK_INTERVAL_MS);
    await flushPromises();
  }
}

// setTimeout stays real (only setInterval is mocked), so the restart's
// startup polling and this wait both run on real time.
async function waitForReady(manager, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!manager.isReady() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return manager.isReady();
}

test("start spawns qdrant, writes the pid entry, and stop clears it", async () => {
  const { manager, state } = loadManager();

  await manager.start();

  assert.equal(manager.isReady(), true);
  assert.equal(manager.getPort(), 6333);
  assert.deepEqual(state.pidFileOps, [["write", "qdrant", 1001]]);

  await manager.stop();

  assert.equal(manager.isReady(), false);
  assert.equal(manager.getStatus().running, false);
  assert.deepEqual(state.pidFileOps[state.pidFileOps.length - 1], ["clear", "qdrant"]);
});

test("restarts the sidecar after sustained health-check failures", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { QdrantManager, manager, state } = loadManager();
  await manager.start();

  state.healthy = false;
  await tickHealthCheck(t, QdrantManager.HEALTH_FAILURES_BEFORE_RESTART);
  state.healthy = true;

  assert.equal(await waitForReady(manager), true);
  assert.equal(state.spawnCalls.length, 2);
  assert.equal(manager.getPort(), 6333);
  assert.deepEqual(state.pidFileOps, [
    ["write", "qdrant", 1001],
    ["clear", "qdrant"],
    ["write", "qdrant", 1002],
  ]);

  // The replacement is monitored again and healthy checks keep it alone.
  await tickHealthCheck(t, 2);
  assert.equal(state.spawnCalls.length, 2);
});

test("a healthy check resets the consecutive-failure count", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { QdrantManager, manager, state } = loadManager();
  await manager.start();
  const belowThreshold = QdrantManager.HEALTH_FAILURES_BEFORE_RESTART - 1;

  state.healthy = false;
  await tickHealthCheck(t, belowThreshold);
  state.healthy = true;
  await tickHealthCheck(t, 1);
  state.healthy = false;
  await tickHealthCheck(t, belowThreshold);

  assert.equal(state.spawnCalls.length, 1, "should never have restarted");
});

test("stays stopped with one warning once the restart budget is spent", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { QdrantManager, manager, state } = loadManager();
  await manager.start();

  manager.restartCount = QdrantManager.MAX_RESTARTS_PER_SESSION;
  state.healthy = false;
  await tickHealthCheck(t, QdrantManager.HEALTH_FAILURES_BEFORE_RESTART);

  assert.equal(state.spawnCalls.length, 1);
  assert.equal(manager.isReady(), false);
  assert.equal(manager.getStatus().running, false);
  assert.equal(manager.healthCheckInterval, null);
  const giveUpWarns = state.warns.filter(({ msg }) => msg.includes("max restarts"));
  assert.equal(giveUpWarns.length, 1);

  // The interval is gone, so nothing keeps retrying.
  await tickHealthCheck(t, 2);
  assert.equal(state.spawnCalls.length, 1);
});

test("a failed restart leaves qdrant stopped instead of crash-looping", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { QdrantManager, manager, state } = loadManager();
  await manager.start();

  state.healthy = false;
  state.failNextFindPort = true;
  await tickHealthCheck(t, QdrantManager.HEALTH_FAILURES_BEFORE_RESTART);

  assert.equal(state.spawnCalls.length, 1);
  assert.equal(manager.isReady(), false);
  assert.equal(manager.healthCheckInterval, null);
  const failWarns = state.warns.filter(({ msg }) => msg.includes("restart failed"));
  assert.equal(failWarns.length, 1);
});

test("a restart whose replacement never becomes healthy is stopped, not orphaned", async (t) => {
  // Date + setTimeout are mocked so the replacement's 30s startup timeout can
  // be driven without real waiting (flushPromises stays real via setImmediate).
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const stoppedPids = [];
  const { QdrantManager, manager, state } = loadManager({
    gracefulStop: async (proc) => {
      stoppedPids.push(proc.pid);
      proc.exitCode = 0;
      proc.emit("close", 0);
    },
  });
  await manager.start();

  state.healthy = false;
  await tickHealthCheck(t, QdrantManager.HEALTH_FAILURES_BEFORE_RESTART);

  // The replacement spawned but stays unhealthy; tick it past the timeout.
  assert.equal(state.spawnCalls.length, 2);
  for (let i = 0; i < 10 && !state.warns.some(({ msg }) => msg.includes("restart failed")); i++) {
    await tickHealthCheck(t, 1);
  }

  assert.equal(state.warns.filter(({ msg }) => msg.includes("restart failed")).length, 1);
  assert.deepEqual(stoppedPids, [1001, 1002], "the failed replacement must be stopped too");
  assert.equal(manager.getStatus().running, false);
  assert.deepEqual(state.pidFileOps[state.pidFileOps.length - 1], ["clear", "qdrant"]);
});

test("a stop during the restart's pre-spawn port scan aborts without spawning", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { QdrantManager, manager, state } = loadManager();
  await manager.start();

  let releasePort;
  state.portGate = new Promise((resolve) => {
    releasePort = resolve;
  });
  state.healthy = false;
  await tickHealthCheck(t, QdrantManager.HEALTH_FAILURES_BEFORE_RESTART);

  // The restart already killed the old process and is awaiting the port scan,
  // so this quit's stop finds nothing to kill.
  await manager.stop();
  releasePort();
  await flushPromises();
  await flushPromises();

  assert.equal(state.spawnCalls.length, 1, "no replacement may spawn after quit");
  assert.equal(manager.getStatus().running, false);
  assert.equal(manager.getPort(), null);
});

test("a successful unhealthy-restart emits 'restarted' with the new port", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { QdrantManager, manager, state } = loadManager();
  const restartedPorts = [];
  manager.on("restarted", (port) => restartedPorts.push(port));
  await manager.start();

  state.healthy = false;
  await tickHealthCheck(t, QdrantManager.HEALTH_FAILURES_BEFORE_RESTART);
  state.healthy = true;

  assert.equal(await waitForReady(manager), true);
  await flushPromises();
  assert.deepEqual(restartedPorts, [6333]);
});

test("does not respawn over a process that survived SIGKILL", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { QdrantManager, manager, state } = loadManager({ gracefulStop: async () => {} });
  await manager.start();

  state.healthy = false;
  state.waitForExitResult = false;
  await tickHealthCheck(t, QdrantManager.HEALTH_FAILURES_BEFORE_RESTART);

  assert.equal(state.spawnCalls.length, 1);
  assert.equal(manager.getStatus().running, false);
  // The pid entry is restored so the next launch's reaper retries the kill.
  assert.deepEqual(state.pidFileOps[state.pidFileOps.length - 1], ["write", "qdrant", 1001]);
  assert.equal(state.errors.filter(({ msg }) => msg.includes("survived SIGKILL")).length, 1);
});

test("an app-quit stop during a restart wins and nothing respawns", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let releaseStop;
  const gate = new Promise((resolve) => {
    releaseStop = resolve;
  });
  const { QdrantManager, manager, state } = loadManager({
    gracefulStop: async (proc) => {
      await gate;
      proc.exitCode = 0;
      proc.emit("close", 0);
    },
  });
  await manager.start();

  state.healthy = false;
  await tickHealthCheck(t, QdrantManager.HEALTH_FAILURES_BEFORE_RESTART);

  // The restart is blocked inside its stop when the app quits.
  const quitStop = manager.stop();
  releaseStop();
  await quitStop;
  await flushPromises();
  await flushPromises();

  assert.equal(state.spawnCalls.length, 1);
  assert.equal(manager.getStatus().running, false);
  assert.equal(manager.healthCheckInterval, null);
});

test("a late close from the replaced child does not clobber the new process", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  // gracefulStopProcess resolving without a close is the SIGKILL escalation
  // path: the wedged child dies (and emits close) only later.
  const { QdrantManager, manager, state } = loadManager({ gracefulStop: async () => {} });
  await manager.start();
  const wedgedChild = state.spawnCalls[0];

  state.healthy = false;
  await tickHealthCheck(t, QdrantManager.HEALTH_FAILURES_BEFORE_RESTART);
  state.healthy = true;
  assert.equal(await waitForReady(manager), true);
  assert.equal(state.spawnCalls.length, 2);
  const opsBeforeLateClose = state.pidFileOps.length;

  wedgedChild.emit("close", null);

  assert.equal(manager.isReady(), true);
  assert.equal(manager.getStatus().running, true);
  assert.notEqual(manager.healthCheckInterval, null);
  assert.equal(state.pidFileOps.length, opsBeforeLateClose, "pid entry must not be cleared");
});
