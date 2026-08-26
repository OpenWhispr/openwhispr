const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

let userDataDir;
const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  exports: {
    app: {
      getPath: () => userDataDir,
      isReady: () => false,
    },
  },
};

const sidecarPidFile = require("../../src/helpers/sidecarPidFile");
const { reapStaleSidecars, waitForExit } = require("../../src/helpers/sidecarReaper");

// Short graces keep the escalation path fast; the poll interval is 200ms so
// anything comfortably above that works.
const GRACES = { sigtermGraceMs: 1000, sigkillGraceMs: 1000 };

// The reaper matches processes by command line, which tasklist on Windows
// reports as the bare image name — these process-identity tests are POSIX-only.
const posixOnly = { skip: process.platform === "win32" };

function createUserDataDir(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-sidecar-reaper-"));
  const dir = userDataDir;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The script filename must contain "qdrant" so processCommand() matches the
// expected binary fragment for the qdrant sidecar.
function spawnFakeSidecar(t, { scriptName, ignoreSigterm }) {
  const handler = ignoreSigterm ? 'process.on("SIGTERM", () => {});' : "";
  const scriptPath = path.join(userDataDir, scriptName);
  fs.writeFileSync(scriptPath, `${handler}console.log("ready");setInterval(() => {}, 1000);`);
  const child = spawn(process.execPath, [scriptPath], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      // Already dead.
    }
  });
  return new Promise((resolve) => {
    child.stdout.once("data", () => resolve(child));
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}

test("kills a responsive stale sidecar and clears its entry", posixOnly, async (t) => {
  createUserDataDir(t);
  const child = await spawnFakeSidecar(t, { scriptName: "qdrant-fake.js", ignoreSigterm: false });
  sidecarPidFile.write("qdrant", child.pid);

  await reapStaleSidecars(GRACES);

  assert.equal(await waitUntilDead(child.pid), true);
  assert.deepEqual(sidecarPidFile.readAll(), []);
});

test("escalates to SIGKILL when a stale sidecar ignores SIGTERM", posixOnly, async (t) => {
  createUserDataDir(t);
  const child = await spawnFakeSidecar(t, { scriptName: "qdrant-stuck.js", ignoreSigterm: true });
  sidecarPidFile.write("qdrant", child.pid);

  await reapStaleSidecars(GRACES);

  assert.equal(await waitUntilDead(child.pid), true);
  assert.deepEqual(sidecarPidFile.readAll(), []);
});

test("does not kill a reused PID that is no longer the sidecar binary", posixOnly, async (t) => {
  createUserDataDir(t);
  const child = await spawnFakeSidecar(t, { scriptName: "other-app.js", ignoreSigterm: false });
  sidecarPidFile.write("qdrant", child.pid);

  await reapStaleSidecars(GRACES);

  assert.equal(isAlive(child.pid), true);
  assert.deepEqual(sidecarPidFile.readAll(), []);
});

// qdrantManager's unhealthy-restart path uses waitForExit to verify the old
// process is gone before spawning a replacement.
test("waitForExit distinguishes a live process from a dead one", async (t) => {
  createUserDataDir(t);
  const child = await spawnFakeSidecar(t, { scriptName: "qdrant-wait.js", ignoreSigterm: false });

  assert.equal(await waitForExit(child.pid, 400), false);

  process.kill(child.pid, "SIGKILL");
  assert.equal(await waitForExit(child.pid, 2000), true);
});

test("clears entries for processes that already exited", async (t) => {
  createUserDataDir(t);
  const child = await spawnFakeSidecar(t, { scriptName: "qdrant-gone.js", ignoreSigterm: false });
  sidecarPidFile.write("qdrant", child.pid);
  process.kill(child.pid, "SIGKILL");
  assert.equal(await waitUntilDead(child.pid), true);

  await reapStaleSidecars(GRACES);

  assert.deepEqual(sidecarPidFile.readAll(), []);
});
