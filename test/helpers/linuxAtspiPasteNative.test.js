const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PASTE_FIXTURE = {
  source: "linuxAtspiPaste.c",
  packages: ["atspi-2", "gobject-2.0", "x11", "xtst", "xext"],
  passed: /AT-SPI paste detection and cleanup checks passed/,
};
const TEXT_MONITOR_FIXTURE = {
  source: "linuxTextMonitorAtspi.c",
  packages: ["atspi-2", "gobject-2.0"],
  passed: /AT-SPI text monitor connection checks passed/,
};

// Compiles a test/native fixture, which includes a resources/ helper with libatspi
// stubbed out, and runs it.
function runNativeFixture(t, fixture, run) {
  const flags = run("pkg-config", ["--cflags", "--libs", ...fixture.packages], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (flags.error?.code === "ENOENT") {
    t.skip("pkg-config unavailable");
    return;
  }
  assert.ifError(flags.error);
  assert.equal(flags.signal, null, "pkg-config terminated by a signal");
  if (flags.status !== 0) {
    t.skip(`development libraries unavailable (${fixture.packages.join(", ")})`);
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-atspi-native-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "fixture");
  const compiled = run(
    "cc",
    [
      path.join(__dirname, "../native", fixture.source),
      "-o",
      binary,
      ...flags.stdout.trim().split(/\s+/),
      "-lm",
    ],
    { encoding: "utf8", timeout: 10_000 }
  );
  if (compiled.error?.code === "ENOENT") {
    t.skip("C compiler unavailable");
    return;
  }
  assert.ifError(compiled.error);
  assert.equal(compiled.status, 0, compiled.stderr);

  const result = run(binary, [], { encoding: "utf8", timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, fixture.passed);
}

// The default keeps the function's length at 1, so node:test passes no done callback.
function runNativePasteTest(t, run = spawnSync) {
  runNativeFixture(t, PASTE_FIXTURE, run);
}

test(
  "native paste detection skips missing state, preserves classifications, and releases references",
  { skip: process.platform !== "linux", timeout: 30_000 },
  runNativePasteTest
);

test(
  "native text monitor starts AT-SPI with direct application connections disabled",
  { skip: process.platform !== "linux", timeout: 30_000 },
  (t) => runNativeFixture(t, TEXT_MONITOR_FIXTURE, spawnSync)
);

for (const code of ["EACCES", "ETIMEDOUT"]) {
  test(`native paste prerequisite probing fails on ${code} instead of skipping`, (t) => {
    const skip = t.mock.fn();
    const error = Object.assign(new Error(`pkg-config ${code}`), { code });
    assert.throws(
      () => runNativePasteTest({ skip }, () => ({ error, status: null, signal: null })),
      new RegExp(code)
    );
    assert.equal(skip.mock.callCount(), 0);
  });
}

test("native paste prerequisite probing fails on signal termination instead of skipping", (t) => {
  const skip = t.mock.fn();
  assert.throws(
    () => runNativePasteTest({ skip }, () => ({ status: null, signal: "SIGTERM" })),
    /pkg-config terminated by a signal/
  );
  assert.equal(skip.mock.callCount(), 0);
});

for (const [reason, probe] of [
  ["missing pkg-config", { error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) }],
  ["missing development libraries", { status: 1, signal: null }],
]) {
  test(`native paste prerequisite probing still skips ${reason}`, (t) => {
    const skip = t.mock.fn();
    runNativePasteTest({ skip }, () => probe);
    assert.equal(skip.mock.callCount(), 1);
  });
}
