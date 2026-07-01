const fs = require("fs");
const net = require("net");
const path = require("path");
const { killProcessGroup } = require("./process");

const GRACEFUL_STOP_TIMEOUT_MS = 5000;

function tryBind(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", (err) => resolve({ ok: false, code: err.code }));
    s.once("listening", () => s.close(() => resolve({ ok: true })));
    s.listen(port, host);
  });
}

async function isPortAvailable(port) {
  const v4 = await tryBind(port, "0.0.0.0");
  if (!v4.ok) return false;

  const v6 = await tryBind(port, "::");
  // EAFNOSUPPORT means IPv6 is disabled on this host — skip, don't fail
  if (!v6.ok && v6.code !== "EAFNOSUPPORT") return false;

  const lo = await tryBind(port, "127.0.0.1");
  return lo.ok;
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
