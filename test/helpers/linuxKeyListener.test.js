const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// The Linux evdev key listener compiles its hotkey string into modifier
// requirements + a target key. These tests drive the real binary (built by
// `npm run compile:linuxkeys`) and parse its "Listening for:" stderr
// diagnostic, which is printed before it ever touches /dev/input — so no
// input-group permissions are needed to assert the parse logic. The child is
// reaped as soon as the diagnostic arrives. Skipped when the binary isn't
// present (e.g. CI without the native build step).

const BINARY_DIR = path.join(__dirname, "..", "..", "resources", "bin");

function resolveBinary() {
  const candidates = [
    path.join(BINARY_DIR, `linux-key-listener-${process.arch}`),
    path.join(BINARY_DIR, "linux-key-listener"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

const binary = resolveBinary();
const skip = binary ? false : "linux-key-listener binary not built (run npm run compile:linuxkeys)";

// Spawn the listener, read stderr until the diagnostic line appears, then
// SIGTERM the child (which triggers the handler and a clean epoll break).
function parseDiagnostics(hotkey) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [hotkey], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`listener did not print diagnostics for "${hotkey}": ${stderr}`));
    }, 5000);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const line = stderr.split("\n").find((l) => l.startsWith("Listening for:"));
      if (line) {
        clearTimeout(timer);
        child.kill("SIGTERM");
        resolve(line);
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", () => {
      clearTimeout(timer);
    });
  });
}

function parseLine(line) {
  const match = line.match(
    /Listening for: .* \(code=(\d+), ctrl=(\d+)\/(\d+), alt=(\d+)\/(\d+), shift=(\d+)\/(\d+), super=(\d+)\/(\d+), mod_only=(\d+)\)/
  );
  assert.ok(match, `unparseable diagnostic: ${line}`);
  const [
    ,
    code,
    ctrlReq,
    ctrlSide,
    altReq,
    altSide,
    shiftReq,
    shiftSide,
    superReq,
    superSide,
    modOnly,
  ] = match.map(Number);
  return {
    code,
    ctrl: { required: ctrlReq, side: ctrlSide },
    alt: { required: altReq, side: altSide },
    shift: { required: shiftReq, side: shiftSide },
    super: { required: superReq, side: superSide },
    modOnly,
  };
}

// Side constants that must match the C source.
const SIDE = { EITHER: 0, LEFT: 1, RIGHT: 2 };

test("right-side single modifiers parse as modifier-only, side=RIGHT", { skip }, async () => {
  const modFor = (hotkey) =>
    hotkey === "RightAlt"
      ? "alt"
      : hotkey === "RightShift"
        ? "shift"
        : hotkey.includes("RightCtrl") || hotkey.includes("RightControl")
          ? "ctrl"
          : "super";

  for (const hotkey of ["RightAlt", "RightControl", "RightCtrl", "RightShift", "RightSuper"]) {
    const diag = parseLine(await parseDiagnostics(hotkey));
    assert.equal(diag.modOnly, 1, `${hotkey} should be modifier-only`);
    assert.equal(diag.code, 0, `${hotkey} should have no target key`);
    const mod = modFor(hotkey);
    assert.equal(diag[mod].required, 1, `${hotkey} should require ${mod}`);
    assert.equal(diag[mod].side, SIDE.RIGHT, `${hotkey} should require the RIGHT ${mod}`);
  }
});

test("right-side modifiers combine with a base key without overwriting it", { skip }, async () => {
  const diag = parseLine(await parseDiagnostics("RightAlt+Space"));
  assert.equal(diag.modOnly, 0);
  assert.equal(diag.code, 57, "target should stay KEY_SPACE (57)");
  assert.equal(diag.alt.required, 1);
  assert.equal(diag.alt.side, SIDE.RIGHT);
});

test("generic modifiers stay side-agnostic (SIDE_EITHER)", { skip }, async () => {
  const diag = parseLine(await parseDiagnostics("Alt+Space"));
  assert.equal(diag.modOnly, 0);
  assert.equal(diag.alt.required, 1);
  assert.equal(diag.alt.side, SIDE.EITHER);
  assert.equal(diag.code, 57);
});

test("left-side modifiers parse as side=LEFT", { skip }, async () => {
  const diag = parseLine(await parseDiagnostics("LeftControl+K"));
  assert.equal(diag.modOnly, 0);
  assert.equal(diag.ctrl.required, 1);
  assert.equal(diag.ctrl.side, SIDE.LEFT);
  assert.equal(diag.code, 37, "target should stay KEY_K (37)");
});

test(
  "multi-modifier combos with no base key are modifier-only with generic sides",
  { skip },
  async () => {
    const diag = parseLine(await parseDiagnostics("Control+Super"));
    assert.equal(diag.modOnly, 1);
    assert.equal(diag.ctrl.required, 1);
    assert.equal(diag.super.required, 1);
    assert.equal(diag.ctrl.side, SIDE.EITHER);
    assert.equal(diag.super.side, SIDE.EITHER);
  }
);
