// Pure policy for the subscription-CLI LLM seats (claude, codex, grok, agy).
// ESM (main loads it with require(esm), the Vite renderer imports it), no Electron, no fs/child_process/path: platform, env and any I/O
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

const CLAUDE_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
const SHIM_EXTENSIONS = Object.freeze([".cmd", ".bat", ".ps1"]);
const STDIN_MARKER = "-";
const AGY_PROMPT_MAX_CHARS = 24000;
const PROMPT_MAX_CHARS = 200000;
const MODEL_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

// Known install locations per platform. `env` entries resolve against the
// platform's home/app-data variable; `abs` entries are used verbatim.
// `kind: "npm-shim"` entries are markers only (never spawned).
const LLM_CLI_PROVIDERS = Object.freeze([
  Object.freeze({
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
    known: Object.freeze({
      win32: Object.freeze([
        { env: "APPDATA", rel: ["npm", "codex.cmd"], kind: "npm-shim" },
        {
          env: "APPDATA",
          rel: [
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
            "codex.exe",
          ],
          kind: "native-package",
        },
      ]),
      darwin: Object.freeze([
        { env: "HOME", rel: [".local", "bin", "codex"], kind: "known-dir" },
        { abs: "/usr/local/bin/codex", kind: "known-dir" },
        { abs: "/opt/homebrew/bin/codex", kind: "known-dir" },
      ]),
      linux: Object.freeze([
        { env: "HOME", rel: [".local", "bin", "codex"], kind: "known-dir" },
        { abs: "/usr/local/bin/codex", kind: "known-dir" },
      ]),
    }),
  }),
  Object.freeze({
    id: "cli-claude",
    seat: "claude",
    label: "Claude",
    exeNames: Object.freeze({ win32: "claude.exe", darwin: "claude", linux: "claude" }),
    versionArgs: Object.freeze(["--version"]),
    versionRegex: /(\d+\.\d+\.\d+)\s+\(Claude Code\)/,
    helpArgs: Object.freeze(["--help"]),
    requiredFlags: Object.freeze([
      "--output-format",
      "--include-partial-messages",
      "--tools",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--permission-mode",
    ]),
    testedVersion: "2.1.330",
    models: Object.freeze(["haiku", "sonnet", "opus"]),
    tokenEnvVar: CLAUDE_TOKEN_ENV,
    known: Object.freeze({
      win32: Object.freeze([
        { env: "USERPROFILE", rel: [".local", "bin", "claude.exe"], kind: "known-dir" },
      ]),
      darwin: Object.freeze([
        { env: "HOME", rel: [".local", "bin", "claude"], kind: "known-dir" },
        { env: "HOME", rel: [".claude", "local", "claude"], kind: "known-dir" },
        { abs: "/usr/local/bin/claude", kind: "known-dir" },
        { abs: "/opt/homebrew/bin/claude", kind: "known-dir" },
      ]),
      linux: Object.freeze([
        { env: "HOME", rel: [".local", "bin", "claude"], kind: "known-dir" },
        { env: "HOME", rel: [".claude", "local", "claude"], kind: "known-dir" },
        { abs: "/usr/local/bin/claude", kind: "known-dir" },
      ]),
    }),
  }),
  Object.freeze({
    id: "cli-grok",
    seat: "grok",
    label: "Grok",
    exeNames: Object.freeze({ win32: "grok.exe", darwin: "grok", linux: "grok" }),
    versionArgs: Object.freeze(["--version"]),
    versionRegex: /grok\s+(\d+\.\d+\.\d+)/,
    helpArgs: Object.freeze(["--help"]),
    requiredFlags: Object.freeze([
      "--prompt-file",
      "--output-format",
      "--permission-mode",
      "--no-subagents",
      "--max-turns",
    ]),
    testedVersion: "1.0.70",
    models: Object.freeze(["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"]),
    known: Object.freeze({
      win32: Object.freeze([
        { env: "USERPROFILE", rel: [".grok", "bin", "grok.exe"], kind: "known-dir" },
      ]),
      darwin: Object.freeze([
        { env: "HOME", rel: [".grok", "bin", "grok"], kind: "known-dir" },
        { abs: "/usr/local/bin/grok", kind: "known-dir" },
        { abs: "/opt/homebrew/bin/grok", kind: "known-dir" },
      ]),
      linux: Object.freeze([
        { env: "HOME", rel: [".grok", "bin", "grok"], kind: "known-dir" },
        { abs: "/usr/local/bin/grok", kind: "known-dir" },
      ]),
    }),
  }),
  Object.freeze({
    id: "cli-agy",
    seat: "agy",
    label: "Antigravity",
    exeNames: Object.freeze({ win32: "agy.exe", darwin: "agy", linux: "agy" }),
    versionArgs: Object.freeze(["--version"]),
    versionRegex: /(\d+\.\d+\.\d+)/,
    helpArgs: Object.freeze(["--help"]),
    requiredFlags: Object.freeze(["--print", "--output-format", "--print-timeout", "--model"]),
    testedVersion: "1.5.13",
    models: Object.freeze([
      "gemini-4-neon-high",
      "gemini-4-neon-xhigh",
      "gemini-4-neon-medium",
      "gemini-4-neon-low",
      "gemini-4-carbon-medium",
      "gemini-4-carbon-high",
      "gemini-4-carbon-low",
      "gemini-4-argon-medium",
      "gemini-4-argon-high",
      "gemini-4-argon-low",
      "gemini-4-hydrogen-high",
      "gemini-4-hydrogen-xhigh",
      "gemini-4-hydrogen-medium",
      "gemini-4-hydrogen-low",
      "gemini-pro-orchestrator-neon",
      "gemini-pro-orchestrator",
      "gemini-pro-orchestrator-argon",
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-low",
      "claude-opus-5-5-low",
      "claude-opus-5-5-medium",
      "claude-opus-5-5-high",
      "claude-sonnet-5-5-low",
      "claude-sonnet-5-5-medium",
      "claude-sonnet-5-5-high",
      "gpt-oss-120b-medium",
    ]),
    known: Object.freeze({
      win32: Object.freeze([
        { env: "LOCALAPPDATA", rel: ["agy", "bin", "agy.exe"], kind: "known-dir" },
      ]),
      darwin: Object.freeze([
        { env: "HOME", rel: [".local", "bin", "agy"], kind: "known-dir" },
        { abs: "/usr/local/bin/agy", kind: "known-dir" },
      ]),
      linux: Object.freeze([
        { env: "HOME", rel: [".local", "bin", "agy"], kind: "known-dir" },
        { abs: "/usr/local/bin/agy", kind: "known-dir" },
      ]),
    }),
  }),
]);

