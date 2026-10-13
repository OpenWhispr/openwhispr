const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { createInterface } = require("node:readline");

const ROOT = path.resolve(__dirname, "../..");
const LIBRARIES = ["-lX11", "-lXtst", "-lXext", "-lm"];

// Compiles resources/linux-fast-paste.c and test/native/<fixtureName>.c, then runs
// the fixture against the helper on a private Xvfb display. Returns the fixture's
// spawnSync result, or null once the test is skipped because Xvfb, gcc or the X11
// development libraries are missing.
async function runLinuxFastPasteFixture(
  t,
  fixtureName,
  { env = process.env, sharedLibraries = [] } = {}
) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-fast-paste-"));
  let xvfb;
  t.after(async () => {
    if (xvfb && xvfb.exitCode === null && xvfb.signalCode === null) {
      const closed = once(xvfb, "close");
      xvfb.kill("SIGKILL");
      await closed;
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  const xvfbCheck = spawnSync("Xvfb", ["-help"], { encoding: "utf8", timeout: 5000 });
  if (xvfbCheck.error?.code === "ENOENT") {
    t.skip("Xvfb is not installed");
    return null;
  }
  assert.ifError(xvfbCheck.error);
  const prerequisites = spawnSync(
    "gcc",
    ["-x", "c", "-", "-o", path.join(temporaryDirectory, "prerequisites"), ...LIBRARIES],
    {
      input:
        "#include <X11/Xlib.h>\n#include <X11/extensions/XTest.h>\n#include <X11/extensions/shape.h>\nint main(void) { return 0; }\n",
      encoding: "utf8",
      timeout: 10_000,
    }
  );
  if (prerequisites.error?.code === "ENOENT") {
    t.skip("gcc is not installed");
    return null;
  }
  assert.ifError(prerequisites.error);
  if (prerequisites.status !== 0) {
    t.skip("X11, Xtst or Xext development libraries unavailable");
    return null;
  }

  const helper = path.join(temporaryDirectory, "linux-fast-paste");
  const fixture = path.join(temporaryDirectory, fixtureName);
  for (const [source, output] of [
    [path.join(ROOT, "resources/linux-fast-paste.c"), helper],
    [path.join(ROOT, "test/native", `${fixtureName}.c`), fixture],
  ]) {
    const compiled = spawnSync("gcc", [source, "-o", output, ...LIBRARIES], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.ifError(compiled.error);
    assert.equal(compiled.status, 0, compiled.stderr);
  }

  // Shared objects the fixture may LD_PRELOAD into the helper to stand in for a
  // library that fails; their paths follow the helper on the fixture's argv.
  const preloads = sharedLibraries.map((name) => {
    const output = path.join(temporaryDirectory, `${name}.so`);
    const compiled = spawnSync(
      "gcc",
      ["-shared", "-fPIC", path.join(ROOT, "test/native", `${name}.c`), "-o", output],
      { encoding: "utf8", timeout: 10_000 }
    );
    assert.ifError(compiled.error);
    assert.equal(compiled.status, 0, compiled.stderr);
    return output;
  });

  // Xvfb selects a free display itself; never send fixture input to the
  // developer's DISPLAY or assume that a hardcoded display number is unused.
  xvfb = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1024x768x24", "-nolisten", "tcp"], {
    env: { ...process.env, DISPLAY: "" },
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  let displayErrors = "";
  xvfb.stderr.on("data", (chunk) => {
    displayErrors += chunk;
  });
  await once(xvfb, "spawn");
  const displayLines = createInterface({ input: xvfb.stdio[3] });
  t.after(() => displayLines.close());
  const [displayNumber] = await once(displayLines, "line", { signal: AbortSignal.timeout(5000) });
  assert.match(displayNumber, /^\d+$/, displayErrors);

  const result = spawnSync(fixture, [helper, ...preloads], {
    env: { ...env, DISPLAY: `:${displayNumber}` },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || displayErrors);
  return result;
}

module.exports = { runLinuxFastPasteFixture };
