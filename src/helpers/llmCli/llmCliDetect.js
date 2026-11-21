// Detection for the subscription-CLI seats: find the exe (PATH, then known
// per-user install dirs, because a fresh install is not on the running app's
// PATH), probe --version and the required flags, then probe auth. Only the
// final resolved exe is ever executed, always by absolute path, never a shim.
const os = require("os");
const path = require("path");
const nodeFs = require("fs");
const { spawn: nodeSpawn } = require("child_process");
const policy = require("../llmCliProviders");
const { defaultKillTree } = require("./llmCliRunner");

const PROBE_OUTPUT_CAP = 64 * 1024;
const SEARCH_MAX_DEPTH = 6;
const SEARCH_MAX_DIRS = 5000;
const TEST_PROMPT = "Reply with the single word OK";
const TEST_TOTAL_MS = 60000;

function envGet(env, name) {
  if (!env) return undefined;
  if (env[name] !== undefined) return env[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) if (key.toLowerCase() === lower) return env[key];
  return undefined;
}

// One bounded, hidden, shell-free probe: version, help and status calls.
function createProbe({
  spawn = nodeSpawn,
  killTree = defaultKillTree,
  platform = process.platform,
  cwd = os.tmpdir(),
} = {}) {
  return function probe(exe, args, { env, timeoutMs }) {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let done = false;
      let child = null;
      let timer = null;
      const finish = (extra) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, timedOut, code: null, ...extra });
      };
      try {
        child = spawn(exe, args, {
          cwd,
          env,
          windowsHide: true,
          shell: false,
          detached: platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        finish({ spawnError: (error && error.code) || "spawn-failed" });
        return;
      }
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
        finish({});
      }, timeoutMs);
      child.stdout.on("data", (d) => {
        if (stdout.length < PROBE_OUTPUT_CAP) stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d) => {
        if (stderr.length < PROBE_OUTPUT_CAP) stderr += d.toString("utf8");
      });
      child.on("error", (error) => finish({ spawnError: (error && error.code) || "spawn-failed" }));
      child.on("close", (code) => finish({ code }));
    });
  };
}