function getProvider(seat) {
  return LLM_CLI_PROVIDERS.find((p) => p.seat === seat) || null;
}

function requireProvider(seat) {
  const row = getProvider(seat);
  if (!row) throw invalidInput(`unknown seat: ${seat}`);
  return row;
}

function invalidInput(message) {
  const err = new Error(message);
  err.code = "invalid-input";
  return err;
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
  return parts
    .filter(Boolean)
    .map((part, i) =>
      i === 0 ? part.replace(/[\\/]+$/, "") : part.replace(/^[\\/]+|[\\/]+$/g, "")
    )
    .join(sepFor(platform));
}

function isShimPath(p) {
  const lower = String(p).toLowerCase();
  return SHIM_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function knownInstallPaths(row, platform, env) {
  const entries = row.known[platform] || row.known.linux || [];
  const out = [];
  for (const entry of entries) {
    if (entry.abs) {
      out.push({ path: entry.abs, kind: entry.kind });
      continue;
    }
    const base = envGet(env, entry.env);
    if (!base) continue;
    out.push({ path: joinPath(platform, base, ...entry.rel), kind: entry.kind });
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
    out.push({ path: entry.path, kind: entry.kind, isShim, spawnable: !isShim });
  };

  const pathVar = envGet(env, "PATH") || "";
  const delimiter = platform === "win32" ? ";" : ":";
  for (const dir of pathVar.split(delimiter)) {
    const trimmed = dir.trim().replace(/^"|"$/g, "");
    if (!trimmed) continue;
    push({ path: joinPath(platform, trimmed, exeName), kind: "path" });
  }
  for (const known of knownInstallPaths(row, platform, env)) push(known);
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

function isSafeModelId(id) {
  return typeof id === "string" && MODEL_ID_REGEX.test(id);
}

function assertPromptOk(prompt) {
  if (typeof prompt !== "string") throw invalidInput("prompt must be a string");
  if (prompt.length === 0) throw invalidInput("prompt is empty");
  if (prompt.length > PROMPT_MAX_CHARS) throw invalidInput("prompt too long");
  if (prompt.includes("\0")) throw invalidInput("prompt contains NUL");
  return prompt;
}

function assertModelOk(model) {
  if (model === undefined || model === null || model === "") return null;
  if (!isSafeModelId(model)) throw invalidInput("unsafe model id");
  return model;
}

function assertFileArg(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw invalidInput(`${name} must be a non-empty path without NUL`);
  }
  return value;
}

// The prompt travels on stdin (claude, codex), in a prompt file (grok) or as
// the single `-p` value (agy, which has no stdin text contract). It is never
// spliced into a shell string, and no secret ever appears in argv.
function buildRunArgv(seat, opts = {}) {
  requireProvider(seat);
  const model = assertModelOk(opts.model);
  switch (seat) {
    case "codex": {
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
      if (opts.outputFile) argv.push("-o", assertFileArg(opts.outputFile, "outputFile"));
      argv.push(STDIN_MARKER);
      return argv;
    }
    case "claude": {
      const argv = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--tools",
        "",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--permission-mode",
        "dontAsk",
      ];
      if (model) argv.push("--model", model);
      return argv;
    }
    case "grok": {
      const argv = [
        "--prompt-file",
        assertFileArg(opts.promptFile, "promptFile"),
        "--output-format",
        "json",
        "--permission-mode",
        "dontAsk",
        "--no-subagents",
        "--max-turns",
        "1",
      ];
      if (model) argv.push("--model", model);
      return argv;
    }
    case "agy": {
      let prompt = assertPromptOk(opts.prompt);
      if (prompt.length > AGY_PROMPT_MAX_CHARS) throw invalidInput("agy prompt too long");
      // A leading dash could be read as a flag by the CLI's own parser.
      if (prompt.startsWith("-")) prompt = `Request:\n${prompt}`;
      const seconds = Number.isInteger(opts.printTimeoutSeconds)
        ? opts.printTimeoutSeconds
        : agyPrintTimeoutSeconds(TIMEOUTS.totalMs);
      const argv = ["-p", prompt, "--output-format", "json", "--print-timeout", `${seconds}s`];
      if (model) argv.push("--model", model);
      return argv;
    }
    default:
      throw invalidInput(`unknown seat: ${seat}`);
  }
}

