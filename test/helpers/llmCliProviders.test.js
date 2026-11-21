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
  for (const flag of ["--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check"]) {
    assert.ok(argv.includes(flag), flag);
  }
  assert.strictEqual(argv[argv.indexOf("-m") + 1], "gpt-5.5");
  assert.strictEqual(argv[argv.indexOf("-o") + 1], "/tmp/out.txt");
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
