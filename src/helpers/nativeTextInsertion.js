const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

function resolveBinary(platform = process.platform) {
  const name =
    platform === "win32"
      ? "windows-text-insert.exe"
      : platform === "darwin"
        ? "macos-text-insert"
        : null;
  if (!name) return null;
  return (
    [
      path.join(__dirname, "../../resources/bin", name),
      ...(process.resourcesPath
        ? [path.join(process.resourcesPath, "bin", name), path.join(process.resourcesPath, name)]
        : []),
    ].find((file) => fs.existsSync(file)) || null
  );
}

function tryNativeInsertion(text, { binary = resolveBinary(), spawnProcess = spawn } = {}) {
  if (!binary || !text || Buffer.byteLength(text, "utf8") > 1048576 || text.includes("\0"))
    return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(binary, [], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Native insertion timed out; inspect the target before retrying."));
    }, 3000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(true);
      else if (code === 2) resolve(false);
      else
        reject(
          new Error("Native insertion outcome is uncertain; inspect the target before retrying.")
        );
    });
    child.stdin.end(text, "utf8");
  });
}
module.exports = { tryNativeInsertion, resolveBinary };
