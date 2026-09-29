const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  extractTarBz2,
  resolveSystemTarExecutable,
  runSystemTar,
} = require("../../src/helpers/systemTar");

// A real tar.bz2 holding sherpa-fixture/nested/tokens.txt (same as downloadSherpaOnnx.test.js).
const BZIP2_FIXTURE = Buffer.from(
  "QlpoOTFBWSZTWcjrkBQAAIZfgNqQQAP9AEAAAIB/ad7QCAggAHQaQmp4gTeomjCMZDaoMkgNGgABoGgPnMCiCBG+QQRRzUsRSpCCCEAnU6vjF4NbYtiEQUCGSyC5UXVrxyzeEU/18sO69rZRodrj+ckuqldRtcyf1bjbOD33nz4ahhPLBGufu1kDTQiID+LuSKcKEhkdcgKA",
  "base64"
);

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
  const promise = runSystemTar("C:\\cache\\model.tar.gz", "C:\\cache\\extract", {
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
  assert.deepEqual(invocation.args, ["-xzf", "model.tar.gz", "-C", "extract"]);
  assert.equal(invocation.options.cwd, "C:\\cache");
  assert.equal(child.killed, false);
});

test("Windows bzip2 archives reach the JS fallback without starting tar or its external decompressor", async () => {
  for (const extension of ["tar.bz2", "tbz2", "TAR.BZ2"]) {
    let spawned = false;
    await assert.rejects(
      runSystemTar(`C:\\cache\\model.${extension}`, "C:\\cache\\extract", {
        platform: "win32",
        spawnImpl: () => {
          spawned = true;
          return makeChild();
        },
      }),
      /bundled JavaScript extraction/
    );
    assert.equal(spawned, false);
  }
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

test("logs a system tar failure and extracts with the bundled JS decoder", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "system-tar-"));
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const archive = path.join(root, "model.tar.bz2");
  fs.writeFileSync(archive, BZIP2_FIXTURE);
  // No tar on PATH, so the system extractor fails to start (Windows rejects bzip2 before spawning).
  process.env.PATH = root;
  const logged = [];

  await extractTarBz2(archive, root, { logger: { debug: (message) => logged.push(message) } });

  assert.equal(
    fs.readFileSync(path.join(root, "sherpa-fixture", "nested", "tokens.txt"), "utf8"),
    "Windows bzip2 extraction works.\n"
  );
  assert.deepEqual(logged, ["System tar failed, falling back to JS extraction"]);
});
