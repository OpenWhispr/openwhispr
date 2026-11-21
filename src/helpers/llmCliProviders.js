// Pure policy for the subscription-CLI LLM seats (claude, codex, grok, agy).
// CommonJS, no Electron, no fs/child_process/path: platform, env and any I/O
// result are passed in, so main (runner) and the Vite renderer share one
// tested set of decisions. Rule 22c: no API keys, ever; seats use the user's
// own subscription sign-in.

const SCRUB_ENV_KEYS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
  "GROK_API_KEY",
]);

const SHIM_EXTENSIONS = Object.freeze([".cmd", ".bat", ".ps1"]);

const CODEX_ROW = Object.freeze({
  id: "cli-codex",
  seat: "codex",
  label: "Codex",
  exeNames: Object.freeze({ win32: "codex.exe", darwin: "codex", linux: "codex" }),
  versionArgs: Object.freeze(["--version"]),
  versionRegex: /codex-cli\s+(\d+\.\d+\.\d+)/,
  helpArgs: Object.freeze(["exec", "--help"]),
  requiredFlags: Object.freeze([
    "--sandbox",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--output-last-message",
  ]),
  testedVersion: "0.157.0",
  models: Object.freeze([]),
});

const LLM_CLI_PROVIDERS = Object.freeze([CODEX_ROW]);

function getProvider(seat) {
  return LLM_CLI_PROVIDERS.find((p) => p.seat === seat) || null;
}

function envGet(env, name) {
  if (!env) return undefined;
  if (env[name] !== undefined) return env[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower) return env[key];
  }
  return undefined;
}

function sepFor(platform) {
  return platform === "win32" ? "\\" : "/";
}

function joinPath(platform, ...parts) {
  const sep = sepFor(platform);
  return parts
    .filter(Boolean)
    .map((part, i) => (i === 0 ? part.replace(/[\\/]+$/, "") : part.replace(/^[\\/]+|[\\/]+$/g, "")))
    .join(sep);
}

function isShimPath(p) {
  const lower = String(p).toLowerCase();
  return SHIM_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function homeDir(platform, env) {
  return platform === "win32" ? envGet(env, "USERPROFILE") : envGet(env, "HOME");
}

// Per-seat, per-platform known install locations (relative resolution is done
// here so the runner only has to stat what we return).
function knownInstallPaths(seat, platform, env) {
  const home = homeDir(platform, env);
  const out = [];
  if (seat === "codex") {
    if (platform === "win32") {
      const appData = envGet(env, "APPDATA");
      if (appData) {
        out.push({
          path: joinPath(platform, appData, "npm", "codex.cmd"),
          kind: "npm-shim",
        });
        out.push({
          path: joinPath(
            platform,
            appData,
            "npm",
            "node_modules",
            "@openai",
            "codex",
            "node_modules",
            "@openai",
            "codex-win32-x64",
            "vendor",
            "x86_64-pc-windows-msvc",
            "bin",
            "codex.exe"
          ),
          kind: "native-package",
        });
      }
    } else {
      if (home) out.push({ path: joinPath(platform, home, ".local", "bin", "codex"), kind: "known-dir" });
      out.push({ path: "/usr/local/bin/codex", kind: "known-dir" });
      if (platform === "darwin") out.push({ path: "/opt/homebrew/bin/codex", kind: "known-dir" });
    }
  }
  return out;
}

// Ordered detection candidates: PATH first, then known install dirs. A shim
// (.cmd/.bat/.ps1) is reported as a marker only (isShim, never spawnable).
function detectionCandidates(seat, platform, env) {
  const row = getProvider(seat);
  if (!row) return [];
  const exeName = row.exeNames[platform] || row.exeNames.linux;
  const out = [];
  const seen = new Set();
  const push = (entry) => {
    const key = entry.path.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const isShim = isShimPath(entry.path);
    out.push({
      path: entry.path,
      kind: entry.kind,
      isShim,
      spawnable: !isShim,
    });
  };

  const pathVar = envGet(env, "PATH") || "";
  const delimiter = platform === "win32" ? ";" : ":";
  for (const dir of pathVar.split(delimiter)) {
    const trimmed = dir.trim().replace(/^"|"$/g, "");
    if (!trimmed) continue;
    push({ path: joinPath(platform, trimmed, exeName), kind: "path" });
  }
  for (const known of knownInstallPaths(seat, platform, env)) push(known);
  return out;
}

function parseVersion(seat, text) {
  const row = getProvider(seat);
  if (!row || typeof text !== "string") return null;
  const match = row.versionRegex.exec(text.slice(0, 4096));
  return match ? match[1] : null;
}

function missingRequiredFlags(seat, helpText) {
  const row = getProvider(seat);
  if (!row) return [];
  const text = typeof helpText === "string" ? helpText : "";
  return row.requiredFlags.filter((flag) => !text.includes(flag));
}

const STDIN_MARKER = "-";

function buildRunArgv(seat, opts = {}) {
  const { model, outputFile } = opts;
  if (seat === "codex") {
    const argv = [
      "exec",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
    ];
    if (model) argv.push("-m", model);
    if (outputFile) argv.push("-o", outputFile);
    argv.push(STDIN_MARKER);
    return argv;
  }
  throw new Error(`unknown seat: ${seat}`);
}

function buildChildEnv(seat, baseEnv = {}) {
  const scrub = new Set(SCRUB_ENV_KEYS.map((k) => k.toLowerCase()));
  scrub.add("claude_code_oauth_token");
  const out = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (scrub.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function classifyCodexStatus({ exitCode, text } = {}) {
  const body = typeof text === "string" ? text : "";
  if (/api key/i.test(body)) return { status: "signed-out", reason: "api-key-login-refused" };
  if (exitCode === 0 && /logged in/i.test(body)) return { status: "signed-in" };
  return { status: "signed-out" };
}

function initialSeatState() {
  return { status: "missing" };
}

function reduceSeatState(state, event) {
  const prev = state || initialSeatState();
  if (!event || typeof event.type !== "string") return prev;
  switch (event.type) {
    case "NOT_FOUND":
      return { status: "missing" };
    case "DETECTED": {
      const missing = Array.isArray(event.missingFlags) ? event.missingFlags : [];
      return {
        status: missing.length > 0 ? "outdated" : "installed",
        version: event.version || null,
        path: event.path || null,
        missingFlags: missing,
      };
    }
    case "AUTH":
      if (prev.status !== "installed" && prev.status !== "signed-in" && prev.status !== "signed-out") {
        return prev;
      }
      return { ...prev, status: event.result === "signed-in" ? "signed-in" : "signed-out" };
    default:
      return prev;
  }
}

module.exports = Object.freeze({
  LLM_CLI_PROVIDERS,
  SCRUB_ENV_KEYS,
  STDIN_MARKER,
  getProvider,
  detectionCandidates,
  parseVersion,
  missingRequiredFlags,
  buildRunArgv,
  buildChildEnv,
  classifyCodexStatus,
  initialSeatState,
  reduceSeatState,
});
