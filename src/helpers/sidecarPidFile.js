const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const SUBDIR = "sidecar-pids";

function pidDir() {
  return path.join(app.getPath("userData"), SUBDIR);
}

function pidPath(name) {
  return path.join(pidDir(), `${name}.pid`);
}

function write(name, pid) {
  if (!Number.isInteger(pid)) return;
  try {
    fs.mkdirSync(pidDir(), { recursive: true });
    fs.writeFileSync(pidPath(name), String(pid), "utf-8");
  } catch {
    // Best-effort; the registry is the primary shutdown path.
  }
}

function clear(name) {
  try {
    fs.unlinkSync(pidPath(name));
  } catch {
    // Already gone.
  }
}

function readAll() {
  const dir = pidDir();
  if (!fs.existsSync(dir)) return [];
  const entries = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".pid")) continue;
    const name = path.basename(file, ".pid");
    const raw = fs.readFileSync(path.join(dir, file), "utf-8").trim();
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    entries.push({ name, pid });
  }
  return entries;
}

module.exports = { write, clear, readAll };
