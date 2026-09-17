const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { createInterface } = require("node:readline");

test(
  "native input regions scale, clip and route clicks without changing the visible window",
  { skip: process.platform !== "linux", timeout: 30_000 },
  async (t) => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-input-region-"));
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
    if (xvfbCheck.error?.code === "ENOENT") return t.skip("Xvfb is not installed");
    assert.ifError(xvfbCheck.error);
    const libraries = ["-lX11", "-lXtst", "-lXext", "-lm"];
    const prerequisites = spawnSync(
      "gcc",
      ["-x", "c", "-", "-o", path.join(temporaryDirectory, "prerequisites"), ...libraries],
      {
        input:
          "#include <X11/Xlib.h>\n#include <X11/extensions/XTest.h>\n#include <X11/extensions/shape.h>\nint main(void) { return 0; }\n",
        encoding: "utf8",
        timeout: 10_000,
      }
    );
    if (prerequisites.error?.code === "ENOENT") return t.skip("gcc is not installed");
    assert.ifError(prerequisites.error);
    if (prerequisites.status !== 0)
      return t.skip("X11, Xtst or Xext development libraries unavailable");

    const root = path.resolve(__dirname, "../..");
    const helper = path.join(temporaryDirectory, "linux-fast-paste");
    const fixture = path.join(temporaryDirectory, "input-region-fixture");
    for (const [source, output] of [
      [path.join(root, "resources/linux-fast-paste.c"), helper],
      [path.join(root, "test/native/linuxInputRegion.c"), fixture],
    ]) {
      const compiled = spawnSync("gcc", [source, "-o", output, ...libraries], {
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.ifError(compiled.error);
      assert.equal(compiled.status, 0, compiled.stderr);
    }

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

    const result = spawnSync(fixture, [helper], {
      env: { ...process.env, DISPLAY: `:${displayNumber}` },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || displayErrors);
    assert.match(result.stdout, /input region native checks passed/);
  }
);
