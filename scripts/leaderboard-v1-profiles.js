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
    records = JSON.parse(await readFile(PROCESS_PATH, "utf8"));
  } catch {}

  for (const record of records) {
    try {
      process.kill(record.pid, "SIGTERM");
    } catch {}
  }
}

async function openProfiles() {
  await ensureSharedServices();
  await stopExistingProfiles();
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.profiles)) {
    throw new Error(`Unsupported leaderboard profile manifest: ${MANIFEST_PATH}`);
  }

  const electronPath = require("electron");
  const records = [];
  for (const profile of manifest.profiles) {
    const logPath = path.join(os.tmpdir(), `openwhispr-${profile.key}.log`);
    const logFd = openSync(logPath, "a", 0o600);
    const env = {
      ...process.env,
      AUTH_URL: "http://localhost:3000",
      NODE_ENV: "development",
      OPENWHISPR_AUTH_BRIDGE_PORT: String(profile.bridgePort),
      OPENWHISPR_QA_ONBOARDING_COMPLETE: "1",
      OPENWHISPR_QA_PROFILE: profile.key,
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
    records.push({ key: profile.key, label: profile.label, pid: child.pid, logPath });

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

  await writeFile(PROCESS_PATH, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  console.log(`Opened ${records.length} isolated Leaderboard v1 profiles:`);
  for (const record of records) console.log(`- ${record.label} (PID ${record.pid})`);
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
