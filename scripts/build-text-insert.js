const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
fs.mkdirSync(path.join(root, "resources", "bin"), { recursive: true });
let result;
if (process.platform === "darwin") {
  result = spawnSync(
    "swiftc",
    ["-O", "resources/macos-text-insert.swift", "-o", "resources/bin/macos-text-insert"],
    { cwd: root, stdio: "inherit" }
  );
} else if (process.platform === "win32") {
  result = spawnSync(
    "cl",
    [
      "/O2",
      "/nologo",
      "resources/windows-text-insert.c",
      "/Fe:resources/bin/windows-text-insert.exe",
      "user32.lib",
    ],
    { cwd: root, stdio: "inherit" }
  );
} else {
  process.exit(0);
}
if (result.error || result.status !== 0) {
  console.error(
    "Direct insertion helper could not compile. Use a developer command prompt on Windows."
  );
  process.exit(1);
}