// Child env: every LLM API-key and gateway variable removed (rule 22c), and
// only the claude seat may carry CLAUDE_CODE_OAUTH_TOKEN.
function buildChildEnv(seat, baseEnv = {}, opts = {}) {
  requireProvider(seat);
  const scrub = new Set(SCRUB_ENV_KEYS.map((k) => k.toLowerCase()));
  scrub.add(CLAUDE_TOKEN_ENV.toLowerCase());
  const out = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (scrub.has(lower)) continue;
    // The user's own claude config dir is only meaningful to the claude seat.
    if (lower === "claude_config_dir" && seat !== "claude") continue;
    out[key] = value;
  }
  if (seat === "claude" && typeof opts.oauthToken === "string" && opts.oauthToken.length > 0) {
    out[CLAUDE_TOKEN_ENV] = opts.oauthToken;
    if (typeof opts.configDir === "string" && opts.configDir.length > 0) {
      out.CLAUDE_CONFIG_DIR = opts.configDir;
    }
  }
  if (seat === "agy") out.NO_BROWSER = "1";
  return out;
}

function classifyCodexStatus({ exitCode, text } = {}) {
  const body = typeof text === "string" ? text : "";
  if (/api key/i.test(body)) return { status: "signed-out", reason: "api-key-login-refused" };
  if (exitCode === 0 && /logged in/i.test(body)) return { status: "signed-in" };
  return { status: "signed-out" };
}

