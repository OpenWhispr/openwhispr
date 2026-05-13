const fs = require("fs");
const net = require("net");
const path = require("path");
const { killProcessGroup } = require("./process");

const GRACEFUL_STOP_TIMEOUT_MS = 5000;

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => {
      probe.close(() => {
        const loopback = net.createServer();
        loopback.once("error", () => resolve(false));
        loopback.once("listening", () => {
          loopback.close(() => resolve(true));
        });
        loopback.listen(port, "127.0.0.1");
      });
    });
    probe.listen(port, "0.0.0.0");
  });
}

async function findAvailablePort(rangeStart, rangeEnd) {
  for (let port = rangeStart; port <= rangeEnd; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available ports in range ${rangeStart}-${rangeEnd}`);
}

function resolveBinaryPath(binaryName) {
  const candidates = [];

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "bin", binaryName));
  }

  const projectBinDir = path.resolve(__dirname, "..", "..", "resources", "bin");
  candidates.push(path.join(projectBinDir, binaryName));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        fs.statSync(candidate);
        return candidate;
      } catch {
        // Can't access binary
      }
    }
  }

  return null;
}

async function gracefulStopProcess(proc) {
  killProcessGroup(proc, "SIGTERM");

  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (proc) killProcessGroup(proc, "SIGKILL");
      resolve();
    }, GRACEFUL_STOP_TIMEOUT_MS);

    if (proc) {
      proc.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    } else {
      clearTimeout(timeout);
      resolve();
    }
  });
}

module.exports = {
  findAvailablePort,
  isPortAvailable,
  resolveBinaryPath,
  gracefulStopProcess,
};
