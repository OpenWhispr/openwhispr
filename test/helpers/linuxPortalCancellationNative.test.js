const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test(
  "native portal cancellation stops approval waits and finishes every dispatched key release",
  { skip: process.platform !== "linux", timeout: 30_000 },
  (t) => {
    const flags = spawnSync(
      "pkg-config",
      ["--cflags", "--libs", "gio-2.0", "x11", "xtst", "xext"],
      { encoding: "utf8", timeout: 5000 }
    );
    if (flags.error?.code === "ENOENT") {
      t.skip("pkg-config unavailable");
      return;
    }
    assert.ifError(flags.error);
    assert.equal(flags.signal, null, "pkg-config terminated by a signal");
    if (flags.status !== 0) {
      t.skip("GIO/X11 development libraries unavailable");
      return;
    }

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-portal-cancel-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const binary = path.join(directory, "linux-portal-cancellation");
    const compiled = spawnSync(
      "cc",
      [
        path.join(__dirname, "../native/linuxPortalCancellation.c"),
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

    const result = spawnSync(binary, [], { encoding: "utf8", timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /portal cancellation and complete key-release checks passed/);
  }
);