// AI SDK v3 prompt array -> one labelled transcript. Only text parts survive;
// image, file and tool parts and the tool role are dropped.
function flattenPromptToText(prompt) {
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt)) return "";
  const labels = { system: "System", user: "User", assistant: "Assistant" };
  const blocks = [];
  for (const message of prompt) {
    if (!message || !labels[message.role]) continue;
    let text = "";
    if (typeof message.content === "string") {
      text = message.content;
    } else if (Array.isArray(message.content)) {
      text = message.content
        .filter((part) => part && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
    }
    if (text.trim().length === 0) continue;
    blocks.push(`${labels[message.role]}: ${text}`);
  }
  return blocks.join("\n\n");
}

const REDACT_INPUT_CAP = 2 * 1024 * 1024;

// Single redaction point for logs, error text and anything crossing IPC.
function redactSecrets(text, literals = []) {
  if (typeof text !== "string") return "";
  let out = text.length > REDACT_INPUT_CAP ? text.slice(0, REDACT_INPUT_CAP) : text;
  for (const literal of literals) {
    if (typeof literal === "string" && literal.length >= 4)
      out = out.split(literal).join("[redacted]");
  }
  out = out.replace(/sk-ant-[A-Za-z0-9_-]{6,}/g, "[redacted]");
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g, "Bearer [redacted]");
  out = out.replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[redacted]");
  return out;
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
      if (
        prev.status !== "installed" &&
        prev.status !== "signed-in" &&
        prev.status !== "signed-out"
      ) {
        return prev;
      }
      return { ...prev, status: event.result === "signed-in" ? "signed-in" : "signed-out" };
    case "INSTALL_START":
      return { status: "installing" };
    case "INSTALL_DONE":
      return {
        status: "installed",
        version: event.version || null,
        path: event.path || null,
        missingFlags: [],
      };
    case "INSTALL_FAIL":
      return { status: "error", errorCode: event.code || "install-failed" };
    case "SIGNIN_START":
      return { ...prev, status: "signing-in" };
    case "SIGNIN_DONE":
      return { ...prev, status: "signed-in", errorCode: undefined };
    case "SIGNIN_FAIL":
      return { ...prev, status: "signed-out", errorCode: event.code || "not-signed-in" };
    case "SIGNOUT_DONE":
      return { ...prev, status: "signed-out" };
    case "RUN_ERROR":
      if (event.code === "not-signed-in") return { ...prev, status: "signed-out" };
      return { ...prev, lastError: event.code || "exit-nonzero" };
    default:
      return prev;
  }
}

// ---- Gates and scopes (D-03, D-04) ----

// Claude runs on the user's subscription at their own risk; it stays hidden
// until the claude setting is switched on. The other seats are never gated.
function isSeatEnabled(seat, prefs = {}) {
  if (seat === "claude") return prefs.claudeEnabled === true;
  return !!getProvider(seat);
}

// Allowlist, not a denylist: a future inference scope defaults to excluded.
const CLI_SCOPE_ALLOWLIST = Object.freeze(["chatIntelligence", "dictationAgent"]);