function createDetector({
  fs = nodeFs,
  spawn = nodeSpawn,
  env = process.env,
  platform = process.platform,
  runner,
  tokenStore,
  killTree = defaultKillTree,
  log = () => {},
  timeouts = {},
} = {}) {
  const limits = { ...policy.TIMEOUTS, ...timeouts };
  const P = platform === "win32" ? path.win32 : path.posix;
  const probe = createProbe({ spawn, killTree, platform });
  const states = new Map(); // seat -> state
  const lastSeen = new Map(); // seat -> path that existed on a previous detect
  const listeners = new Set();

  function isFile(p) {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }

  // Bounded breadth-first search for the vendored native exe below a shim's
  // node_modules package dir. Nothing found is executed; only the result is.
  function findNative(root, exeName) {
    const queue = [{ dir: root, depth: 0 }];
    let visited = 0;
    while (queue.length > 0 && visited < SEARCH_MAX_DIRS) {
      const { dir, depth } = queue.shift();
      visited += 1;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isFile() && entry.name.toLowerCase() === exeName.toLowerCase()) {
          return P.join(dir, entry.name);
        }
      }
      if (depth >= SEARCH_MAX_DEPTH) continue;
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.isSymbolicLink?.()) {
          queue.push({ dir: P.join(dir, entry.name), depth: depth + 1 });
        }
      }
    }
    return null;
  }

  // Directories that hold an npm `.cmd` shim for the seat (win32, codex).
  function shimDirs(seat, candidates) {
    const dirs = new Set(candidates.filter((c) => c.isShim).map((c) => P.dirname(c.path)));
    if (platform === "win32" && seat === "codex") {
      const pathVar = envGet(env, "PATH") || "";
      for (const raw of pathVar.split(";")) {
        const dir = raw.trim().replace(/^"|"$/g, "");
        if (dir && isFile(P.join(dir, `${seat}.cmd`))) dirs.add(dir);
      }
    }
    return [...dirs];
  }

  function resolveExe(seat) {
    const provider = policy.getProvider(seat);
    if (!provider) return null;
    const candidates = policy.detectionCandidates(seat, platform, env);
    for (const candidate of candidates) {
      if (candidate.spawnable && isFile(candidate.path)) return candidate.path;
    }
    if (seat === "codex") {
      const exeName = provider.exeNames[platform] || provider.exeNames.linux;
      for (const dir of shimDirs(seat, candidates)) {
        const found = findNative(P.join(dir, "node_modules", "@openai", "codex"), exeName);
        if (found) return found;
      }
    }
    return null;
  }

  function setState(seat, state) {
    states.set(seat, state);
    for (const listener of [...listeners]) {
      try {
        listener(seat, state);
      } catch (error) {
        log("llm-cli detector listener failed", error && error.code);
      }
    }
    return state;
  }

  function apply(seat, event) {
    return setState(seat, policy.reduceSeatState(states.get(seat), event));
  }

  async function probeAuth(seat, exe, childEnv) {
    switch (seat) {
      case "codex": {
        const result = await probe(exe, ["login", "status"], {
          env: childEnv,
          timeoutMs: limits.statusMs,
        });
        const verdict = policy.classifyCodexStatus({
          exitCode: result.code,
          text: `${result.stdout}\n${result.stderr}`,
        });
        return verdict.status;
      }
      case "grok": {
        // Existence only; the credential file is never read.
        const home =
          envGet(env, "GROK_HOME") ||
          P.join(envGet(env, "USERPROFILE") || envGet(env, "HOME") || "", ".grok");
        return isFile(P.join(home, "auth.json")) ? "signed-in" : "signed-out";
      }
      case "claude":
        return tokenStore && tokenStore.has() ? "signed-in" : "signed-out";
      default:
        return null; // agy: unknown until a successful Test
    }
  }

  async function detectOne(seat) {
    const provider = policy.getProvider(seat);
    if (!provider) return null;
    const exe = resolveExe(seat);
    if (!exe) {
      const seen = lastSeen.get(seat);
      if (seen && !isFile(seen)) {
        return setState(seat, { status: "error", errorCode: "quarantined-or-missing", path: seen });
      }
      return apply(seat, { type: "NOT_FOUND" });
    }
    lastSeen.set(seat, exe);
    const childEnv = policy.buildChildEnv(seat, env);

    const versionRun = await probe(exe, provider.versionArgs, {
      env: childEnv,
      timeoutMs: limits.versionMs,
    });
    const version = policy.parseVersion(seat, `${versionRun.stdout}\n${versionRun.stderr}`);
    if (!version) {
      let errorCode = "exit-nonzero";
      if (!isFile(exe)) errorCode = "quarantined-or-missing";
      else if (versionRun.timedOut) errorCode = "timeout";
      return setState(seat, { status: "error", errorCode, path: exe });
    }

    const helpRun = await probe(exe, provider.helpArgs, {
      env: childEnv,
      timeoutMs: limits.helpMs,
    });
    const missingFlags = policy.missingRequiredFlags(seat, `${helpRun.stdout}\n${helpRun.stderr}`);
    const detected = apply(seat, { type: "DETECTED", version, path: exe, missingFlags });
    if (detected.status !== "installed") return detected;

    const auth = await probeAuth(seat, exe, childEnv);
    if (auth === null) return setState(seat, { ...detected, authKnown: false });
    return apply(seat, { type: "AUTH", result: auth });
  }

  async function detectAll() {
    await Promise.all(policy.LLM_CLI_PROVIDERS.map((p) => detectOne(p.seat)));
    return getStates();
  }

  function getStates() {
    const out = {};
    for (const p of policy.LLM_CLI_PROVIDERS)
      out[p.seat] = states.get(p.seat) || policy.initialSeatState();
    return out;
  }

  // One tiny prompt through the runner; success proves the sign-in end to end
  // (the only proof available for agy and grok).
  async function testSeat(seat) {
    if (!policy.getProvider(seat)) return { ok: false, code: "invalid-input" };
    const result = await runner.runStream({ seat, prompt: TEST_PROMPT, totalMs: TEST_TOTAL_MS });
    if (result.ok) {
      const next = policy.reduceSeatState(states.get(seat), { type: "AUTH", result: "signed-in" });
      setState(seat, { ...next, authKnown: true });
      return { ok: true };
    }
    apply(seat, { type: "RUN_ERROR", code: result.code });
    return { ok: false, code: result.code };
  }

  return {
    resolveExe,
    detectOne,
    detectAll,
    getStates,
    getState: (seat) => states.get(seat) || policy.initialSeatState(),
    apply,
    testSeat,
    probe,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

module.exports = { createDetector, createProbe, TEST_PROMPT };
