const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const mod = require("../../src/helpers/llmCliProviders.js");

const MODULE_SOURCE = fs.readFileSync(
  path.join(__dirname, "../../src/helpers/llmCliProviders.js"),
  "utf8"
);

test("module is Electron-free and I/O-free", () => {
  assert.doesNotMatch(MODULE_SOURCE, /require\(\s*["']electron["']\s*\)/);
  assert.doesNotMatch(MODULE_SOURCE, /require\(\s*["'](fs|child_process|path|os)["']\s*\)/);
});

test("table is frozen and codex is the first entry", () => {
  assert.ok(Object.isFrozen(mod.LLM_CLI_PROVIDERS));
  const first = mod.LLM_CLI_PROVIDERS[0];
  assert.strictEqual(first.id, "cli-codex");
  assert.strictEqual(first.seat, "codex");
  assert.strictEqual(first.exeNames.win32, "codex.exe");
});

// ---- Codex tracer ----

const WIN_ENV = {
  PATH: "C:\\Windows\\system32;C:\\tools",
  APPDATA: "C:\\Users\\u\\AppData\\Roaming",
  USERPROFILE: "C:\\Users\\u",
};

test("codex detection: PATH first, then npm shim marker, then native package", () => {
  const list = mod.detectionCandidates("codex", "win32", WIN_ENV);
  assert.strictEqual(list[0].path, "C:\\Windows\\system32\\codex.exe");
  assert.strictEqual(list[0].kind, "path");
  assert.strictEqual(list[1].path, "C:\\tools\\codex.exe");
  const shim = list.find((c) => c.path.endsWith("codex.cmd"));
  assert.ok(shim);
  assert.strictEqual(shim.isShim, true);
  assert.strictEqual(shim.spawnable, false);
  const native = list.find((c) => c.kind === "native-package");
  assert.ok(native);
  assert.ok(native.path.includes("@openai\\codex-win32-x64"));
  assert.strictEqual(native.spawnable, true);
  assert.ok(list.indexOf(shim) < list.indexOf(native));
});

test("detection never returns a shim as spawnable", () => {
  const env = { ...WIN_ENV, PATH: "C:\\tools" };
  for (const c of mod.detectionCandidates("codex", "win32", env)) {
    if (/\.(cmd|bat|ps1)$/i.test(c.path)) assert.strictEqual(c.spawnable, false, c.path);
  }
});

test("codex detection on darwin and linux uses posix PATH and home dirs", () => {
  const list = mod.detectionCandidates("codex", "linux", { PATH: "/a:/b", HOME: "/home/u" });
  assert.strictEqual(list[0].path, "/a/codex");
  assert.ok(list.some((c) => c.path === "/home/u/.local/bin/codex"));
});

test("parseVersion codex", () => {
  assert.strictEqual(mod.parseVersion("codex", "codex-cli 0.157.0\n"), "0.157.0");
  assert.strictEqual(mod.parseVersion("codex", "garbage"), null);
  assert.strictEqual(mod.parseVersion("codex", 42), null);
});

test("missingRequiredFlags reports flags absent from help text", () => {
  const all = mod.getProvider("codex").requiredFlags.join("\n");
  assert.deepStrictEqual(mod.missingRequiredFlags("codex", all), []);
  const missing = mod.missingRequiredFlags("codex", "--sandbox --ephemeral");
  assert.ok(missing.includes("--ignore-rules"));
  assert.ok(!missing.includes("--sandbox"));
});

test("codex run argv ends with stdin marker and never carries the prompt", () => {
  const argv = mod.buildRunArgv("codex", { model: "gpt-5.5", outputFile: "/tmp/out.txt" });
  assert.strictEqual(argv[0], "exec");
  assert.strictEqual(argv[argv.length - 1], "-");
  const i = argv.indexOf("--sandbox");
  assert.strictEqual(argv[i + 1], "read-only");
  for (const flag of [
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
  ]) {
    assert.ok(argv.includes(flag), flag);
  }
  assert.strictEqual(argv[argv.indexOf("-m") + 1], "gpt-5.5");
  assert.strictEqual(argv[argv.indexOf("-o") + 1], "/tmp/out.txt");
});

test("grok child env turns off the Claude and Cursor config imports", () => {
  const env = mod.buildChildEnv("grok", { PATH: "/bin", GROK_CLAUDE_MCPS_ENABLED: "1" });
  assert.strictEqual(env.PATH, "/bin");
  for (const vendor of ["CLAUDE", "CURSOR"]) {
    for (const kind of ["MCPS", "HOOKS", "SKILLS", "RULES", "AGENTS"]) {
      assert.strictEqual(env[`GROK_${vendor}_${kind}_ENABLED`], "0", `${vendor} ${kind}`);
    }
  }
  for (const seat of ["claude", "codex", "agy"]) {
    const other = mod.buildChildEnv(seat, {});
    assert.ok(!("GROK_CLAUDE_MCPS_ENABLED" in other), seat);
  }
});

test("child env removes every scrub key, keeps PATH and CODEX_HOME", () => {
  const base = { PATH: "/bin", CODEX_HOME: "/x/codex", Openai_Api_Key: "sk-x" };
  for (const k of mod.SCRUB_ENV_KEYS) base[k] = "secret";
  const env = mod.buildChildEnv("codex", base);
  for (const k of mod.SCRUB_ENV_KEYS) assert.ok(!(k in env), k);
  assert.ok(!("Openai_Api_Key" in env));
  assert.strictEqual(env.PATH, "/bin");
  assert.strictEqual(env.CODEX_HOME, "/x/codex");
});

test("classifyCodexStatus", () => {
  assert.deepStrictEqual(
    mod.classifyCodexStatus({ exitCode: 0, text: "Logged in using ChatGPT" }),
    { status: "signed-in" }
  );
  assert.strictEqual(mod.classifyCodexStatus({ exitCode: 1, text: "" }).status, "signed-out");
  const api = mod.classifyCodexStatus({ exitCode: 0, text: "Logged in using an API key" });
  assert.strictEqual(api.status, "signed-out");
  assert.strictEqual(api.reason, "api-key-login-refused");
});

test("seat state: missing -> DETECTED -> AUTH signed-in", () => {
  let s = mod.initialSeatState();
  assert.strictEqual(s.status, "missing");
  s = mod.reduceSeatState(s, { type: "DETECTED", version: "0.157.0", path: "p", missingFlags: [] });
  assert.strictEqual(s.status, "installed");
  s = mod.reduceSeatState(s, { type: "AUTH", result: "signed-in" });
  assert.strictEqual(s.status, "signed-in");
});

// ---- Task 2: claude, grok, agy, safety ----

const CANARY = "sk-ant-oat01-CANARYCANARYCANARY0123456789";

test("claude detection and version", () => {
  const list = mod.detectionCandidates("claude", "win32", WIN_ENV);
  assert.ok(list.some((c) => c.path === "C:\\Users\\u\\.local\\bin\\claude.exe"));
  assert.strictEqual(mod.parseVersion("claude", "2.1.330 (Claude Code)"), "2.1.330");
});

test("claude run argv: stream-json, no tools, never --bare, no prompt", () => {
  const argv = mod.buildRunArgv("claude", { model: "haiku" });
  assert.deepStrictEqual(argv.slice(0, 3), ["-p", "--output-format", "stream-json"]);
  for (const flag of [
    "--verbose",
    "--include-partial-messages",
    "--strict-mcp-config",
    "--no-session-persistence",
  ]) {
    assert.ok(argv.includes(flag), flag);
  }
  assert.strictEqual(argv[argv.indexOf("--tools") + 1], "");
  assert.strictEqual(argv[argv.indexOf("--permission-mode") + 1], "dontAsk");
  assert.strictEqual(argv[argv.indexOf("--model") + 1], "haiku");
  assert.ok(!argv.includes("--bare"));
});

test("claude env carries the token only when given; others never do", () => {
  const base = { PATH: "/bin", ANTHROPIC_API_KEY: "x", CLAUDE_CODE_OAUTH_TOKEN: "ambient" };
  const withTok = mod.buildChildEnv("claude", base, { oauthToken: CANARY, configDir: "/cfg" });
  assert.strictEqual(withTok.CLAUDE_CODE_OAUTH_TOKEN, CANARY);
  assert.strictEqual(withTok.CLAUDE_CONFIG_DIR, "/cfg");
  assert.ok(!("ANTHROPIC_API_KEY" in withTok));
  const noTok = mod.buildChildEnv("claude", base);
  assert.ok(!("CLAUDE_CODE_OAUTH_TOKEN" in noTok));
  assert.ok(!("CLAUDE_CONFIG_DIR" in noTok));
  for (const seat of ["codex", "grok", "agy"]) {
    const env = mod.buildChildEnv(seat, base, { oauthToken: CANARY, configDir: "/cfg" });
    assert.ok(!("CLAUDE_CODE_OAUTH_TOKEN" in env), seat);
    assert.ok(!("CLAUDE_CONFIG_DIR" in env), seat);
  }
});

test("grok detection, version and argv (prompt in a file)", () => {
  const list = mod.detectionCandidates("grok", "win32", WIN_ENV);
  assert.ok(list.some((c) => c.path === "C:\\Users\\u\\.grok\\bin\\grok.exe"));
  assert.strictEqual(mod.parseVersion("grok", "grok 1.0.70 (f50904eaee6c) [stable]"), "1.0.70");
  const argv = mod.buildRunArgv("grok", { model: "grok-4", promptFile: "/tmp/p.txt" });
  assert.strictEqual(argv[argv.indexOf("--prompt-file") + 1], "/tmp/p.txt");
  assert.strictEqual(argv[argv.indexOf("--output-format") + 1], "json");
  assert.strictEqual(argv[argv.indexOf("--permission-mode") + 1], "dontAsk");
  assert.ok(argv.includes("--no-subagents"));
  assert.strictEqual(argv[argv.indexOf("--max-turns") + 1], "1");
  assert.ok(!argv.includes("-p") && !argv.includes("--single"));
  assert.throws(() => mod.buildRunArgv("grok", {}), /promptFile/);
});

test("agy detection, version, argv, env, prompt cap", () => {
  const list = mod.detectionCandidates("agy", "win32", {
    ...WIN_ENV,
    LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
  });
  assert.ok(list.some((c) => c.path === "C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe"));
  assert.strictEqual(mod.parseVersion("agy", "1.5.13\n"), "1.5.13");
  const argv = mod.buildRunArgv("agy", {
    model: "gemini-3-pro",
    prompt: "hello",
    printTimeoutSeconds: 90,
  });
  assert.deepStrictEqual(argv, [
    "-p",
    "hello",
    "--output-format",
    "json",
    "--print-timeout",
    "90s",
    "--model",
    "gemini-3-pro",
  ]);
  assert.strictEqual(mod.buildChildEnv("agy", {}).NO_BROWSER, "1");
  assert.doesNotThrow(() =>
    mod.buildRunArgv("agy", { prompt: "a".repeat(mod.AGY_PROMPT_MAX_CHARS) })
  );
  assert.throws(
    () => mod.buildRunArgv("agy", { prompt: "a".repeat(mod.AGY_PROMPT_MAX_CHARS + 1) }),
    /too long/
  );
  const dashed = mod.buildRunArgv("agy", { prompt: "--sandbox evil" });
  assert.ok(!dashed[1].startsWith("-"));
});

test("isSafeModelId allowlist", () => {
  for (const ok of [
    "haiku",
    "claude-sonnet-5",
    "gpt-5.5",
    "grok-4",
    "gemini-3-pro",
    "a".repeat(80),
  ]) {
    assert.strictEqual(mod.isSafeModelId(ok), true, ok);
  }
  for (const bad of ["", "-m", "a b", "a;b", 'a"b', "a\0b", "a".repeat(81), 5, null]) {
    assert.strictEqual(mod.isSafeModelId(bad), false, String(bad));
  }
  assert.throws(() => mod.buildRunArgv("claude", { model: "a;b" }), /unsafe model/);
});

test("assertPromptOk", () => {
  assert.strictEqual(mod.assertPromptOk("hi"), "hi");
  for (const bad of ["a\0b", 5, "", "a".repeat(200001)]) {
    assert.throws(
      () => mod.assertPromptOk(bad),
      (e) => e.code === "invalid-input"
    );
  }
  assert.doesNotThrow(() => mod.assertPromptOk("a".repeat(200000)));
});

test("flattenPromptToText keeps text parts only", () => {
  const text = mod.flattenPromptToText([
    { role: "system", content: "Be brief." },
    {
      role: "user",
      content: [
        { type: "text", text: "Look at " },
        { type: "image", image: "AAAA" },
        { type: "text", text: "this" },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolName: "x" },
        { type: "text", text: "Ok." },
      ],
    },
    { role: "tool", content: [{ type: "tool-result", result: "tool-output-marker" }] },
  ]);
  assert.strictEqual(text, "System: Be brief.\n\nUser: Look at this\n\nAssistant: Ok.");
  assert.ok(!text.includes("AAAA") && !text.includes("tool-output-marker"));
});

test("redactSecrets", () => {
  const out = mod.redactSecrets(
    `tok ${CANARY} auth Bearer abcdefghijklmnopqrstuvwxyz0123456789 jwt eyJhbGciOi.eyJzdWIiOiIx.abcDEF123 and my-literal-value`,
    ["my-literal-value"]
  );
  assert.ok(!out.includes("CANARYCANARY"));
  assert.ok(!out.includes("abcdefghijklmnopqrstuvwxyz"));
  assert.ok(!out.includes("eyJhbGciOi"));
  assert.ok(!out.includes("my-literal-value"));
  assert.strictEqual(mod.redactSecrets(42), "");
});

test("canary: no argv builder output carries the token, no env carries a scrub key", () => {
  const cases = [
    ["claude", { model: "haiku", oauthToken: CANARY }],
    ["codex", { model: "gpt-5.5", outputFile: "/tmp/o.txt", oauthToken: CANARY }],
    ["grok", { model: "grok-4", promptFile: "/tmp/p.txt", oauthToken: CANARY }],
    ["agy", { model: "gemini-3-pro", prompt: "hi", oauthToken: CANARY }],
  ];
  for (const [seat, opts] of cases) {
    assert.ok(!JSON.stringify(mod.buildRunArgv(seat, opts)).includes(CANARY), seat);
    const base = {};
    for (const k of mod.SCRUB_ENV_KEYS) base[k] = "v";
    const env = mod.buildChildEnv(seat, base, opts);
    for (const k of mod.SCRUB_ENV_KEYS) assert.ok(!(k in env), `${seat} ${k}`);
  }
});

test("every row lists requiredFlags and testedVersion", () => {
  assert.deepStrictEqual(mod.LLM_CLI_PROVIDERS.map((p) => p.seat).sort(), [
    "agy",
    "claude",
    "codex",
    "grok",
  ]);
  for (const p of mod.LLM_CLI_PROVIDERS) {
    assert.ok(p.requiredFlags.length > 0, p.seat);
    assert.match(p.testedVersion, /^\d+\.\d+\.\d+$/);
    for (const m of p.models) assert.ok(mod.isSafeModelId(m));
  }
  assert.strictEqual(mod.getProvider("claude").tokenEnvVar, "CLAUDE_CODE_OAUTH_TOKEN");
});

// ---- Task 3: state machine, gates, scopes, installer and sign-in specs ----

test("reducer transition table", () => {
  const r = mod.reduceSeatState;
  const s0 = mod.initialSeatState();
  assert.strictEqual(r({ status: "installed" }, { type: "NOT_FOUND" }).status, "missing");
  assert.strictEqual(
    r(s0, { type: "DETECTED", version: "1.0.0", path: "p", missingFlags: ["--x"] }).status,
    "outdated"
  );
  const installed = r(s0, { type: "DETECTED", version: "1.0.0", path: "p", missingFlags: [] });
  assert.strictEqual(installed.status, "installed");
  assert.strictEqual(r(installed, { type: "AUTH", result: "signed-out" }).status, "signed-out");
  assert.strictEqual(r(s0, { type: "AUTH", result: "signed-in" }).status, "missing");
  assert.strictEqual(r(s0, { type: "INSTALL_START" }).status, "installing");
  assert.strictEqual(
    r({ status: "installing" }, { type: "INSTALL_DONE", version: "2.0.0" }).status,
    "installed"
  );
  const failed = r({ status: "installing" }, { type: "INSTALL_FAIL", code: "signature-invalid" });
  assert.deepStrictEqual([failed.status, failed.errorCode], ["error", "signature-invalid"]);
  const signing = r({ status: "signed-out" }, { type: "SIGNIN_START" });
  assert.strictEqual(signing.status, "signing-in");
  assert.strictEqual(r(signing, { type: "SIGNIN_DONE" }).status, "signed-in");
  const sf = r(signing, { type: "SIGNIN_FAIL", code: "timeout" });
  assert.deepStrictEqual([sf.status, sf.errorCode], ["signed-out", "timeout"]);
  assert.strictEqual(r({ status: "signed-in" }, { type: "SIGNOUT_DONE" }).status, "signed-out");
  assert.strictEqual(
    r({ status: "signed-in" }, { type: "RUN_ERROR", code: "not-signed-in" }).status,
    "signed-out"
  );
  const kept = r({ status: "signed-in" }, { type: "RUN_ERROR", code: "timeout" });
  assert.strictEqual(kept.status, "signed-in");
  assert.strictEqual(kept.lastError, "timeout");
  const unchanged = { status: "signed-in" };
  assert.strictEqual(r(unchanged, { type: "NOPE" }), unchanged);
  assert.strictEqual(r(unchanged, null), unchanged);
});

test("claude gate (D-04): only claude is gated", () => {
  assert.strictEqual(mod.isSeatEnabled("claude", { claudeEnabled: false }), false);
  assert.strictEqual(mod.isSeatEnabled("claude", {}), false);
  assert.strictEqual(mod.isSeatEnabled("claude", { claudeEnabled: true }), true);
  for (const seat of ["codex", "grok", "agy"]) {
    assert.strictEqual(mod.isSeatEnabled(seat, { claudeEnabled: false }), true, seat);
    assert.strictEqual(mod.isSeatEnabled(seat, { claudeEnabled: true }), true, seat);
  }
});

test("scopes (D-03): CLI seats only for chat and dictation agent; enumerates INFERENCE_SCOPES", () => {
  const { INFERENCE_SCOPES } = require("../../src/config/inferenceScopes.ts");
  const keys = Object.keys(INFERENCE_SCOPES);
  for (const allowed of mod.CLI_SCOPE_ALLOWLIST) assert.ok(keys.includes(allowed), allowed);
  assert.deepStrictEqual([...mod.CLI_SCOPE_ALLOWLIST].sort(), [
    "chatIntelligence",
    "dictationAgent",
  ]);
  for (const key of keys) {
    const ids = mod.cliProviderIdsForScope(key, { claudeEnabled: true });
    if (mod.CLI_SCOPE_ALLOWLIST.includes(key)) {
      assert.deepStrictEqual(
        [...ids].sort(),
        ["cli-agy", "cli-claude", "cli-codex", "cli-grok"],
        key
      );
    } else {
      assert.deepStrictEqual(ids, [], key);
    }
  }
  for (const key of ["dictationCleanup", "dictationAgentVision", "noteFormatting"]) {
    assert.ok(keys.includes(key), key);
    assert.deepStrictEqual(mod.cliProviderIdsForScope(key, { claudeEnabled: true }), []);
  }
  assert.ok(
    !mod.cliProviderIdsForScope("chatIntelligence", { claudeEnabled: false }).includes("cli-claude")
  );
  assert.deepStrictEqual(
    mod.cliProviderIdsForScope("unknownFutureScope", { claudeEnabled: true }),
    []
  );
});

test("installSpec urls and publisher checks (D-02)", () => {
  const c = mod.installSpec("claude", "win32");
  assert.deepStrictEqual(
    [c.kind, c.url, c.publisher, c.publisherCheck],
    ["script", "https://claude.ai/install.ps1", "Anthropic, PBC", "enforce"]
  );
  assert.strictEqual(mod.installSpec("claude", "darwin").url, "https://claude.ai/install.sh");
  assert.strictEqual(mod.installSpec("claude", "linux").url, "https://claude.ai/install.sh");
  assert.strictEqual(
    mod.installSpec("codex", "win32").url,
    "https://chatgpt.com/codex/install.ps1"
  );
  assert.strictEqual(mod.installSpec("codex", "linux").url, "https://chatgpt.com/codex/install.sh");
  for (const [seat, platform, publisher] of [
    ["codex", "win32", "OpenAI OpCo, LLC"],
    ["codex", "linux", "OpenAI OpCo, LLC"],
    ["agy", "win32", "Google LLC"],
    ["agy", "darwin", "Google LLC"],
  ]) {
    const spec = mod.installSpec(seat, platform);
    assert.deepStrictEqual([spec.publisher, spec.publisherCheck], [publisher, "enforce"], seat);
  }
  assert.strictEqual(
    mod.installSpec("agy", "win32").url,
    "https://antigravity.google/cli/install.ps1"
  );
  assert.strictEqual(
    mod.installSpec("agy", "darwin").url,
    "https://antigravity.google/cli/install.sh"
  );
  for (const platform of ["win32", "darwin", "linux"]) {
    assert.deepStrictEqual(mod.installSpec("grok", platform), {
      kind: "guided",
      url: "https://docs.x.ai/build/cli/reference",
    });
    for (const seat of ["claude", "codex", "agy"]) {
      const { url } = mod.installSpec(seat, platform);
      const u = new URL(url);
      assert.strictEqual(u.protocol, "https:");
      assert.ok(["claude.ai", "chatgpt.com", "antigravity.google"].includes(u.hostname));
      assert.strictEqual(u.port + u.username + u.password + u.search + u.hash, "");
    }
  }
});

test("isAllowedInstallUrl rejects off-list and decorated urls", () => {
  assert.strictEqual(mod.isAllowedInstallUrl("https://claude.ai/install.sh"), true);
  for (const bad of [
    "http://claude.ai/install.sh",
    "https://claude.ai:8443/install.sh",
    "https://u@claude.ai/install.sh",
    "https://claude.ai/install.sh?x=1",
    "https://claude.ai.evil.example/install.sh",
    "https://docs.x.ai/install.sh",
    42,
  ]) {
    assert.strictEqual(mod.isAllowedInstallUrl(bad), false, String(bad));
  }
});

test("installCommand is a fixed argv built from the table url", () => {
  assert.deepStrictEqual(mod.installCommand("claude", "win32"), [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "irm https://claude.ai/install.ps1 | iex",
  ]);
  assert.deepStrictEqual(mod.installCommand("codex", "linux"), [
    "/bin/bash",
    "-c",
    "curl -fsSL https://chatgpt.com/codex/install.sh | bash",
  ]);
  assert.strictEqual(mod.installCommand("grok", "win32"), null);
  assert.throws(() => mod.installCommand("nope", "win32"), /unknown seat/);
});

test("isAllowedSignInUrl exact-host allowlist (T-08-05)", () => {
  assert.strictEqual(
    mod.isAllowedSignInUrl("claude", "https://claude.ai/oauth/authorize?code=true"),
    true
  );
  assert.strictEqual(mod.isAllowedSignInUrl("claude", "https://claude.com/cai/oauth"), true);
  assert.strictEqual(mod.isAllowedSignInUrl("codex", "https://auth.openai.com/codex/device"), true);
  assert.strictEqual(mod.isAllowedSignInUrl("grok", "https://accounts.x.ai/device"), true);
  assert.strictEqual(mod.isAllowedSignInUrl("codex", "https://claude.ai/x"), false);
  for (const bad of [
    "http://claude.ai/x",
    "https://user@claude.ai/x",
    "https://claude.ai:444/x",
    "https://claude.ai.evil.example/x",
    "https://evilclaude.ai/x",
    "https://xn--lude-9qa.ai/x",
    "https://clаude.ai/x",
    "javascript:alert(1)",
    "not a url",
    null,
    {},
  ]) {
    assert.strictEqual(mod.isAllowedSignInUrl("claude", bad), false, String(bad));
  }
  assert.strictEqual(mod.isAllowedSignInUrl("agy", "https://claude.ai/x"), false);
});

test("signInSpec and signOutSpec", () => {
  assert.deepStrictEqual(mod.signInSpec("claude"), { kind: "pty-token", argv: ["setup-token"] });
  assert.deepStrictEqual(mod.signInSpec("codex"), {
    kind: "device-auth",
    argv: ["login", "--device-auth"],
  });
  assert.deepStrictEqual(mod.signInSpec("grok"), {
    kind: "device-auth",
    argv: ["login", "--device-auth"],
  });
  assert.deepStrictEqual(mod.signInSpec("agy"), { kind: "terminal-guide" });
  assert.strictEqual(mod.signOutSpec("claude").kind, "delete-stored-token");
  assert.deepStrictEqual(mod.signOutSpec("grok").argv, ["logout"]);
  assert.strictEqual(mod.signOutSpec("grok").verified, undefined);
  assert.strictEqual(mod.signOutSpec("codex").verified, false);
  assert.strictEqual(mod.signOutSpec("agy").kind, "guide");
  assert.strictEqual(mod.signOutSpec("codex").affectsTerminalCli, true);
  assert.strictEqual(mod.signOutSpec("grok").affectsTerminalCli, true);
  assert.strictEqual(mod.signOutSpec("claude").affectsTerminalCli, false);
  assert.strictEqual(mod.signOutSpec("agy").affectsTerminalCli, false);
});

test("TIMEOUTS and ERROR_CODES", () => {
  for (const key of [
    "versionMs",
    "helpMs",
    "statusMs",
    "firstOutputMs",
    "idleMs",
    "totalMs",
    "installMs",
    "signInMs",
  ]) {
    assert.strictEqual(typeof mod.TIMEOUTS[key], "number", key);
    assert.ok(mod.TIMEOUTS[key] > 0, key);
  }
  assert.strictEqual(mod.agyPrintTimeoutSeconds(120000), 115);
  assert.strictEqual(mod.agyPrintTimeoutSeconds(mod.TIMEOUTS.totalMs), 115);
  assert.ok(Object.isFrozen(mod.ERROR_CODES));
  for (const code of [
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
  ]) {
    assert.ok(mod.ERROR_CODES.includes(code), code);
  }
});