function cliProviderIdsForScope(scope, prefs = {}) {
  if (!CLI_SCOPE_ALLOWLIST.includes(scope)) return [];
  return LLM_CLI_PROVIDERS.filter((p) => isSeatEnabled(p.seat, prefs)).map((p) => p.id);
}

// ---- Install, sign-in, sign-out specs (D-02) ----

const INSTALL_HOSTS = Object.freeze(["claude.ai", "chatgpt.com", "antigravity.google"]);
const GROK_GUIDE_URL = "https://docs.x.ai/build/cli/reference";

const INSTALL_SCRIPTS = Object.freeze({
  claude: {
    win32: "https://claude.ai/install.ps1",
    posix: "https://claude.ai/install.sh",
    publisher: "Anthropic, PBC",
    publisherCheck: "enforce",
  },
  codex: {
    win32: "https://chatgpt.com/codex/install.ps1",
    posix: "https://chatgpt.com/codex/install.sh",
    publisher: "OpenAI OpCo, LLC",
    publisherCheck: "enforce",
  },
  agy: {
    win32: "https://antigravity.google/cli/install.ps1",
    posix: "https://antigravity.google/cli/install.sh",
    publisher: "Google LLC",
    publisherCheck: "enforce",
  },
});

function parseHttpsUrl(url) {
  if (typeof url !== "string" || url.length > 2048) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password || parsed.port) return null;
  return parsed;
}

function isAllowedInstallUrl(url) {
  const parsed = parseHttpsUrl(url);
  if (!parsed) return false;
  if (parsed.search || parsed.hash) return false;
  return INSTALL_HOSTS.includes(parsed.hostname);
}

function installSpec(seat, platform) {
  requireProvider(seat);
  if (seat === "grok") return { kind: "guided", url: GROK_GUIDE_URL };
  const entry = INSTALL_SCRIPTS[seat];
  const isWin = platform === "win32";
  const url = isWin ? entry.win32 : entry.posix;
  if (!isAllowedInstallUrl(url)) throw invalidInput("install url not allowed");
  return {
    kind: "script",
    shell: isWin ? "powershell" : "bash",
    url,
    publisher: entry.publisher,
    publisherCheck: entry.publisherCheck,
  };
}

// Fixed argv for the hidden shell, built only from the table URL.
function installCommand(seat, platform) {
  const spec = installSpec(seat, platform);
  if (spec.kind !== "script") return null;
  if (spec.shell === "powershell") {
    return [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `irm ${spec.url} | iex`,
    ];
  }
  return ["/bin/bash", "-c", `curl -fsSL ${spec.url} | bash`];
}

const SIGN_IN_HOSTS = Object.freeze({
  claude: Object.freeze(["claude.ai", "claude.com"]),
  codex: Object.freeze(["auth.openai.com"]),
  grok: Object.freeze(["accounts.x.ai"]),
  agy: Object.freeze([]),
});

// Exact-host match on the WHATWG-normalised hostname, so look-alike suffixes
// and punycode (xn--) look-alikes both fail.
function isAllowedSignInUrl(seat, url) {
  const hosts = SIGN_IN_HOSTS[seat];
  if (!hosts) return false;
  const parsed = parseHttpsUrl(url);
  if (!parsed) return false;
  return hosts.includes(parsed.hostname);
}

function signInSpec(seat) {
  requireProvider(seat);
  switch (seat) {
    case "claude":
      return { kind: "pty-token", argv: ["setup-token"] };
    case "codex":
    case "grok":
      return { kind: "device-auth", argv: ["login", "--device-auth"] };
    default:
      return { kind: "terminal-guide" };
  }
}

function signOutSpec(seat) {
  requireProvider(seat);
  switch (seat) {
    case "claude":
      return { kind: "delete-stored-token", affectsTerminalCli: false };
    case "grok":
      return { kind: "cli", argv: ["logout"], affectsTerminalCli: true };
    case "codex":
      // 08-02 confirms with `codex logout --help` before wiring (R-06).
      return { kind: "cli", argv: ["logout"], verified: false, affectsTerminalCli: true };
    default:
      return { kind: "guide", affectsTerminalCli: false };
  }
}

