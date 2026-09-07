#!/usr/bin/env node

const { spawn } = require("node:child_process");
const { closeSync, openSync } = require("node:fs");
const { readFile, writeFile } = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH =
  process.env.OPENWHISPR_LEADERBOARD_MANIFEST ||
  path.join(os.tmpdir(), "openwhispr-leaderboard-v1.seed");
const PROCESS_PATH = path.join(os.tmpdir(), "openwhispr-leaderboard-v1-processes.json");

function validateManifest(manifest) {
  if (
    manifest?.version !== 2 ||
    !/^[a-f0-9]{6}$/.test(manifest.generation || "") ||
    !Array.isArray(manifest.profiles) ||
    manifest.profiles.length === 0
  ) {
    throw new Error(`Unsupported leaderboard profile manifest: ${MANIFEST_PATH}`);
  }

  const keys = new Set();
  const ports = new Set();
  for (const profile of manifest.profiles) {
    if (
      !/^[a-z0-9][a-z0-9-]{0,31}$/.test(profile.key || "") ||
      typeof profile.label !== "string" ||
      typeof profile.expected !== "string" ||
      typeof profile.token !== "string" ||
      profile.token.length < 16 ||
      !Number.isInteger(profile.bridgePort) ||
      profile.bridgePort < 1024 ||
      profile.bridgePort > 65535 ||
      keys.has(profile.key) ||
      ports.has(profile.bridgePort)
    ) {
      throw new Error(`Invalid leaderboard profile in ${MANIFEST_PATH}`);
    }
    keys.add(profile.key);
    ports.add(profile.bridgePort);
  }
  return manifest;
}

function request({ hostname, port, path: requestPath, method = "GET", body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname,
        port,
        path: requestPath,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : undefined,
        timeout: 1500,
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode || 0));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForPort(port, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const status = await request({ hostname: "127.0.0.1", port, path: "/oauth/callback" });
      if (status > 0) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for profile auth bridge on port ${port}`);
}

function validProcessRecords(value) {
  return Array.isArray(value)
    ? value.filter((record) => Number.isInteger(record?.pid) && record.pid > 0)
    : [];
}

async function writeProcessRecords(records) {
  await writeFile(PROCESS_PATH, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
}

function stopProfiles(records) {
  for (const record of validProcessRecords(records)) {
    try {
      process.kill(record.pid, "SIGTERM");
    } catch {}
  }
}

async function waitForProfilesToStop(records, attempts = 50) {
  let remaining = validProcessRecords(records);
  for (let attempt = 0; attempt < attempts && remaining.length > 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    remaining = remaining.filter((record) => {
      try {
        process.kill(record.pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  }
  if (remaining.length > 0) {
    throw new Error(`Timed out stopping leaderboard profiles: ${remaining.map(({ pid }) => pid)}`);
  }
}

async function ensureSharedServices() {
  const [api, renderer] = await Promise.all([
    request({ hostname: "127.0.0.1", port: 3000, path: "/api/leaderboard/access" }).catch(() => 0),
    request({ hostname: "127.0.0.1", port: 5183, path: "/" }).catch(() => 0),
  ]);
  if (api === 0 || renderer < 200 || renderer >= 500) {
    throw new Error("The local API on :3000 and renderer on :5183 must be running first");
  }
}

async function stopExistingProfiles() {
  let records = [];
  try {
    records = validProcessRecords(JSON.parse(await readFile(PROCESS_PATH, "utf8")));
  } catch {}
  // Retire the records before signalling them. Re-running stop later must not
  // terminate an unrelated process that inherited a stale, recycled PID.
  await writeProcessRecords([]);
  stopProfiles(records);
  await waitForProfilesToStop(records);
}

async function openProfiles() {
  await ensureSharedServices();
  await stopExistingProfiles();
  const manifest = validateManifest(JSON.parse(await readFile(MANIFEST_PATH, "utf8")));

  const electronPath = require("electron");
  const records = [];
  try {
    for (const profile of manifest.profiles) {
      // Every seed generation gets fresh local storage without deleting a prior
      // QA profile. Cloud rows are reset transactionally by the seed script.
      const qaProfile = `${profile.key}-${manifest.generation}`;
      const logPath = path.join(os.tmpdir(), `openwhispr-${profile.key}.log`);
      const logFd = openSync(logPath, "w", 0o600);
      const env = {
        ...process.env,
        AUTH_URL: "http://localhost:3000",
        NODE_ENV: "development",
        OPENWHISPR_AUTH_BRIDGE_PORT: String(profile.bridgePort),
        OPENWHISPR_QA_ONBOARDING_COMPLETE: "1",
        OPENWHISPR_QA_PROFILE: qaProfile,
        OPENWHISPR_START_VIEW: "leaderboard",
        OPENWHISPR_UI_ONLY: "1",
        VITE_AUTH_URL: "http://localhost:3000",
        VITE_OPENWHISPR_API_URL: "http://localhost:3000",
      };
      delete env.ELECTRON_RUN_AS_NODE;

      let child;
      try {
        child = spawn(electronPath, [ROOT, "--dev"], {
          cwd: ROOT,
          detached: true,
          env,
          stdio: ["ignore", logFd, logFd],
        });
      } finally {
        closeSync(logFd);
      }
      child.unref();
      records.push({
        key: profile.key,
        label: profile.label,
        expected: profile.expected,
        qaProfile,
        bridgePort: profile.bridgePort,
        pid: child.pid,
        logPath,
      });
      await writeProcessRecords(records);

      await waitForPort(profile.bridgePort);
      const status = await request({
        hostname: "127.0.0.1",
        port: profile.bridgePort,
        path: "/oauth/callback",
        method: "POST",
        body: { bearer_token: profile.token },
      });
      if (status !== 200) throw new Error(`Could not authenticate ${profile.key}: HTTP ${status}`);
    }
  } catch (error) {
    await writeProcessRecords([]);
    stopProfiles(records);
    throw error;
  }

  console.log(`Opened ${records.length} isolated Leaderboard v1 profiles:`);
  for (const record of records) {
    console.log(`- ${record.label} (PID ${record.pid}): ${record.expected}`);
  }
}

async function main() {
  const command = process.argv[2] || "open";
  if (command === "stop") {
    await stopExistingProfiles();
    console.log("Stopped Leaderboard v1 profiles.");
  } else if (command === "open") {
    await openProfiles();
  } else {
    throw new Error("Usage: node scripts/leaderboard-v1-profiles.js [open|stop]");
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { validateManifest };
