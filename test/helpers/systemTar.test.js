const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { resolveSystemTarExecutable, runSystemTar } = require("../../src/helpers/systemTar");

function makeChild({ closeOnKill = true } = {}) {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  // killProcess() treats a non-null exitCode as an already-dead process
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    if (closeOnKill) setImmediate(() => child.emit("close", null, "SIGKILL"));
    return true;
  };
  return child;
}

test("resolves Windows tar from System32 instead of PATH", () => {
  assert.equal(
    resolveSystemTarExecutable({
      platform: "win32",
      arch: "x64",
      env: { SystemRoot: "D:\\Windows" },
    }),
    "D:\\Windows\\System32\\tar.exe"
  );
});

test("uses Sysnative when a 32-bit process needs the 64-bit Windows tar", () => {
  assert.equal(
    resolveSystemTarExecutable({
      platform: "win32",
      arch: "ia32",
      env: { SystemRoot: "C:\\Windows", PROCESSOR_ARCHITEW6432: "AMD64" },
    }),
    "C:\\Windows\\Sysnative\\tar.exe"
  );
});

test("keeps PATH tar resolution on non-Windows platforms", () => {
  assert.equal(resolveSystemTarExecutable({ platform: "linux" }), "tar");
});

test("runs the explicit Windows tar with drive-colon-free arguments", async () => {
  const child = makeChild();
  let invocation;
  const promise = runSystemTar("C:\\cache\\model.tar.bz2", "C:\\cache\\extract", {
    platform: "win32",
    arch: "x64",
    env: { SystemRoot: "C:\\Windows" },
    timeoutMs: 100,
    spawnImpl: (command, args, options) => {
      invocation = { command, args, options };
      setImmediate(() => child.emit("close", 0));
      return child;
    },
  });

  await promise;
  assert.equal(invocation.command, "C:\\Windows\\System32\\tar.exe");
  assert.deepEqual(invocation.args, ["-xjf", "model.tar.bz2", "-C", "extract"]);
  assert.equal(invocation.options.cwd, "C:\\cache");
  assert.equal(child.killed, false);
});

test("derives tar flags from the archive extension", async () => {
  for (const [archive, flags] of [
    ["model.tar.gz", "-xzf"],
    ["binary.zip", "-xf"],
  ]) {
    const child = makeChild();
    let args;
    await runSystemTar(`/cache/${archive}`, "/cache/extract", {
      platform: "linux",
      spawnImpl: (_command, spawnArgs) => {
        args = spawnArgs;
        setImmediate(() => child.emit("close", 0));
        return child;
      },
    });
    assert.equal(args[0], flags);
  }
});

test("kills and rejects a tar process that does not exit before the timeout", async () => {
  const child = makeChild();

  await assert.rejects(
    runSystemTar("/cache/model.tar.bz2", "/cache/extract", {
      platform: "linux",
      timeoutMs: 10,
      spawnImpl: () => child,
    }),
    /tar extraction timed out after 10ms/
  );
  assert.equal(child.killed, true);
});

test("rejects after the kill grace period when the killed process never closes", async () => {
  const child = makeChild({ closeOnKill: false });

  await assert.rejects(
    runSystemTar("/cache/model.tar.bz2", "/cache/extract", {
      platform: "linux",
      timeoutMs: 10,
      killGraceMs: 20,
      spawnImpl: () => child,
    }),
    /tar extraction timed out after 10ms/
  );
  assert.equal(child.killed, true);
});
