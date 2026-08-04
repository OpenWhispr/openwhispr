const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

test("live helper probe succeeds on this machine when the binary is present", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only probe");
    return;
  }

  const binaryPath = path.join(
    __dirname,
    "..",
    "..",
    "resources",
    "bin",
    "windows-system-audio-helper.exe"
  );
  if (!fs.existsSync(binaryPath)) {
    t.skip("windows-system-audio-helper.exe is not present in this checkout");
    return;
  }

  const output = await new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ["probe"], { windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`probe exited with code ${code}`));
        return;
      }
      resolve(stdout.trim());
    });
  });

  const parsed = JSON.parse(output);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.supportsNativeCapture, true);
});