// ---- Timeouts and error taxonomy (D-03) ----

const TIMEOUTS = Object.freeze({
  versionMs: 5000,
  helpMs: 8000,
  statusMs: 10000,
  firstOutputMs: 30000,
  idleMs: 30000,
  totalMs: 120000,
  installMs: 300000,
  signInMs: 600000,
});

function agyPrintTimeoutSeconds(totalMs) {
  return Math.max(1, Math.floor((totalMs - 5000) / 1000));
}

const ERROR_CODES = Object.freeze([
  "not-installed",
  "outdated",
  "not-signed-in",
  "api-key-login-refused",
  "timeout",
  "killed",
  "quota-or-rate-limit",
  "exit-nonzero",
  "parse-failed",
  "claude-disabled",
  "busy",
  "invalid-input",
  "signature-invalid",
  "install-failed",
  "quarantined-or-missing",
]);

// ---- Output parsers (D-01, D-03) ----
// Every parser returns data and never throws on hostile input. All input is
// capped at 2 MB before any regex runs; every regex is linear (no nested or
// overlapping unbounded quantifiers).

const PARSER_INPUT_CAP = 2 * 1024 * 1024;

function capInput(text) {
  if (typeof text !== "string") return "";
  return text.length > PARSER_INPUT_CAP ? text.slice(0, PARSER_INPUT_CAP) : text;
}

function stripAnsi(text) {
  let out = capInput(text);
  out = out.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  out = out.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  out = out.replace(/\x1b[@-Z\\-_]/g, "");
  out = out.replace(/\r\n/g, "\n");
  // A bare carriage return redraws the line: keep what was drawn last.
  if (out.includes("\r")) {
    out = out
      .split("\n")
      .map((line) => {
        const idx = line.lastIndexOf("\r");
        if (idx === -1) return line;
        const tail = line.slice(idx + 1);
        return tail.length > 0 ? tail : line.slice(0, idx).split("\r").pop();
      })
      .join("\n");
  }
  return out;
}

function lastTokenLength(line) {
  let i = line.length - 1;
  while (i >= 0 && line[i] !== " " && line[i] !== "\t") i -= 1;
  return line.length - 1 - i;
}

// A terminal wraps long tokens and URLs at the column limit. A line ending in a
// long unbroken token whose successor has no whitespace is one logical line.
function joinWrappedLines(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i].trimEnd();
    while (
      lastTokenLength(line) >= 20 &&
      i + 1 < lines.length &&
      lines[i + 1].trim().length > 0 &&
      !/\s/.test(lines[i + 1].trim())
    ) {
      i += 1;
      line += lines[i].trim();
    }
    out.push(line);
  }
  return out.join("\n");
}

// Long-lived Claude setup token (oat01 only; API keys are refused, rule 22c).
// A pty delivers output in arbitrary chunks, so a token that ends at the end of
// the buffer may still be growing: it is accepted only once whitespace follows
// it, or when the caller says the stream is over (`final`).
function extractSetupToken(text, { final = false } = {}) {
  const joined = joinWrappedLines(stripAnsi(text));
  const match = /sk-ant-oat01-[A-Za-z0-9_-]{1,150}/.exec(joined);
  if (!match || match[0].length < 100) return null;
  const end = match.index + match[0].length;
  if (end >= joined.length) return final ? match[0] : null;
  if (!/\s/.test(joined[end])) return null;
  if (final) return match[0];
  // A line break alone is not proof the token ended: a terminal that wraps it
  // inserts one mid-token. Wrapped segments are rejoined above, so a break only
  // counts once content follows it.
  const rest = joined.slice(end);
  const gap = /^\s*/.exec(rest)[0];
  if (/[\r\n]/.test(gap) && gap.length === rest.length) return null;
  return match[0];
}

// Parses an X.500 subject as .NET prints it (RDNs split on commas outside double
// quotes, "" escapes a quote). Anything malformed returns null.
function parseSubject(subject) {
  if (typeof subject !== "string" || subject.length === 0 || subject.length > 2048) return null;
  const out = [];
  const n = subject.length;
  let i = 0;
  while (i < n) {
    while (i < n && subject[i] === " ") i += 1;
    const eq = subject.indexOf("=", i);
    if (eq === -1) return null;
    const key = subject.slice(i, eq).trim().toUpperCase();
    if (!/^[A-Z0-9.]+$/.test(key)) return null;
    i = eq + 1;
    while (i < n && subject[i] === " ") i += 1;
    let value = "";
    if (subject[i] === '"') {
      i += 1;
      let closed = false;
      while (i < n) {
        if (subject[i] === '"') {
          if (subject[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          closed = true;
          i += 1;
          break;
        }
        value += subject[i];
        i += 1;
      }
      if (!closed) return null;
      while (i < n && subject[i] === " ") i += 1;
      if (i < n && subject[i] !== ",") return null;
    } else {
      const comma = subject.indexOf(",", i);
      const stop = comma === -1 ? n : comma;
      value = subject.slice(i, stop).trim();
      if (value.includes('"')) return null;
      i = stop;
    }
    out.push([key, value]);
    i += 1;
  }
  return out;
}

// The signing subject must name exactly the expected publisher: one CN equal to
// it, and every O (when present) equal to it. No substring matching.
function subjectMatchesPublisher(subject, publisher) {
  if (typeof publisher !== "string" || publisher.length === 0) return false;
  const rdns = parseSubject(subject);
  if (!rdns) return false;
  const cns = rdns.filter(([key]) => key === "CN");
  if (cns.length !== 1 || cns[0][1] !== publisher) return false;
  return rdns.filter(([key]) => key === "O").every(([, value]) => value === publisher);
}

function extractSignInUrl(seat, text) {
  const joined = joinWrappedLines(stripAnsi(text));
  const re = /https:\/\/[^\s<>"'\x00-\x1f]{1,2000}/g;
  let m;
  let guard = 0;
  while ((m = re.exec(joined)) !== null && guard < 200) {
    guard += 1;
    const candidate = m[0].replace(/[.,;:)\]}]+$/, "");
    if (isAllowedSignInUrl(seat, candidate)) return candidate;
  }
  return null;
}

function extractDeviceCode(text) {
  const clean = stripAnsi(text);
  if (!/https:\/\/[^\s]{4,}/.test(clean)) return null;
  const re = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/g;
  let m;
  let guard = 0;
  while ((m = re.exec(clean)) !== null && guard < 200) {
    guard += 1;
    if (/[A-Z]/.test(m[1])) return m[1];
  }
  return null;
}

const SIGNED_OUT_RE =
  /not (?:logged|signed) in|please (?:log|sign) ?in|run [^\n]{0,30}(?:log ?in|auth)|unauthori[sz]ed|authentication (?:failed|required|error)|invalid[^\n]{0,20}(?:token|credentials)|token (?:has )?expired|session expired|oauth|\b401\b/i;
const QUOTA_RE = /rate.?limit|usage limit|quota|too many requests|overloaded|\b429\b/i;

function classifyStderr(seat, text) {
  if (!getProvider(seat)) return null;
  const clean = capInput(text);
  if (SIGNED_OUT_RE.test(clean)) return "not-signed-in";
  if (QUOTA_RE.test(clean)) return "quota-or-rate-limit";
  return null;
}

function parseClaudeStreamLine(line) {
  if (typeof line !== "string" || line.length === 0 || line.length > PARSER_INPUT_CAP) return null;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  if (obj.type === "stream_event") {
    const ev = obj.event;
    if (
      ev &&
      ev.type === "content_block_delta" &&
      ev.delta &&
      ev.delta.type === "text_delta" &&
      typeof ev.delta.text === "string"
    ) {
      return { type: "text-delta", text: ev.delta.text };
    }
    return null;
  }
  if (obj.type === "result") {
    const body = typeof obj.result === "string" ? obj.result : "";
    if (obj.is_error === true) {
      let code = "exit-nonzero";
      if (
        obj.api_error_status === 401 ||
        /login|authenticat|oauth|expired|invalid.*token/i.test(body)
      ) {
        code = "not-signed-in";
      } else if (/rate limit|usage limit|quota|overloaded/i.test(body)) {
        code = "quota-or-rate-limit";
      }
      return { type: "error", code };
    }
    if (obj.is_error === false) return { type: "final", text: body };
  }
  return null;
}

function parseCodexFinal({ fileText, stderrText } = {}) {
  const message = typeof fileText === "string" ? capInput(fileText).trim() : "";
  if (message.length > 0) return { type: "final", text: message };
  const code = classifyStderr("codex", stderrText);
  if (code) return { type: "error", code };
  return { type: "error", code: "parse-failed" };
}

const JSON_RESULT_FIELDS = Object.freeze([
  "result",
  "text",
  "response",
  "content",
  "message",
  "output",
]);

function parseJsonResult(seat, stdoutText) {
  if (!getProvider(seat)) return { type: "error", code: "parse-failed" };
  const raw = capInput(stdoutText).trim();
  if (raw.length === 0) return { type: "error", code: "parse-failed" };
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { type: "final", text: raw };
  }
  if (typeof doc === "string") {
    return doc.trim().length > 0
      ? { type: "final", text: doc }
      : { type: "error", code: "parse-failed" };
  }
  if (doc && typeof doc === "object" && !Array.isArray(doc)) {
    for (const field of JSON_RESULT_FIELDS) {
      const value = doc[field];
      if (typeof value === "string" && value.trim().length > 0)
        return { type: "final", text: value };
    }
  }
  return { type: "error", code: "parse-failed" };
}

function scrubFixture(text) {
  let out = capInput(text);
  out = out.replace(/[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[^\\/\s"']+/g, "<HOME>");
  out = out.replace(/\/(?:Users|home)\/[^/\s"']+/g, "<HOME>");
  out = out.replace(/sk-ant-[A-Za-z0-9_-]{6,}/g, "sk-ant-REDACTED");
  out = out.replace(/\bsk-[A-Za-z0-9]{16,}/g, "sk-REDACTED");
  out = out.replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "JWT-REDACTED");
  out = out.replace(
    /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,5}/g,
    "user@example.invalid"
  );
  out = out.replace(
    /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    "UUID-REDACTED"
  );
  out = out.replace(/\b(org|acct|account|user|team)[-_][A-Za-z0-9]{8,}\b/g, "$1-REDACTED");
  return out;
}

export {
  LLM_CLI_PROVIDERS,
  stripAnsi,
  extractSetupToken,
  subjectMatchesPublisher,
  extractSignInUrl,
  extractDeviceCode,
  classifyStderr,
  parseClaudeStreamLine,
  parseCodexFinal,
  parseJsonResult,
  scrubFixture,
  SCRUB_ENV_KEYS,
  STDIN_MARKER,
  AGY_PROMPT_MAX_CHARS,
  getProvider,
  detectionCandidates,
  parseVersion,
  missingRequiredFlags,
  isSafeModelId,
  assertPromptOk,
  buildRunArgv,
  buildChildEnv,
  classifyCodexStatus,
  flattenPromptToText,
  redactSecrets,
  initialSeatState,
  reduceSeatState,
  CLI_SCOPE_ALLOWLIST,
  isSeatEnabled,
  cliProviderIdsForScope,
  isAllowedInstallUrl,
  installSpec,
  installCommand,
  isAllowedSignInUrl,
  signInSpec,
  signOutSpec,
  TIMEOUTS,
  agyPrintTimeoutSeconds,
  ERROR_CODES,
};
