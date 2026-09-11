const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isEnvRef,
  envRefName,
  resolveEnvRef,
  parseExportP,
  isTrustedLoginShell,
  resolveLoginShell,
  coalesceResolvedSecret,
  usableSecret,
  classifySecretInput,
  ENV_EXPORT_SENTINEL,
  importMissingSecretsFromLoginShell,
} = require("../../src/helpers/envKeyResolve");

function exportDump(body) {
  return `${ENV_EXPORT_SENTINEL}\n${body}`;
}

test("detects $VAR and ${VAR} references", () => {
  assert.equal(isEnvRef("$OPENAI_API_KEY"), true);
  assert.equal(isEnvRef(" ${OPENAI_API_KEY} "), true);
  assert.equal(isEnvRef("sk-abc"), false);
  assert.equal(isEnvRef("$1INVALID"), false);
  assert.equal(isEnvRef(""), false);
  assert.equal(envRefName("$OPENAI_API_KEY"), "OPENAI_API_KEY");
  assert.equal(envRefName("${CUSTOM_TRANSCRIPTION_API_KEY}"), "CUSTOM_TRANSCRIPTION_API_KEY");
});

test("resolves a single env-ref hop and leaves literals alone", () => {
  const env = { OPENAI_API_KEY: "sk-from-shell", EMPTY: "" };
  assert.equal(resolveEnvRef("$OPENAI_API_KEY", env), "sk-from-shell");
  assert.equal(resolveEnvRef("${OPENAI_API_KEY}", env), "sk-from-shell");
  assert.equal(resolveEnvRef("sk-hardcoded", env), "sk-hardcoded");
  assert.equal(resolveEnvRef("$MISSING", env), "");
  assert.equal(resolveEnvRef("$EMPTY", env), "");
});

test("does not recursively expand a resolved value", () => {
  const env = { OUTER: "$INNER", INNER: "secret" };
  assert.equal(resolveEnvRef("$OUTER", env), "$INNER");
});

test("parses bash declare -x and zsh export -p lines", () => {
  const parsed = parseExportP(`
declare -x OPENAI_API_KEY="sk-openai"
export GROQ_API_KEY='gsk-groq'
export CUSTOM_TRANSCRIPTION_API_KEY=plain-custom
export WITH_SPACE="hello world"
declare -x EMPTY=""
not an assignment
`);
  assert.equal(parsed.OPENAI_API_KEY, "sk-openai");
  assert.equal(parsed.GROQ_API_KEY, "gsk-groq");
  assert.equal(parsed.CUSTOM_TRANSCRIPTION_API_KEY, "plain-custom");
  assert.equal(parsed.WITH_SPACE, "hello world");
  assert.equal(parsed.EMPTY, "");
  assert.equal(parsed.not, undefined);
});

test("trusted shells are exact system paths, not basenames", () => {
  assert.equal(isTrustedLoginShell("/bin/zsh"), true);
  assert.equal(isTrustedLoginShell("/usr/bin/bash"), true);
  assert.equal(isTrustedLoginShell("/tmp/zsh"), false);
  assert.equal(isTrustedLoginShell("/tmp/evil"), false);
});

test("login-shell import fills only missing secret names", async () => {
  const env = {
    SHELL: "/bin/zsh",
    OPENAI_API_KEY: "already-set",
  };
  const execFileSync = (file, args) => {
    assert.equal(args[0], "-ilc");
    return exportDump(
      `export OPENAI_API_KEY='from-zsh-should-lose'\nexport GROQ_API_KEY='from-zsh'\nexport UNRELATED='nope'\n`
    );
  };

  const { imported, reason } = await importMissingSecretsFromLoginShell({
    secretNames: ["OPENAI_API_KEY", "GROQ_API_KEY", "CUSTOM_TRANSCRIPTION_API_KEY"],
    env,
    platform: "linux",
    execFileSync,
    existsSync: (p) => p === "/bin/zsh",
  });

  assert.equal(reason, "ok");
  assert.deepEqual(imported, ["GROQ_API_KEY"]);
  assert.equal(env.OPENAI_API_KEY, "already-set");
  assert.equal(env.GROQ_API_KEY, "from-zsh");
  assert.equal(env.CUSTOM_TRANSCRIPTION_API_KEY, undefined);
  assert.equal(env.UNRELATED, undefined);
});

test("login-shell import does not execute /tmp/zsh", async () => {
  const called = [];
  const env = { SHELL: "/tmp/zsh" };
  const { imported, reason } = await importMissingSecretsFromLoginShell({
    secretNames: ["OPENAI_API_KEY"],
    env,
    platform: "linux",
    existsSync: (p) => p === "/tmp/zsh" || p === "/bin/bash",
    execFileSync: (file) => {
      called.push(file);
      return "export OPENAI_API_KEY='from-bash'\n";
    },
  });
  assert.deepEqual(called, []);
  assert.equal(reason, "no-trusted-shell");
  assert.deepEqual(imported, []);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test("login-shell child env does not receive app secrets", async () => {
  let childEnv;
  const env = {
    SHELL: "/bin/zsh",
    HOME: "/home/u",
    PATH: "/bin",
    USER: "u",
    OPENAI_API_KEY: "sk-should-not-leak",
    ANTHROPIC_API_KEY: "sk-nope",
  };
  await importMissingSecretsFromLoginShell({
    secretNames: ["GROQ_API_KEY"],
    env,
    platform: "linux",
    existsSync: (p) => p === "/bin/zsh",
    execFileSync: (_file, _args, opts) => {
      childEnv = opts.env;
      return exportDump("export GROQ_API_KEY='gsk'\n");
    },
  });
  assert.equal(childEnv.OPENAI_API_KEY, undefined);
  assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(childEnv.HOME, "/home/u");
  assert.equal(childEnv.SHELL, "/bin/zsh");
  assert.equal(childEnv.TERM, "dumb");
});

test("coalesceResolvedSecret never emits an unexpanded ref", () => {
  assert.equal(coalesceResolvedSecret("$OPENAI_API_KEY", ""), "");
  assert.equal(coalesceResolvedSecret("$OPENAI_API_KEY", "sk-live"), "sk-live");
  assert.equal(coalesceResolvedSecret("$OPENAI_API_KEY", "$OPENAI_API_KEY"), "");
  assert.equal(coalesceResolvedSecret("$OPENAI_API_KEY", undefined), "");
  assert.equal(coalesceResolvedSecret("sk-hardcoded", undefined), "sk-hardcoded");
});

test("parseExportP ignores rc noise before the sentinel", () => {
  const parsed = parseExportP(
    `Powerlevel10k noise FOO=bar\n${ENV_EXPORT_SENTINEL}\nexport GROQ_API_KEY='gsk'\n`,
    ENV_EXPORT_SENTINEL
  );
  assert.equal(parsed.FOO, undefined);
  assert.equal(parsed.GROQ_API_KEY, "gsk");
});

test("login-shell import skips when no trusted shell exists", async () => {
  const { imported, reason } = await importMissingSecretsFromLoginShell({
    secretNames: ["OPENAI_API_KEY"],
    env: { SHELL: "/tmp/zsh" },
    platform: "linux",
    existsSync: () => false,
    execFileSync: () => {
      throw new Error("should not run");
    },
  });
  assert.equal(reason, "no-trusted-shell");
  assert.deepEqual(imported, []);
});

test("resolveLoginShell uses SHELL when trusted, else passwd, and does not probe zsh", () => {
  assert.equal(
    resolveLoginShell({ SHELL: "/usr/bin/bash" }, (p) => p === "/usr/bin/bash", ""),
    "/usr/bin/bash"
  );
  assert.equal(resolveLoginShell({ SHELL: "/tmp/zsh" }, (p) => p === "/bin/bash", "/bin/bash"), null);
  assert.equal(resolveLoginShell({}, (p) => p === "/bin/bash", "/bin/bash"), "/bin/bash");
  assert.equal(resolveLoginShell({}, (p) => p === "/bin/zsh", ""), null);
  assert.equal(resolveLoginShell({}, () => false, ""), null);
});

test("login-shell import records names before mutating env", async () => {
  const env = { SHELL: "/bin/zsh" };
  const importedSet = new Set();
  await importMissingSecretsFromLoginShell({
    secretNames: ["GROQ_API_KEY"],
    env,
    platform: "linux",
    importedSet,
    existsSync: (p) => p === "/bin/zsh",
    execFileSync: () => exportDump("export GROQ_API_KEY='gsk'\n"),
  });
  assert.equal(importedSet.has("GROQ_API_KEY"), true);
  assert.equal(env.GROQ_API_KEY, "gsk");
});

test("login-shell import async execFile path parses sentinel output", async () => {
  const env = { SHELL: "/bin/zsh" };
  const { imported, reason } = await importMissingSecretsFromLoginShell({
    secretNames: ["GROQ_API_KEY"],
    env,
    platform: "linux",
    existsSync: (p) => p === "/bin/zsh",
    execFile: async () => ({ stdout: exportDump("export GROQ_API_KEY='gsk'\n") }),
  });
  assert.equal(reason, "ok");
  assert.deepEqual(imported, ["GROQ_API_KEY"]);
  assert.equal(env.GROQ_API_KEY, "gsk");
});

test("login-shell import is a no-op on Windows and on exec failure", async () => {
  const env = {};
  assert.deepEqual(
    await importMissingSecretsFromLoginShell({
      secretNames: ["OPENAI_API_KEY"],
      env,
      platform: "win32",
      execFileSync: () => {
        throw new Error("should not run");
      },
    }),
    { imported: [], reason: "win32" }
  );
  assert.deepEqual(
    await importMissingSecretsFromLoginShell({
      secretNames: ["OPENAI_API_KEY"],
      env: { SHELL: "/bin/zsh" },
      platform: "linux",
      existsSync: (p) => p === "/bin/zsh",
      execFileSync: () => {
        throw new Error("zsh hung");
      },
    }),
    { imported: [], reason: "exec-failed" }
  );
});

test("usableSecret never returns a leftover $VAR", () => {
  assert.equal(usableSecret("$OPENAI_API_KEY"), "");
  assert.equal(usableSecret("${GROQ_API_KEY}"), "");
  assert.equal(usableSecret("sk-live"), "sk-live");
  assert.equal(usableSecret(""), "");
});

test("classifySecretInput rejects self-refs and unknown names", () => {
  const allowed = new Set(["OPENAI_API_KEY", "GROQ_API_KEY"]);
  assert.equal(classifySecretInput("$OPENAI_API_KEY", "OPENAI_API_KEY", allowed), "self-reference");
  assert.equal(classifySecretInput("$PATH", "OPENAI_API_KEY", allowed), "unknown-ref");
  assert.equal(classifySecretInput("$GROQ_API_KEY", "OPENAI_API_KEY", allowed), null);
  assert.equal(classifySecretInput("sk-live", "OPENAI_API_KEY", allowed), null);
});

test("chat-agent and scope custom refs are not usable as Authorization secrets", () => {
  assert.equal(usableSecret("$CHAT_AGENT_CUSTOM_API_KEY"), "");
  assert.equal(usableSecret("$NOTE_FORMATTING_CUSTOM_API_KEY"), "");
  assert.equal(usableSecret("$TRANSLATION_CUSTOM_API_KEY"), "");
  assert.equal(usableSecret("$DICTATION_AGENT_CUSTOM_API_KEY"), "");
  assert.equal(usableSecret("sk-chat"), "sk-chat");
});

test("resolved env ref is a usable Authorization secret, leftover $VAR is not", () => {
  const resolved = resolveEnvRef("$OPENAI_API_KEY", { OPENAI_API_KEY: "sk-live" });
  assert.equal(usableSecret(resolved), "sk-live");
  assert.equal(usableSecret("$OPENAI_API_KEY"), "");
});

test("envRef.ts and envRef.cjs share the same ENV_REF_RE", () => {
  const fs = require("fs");
  const path = require("path");
  const ts = fs.readFileSync(path.join(__dirname, "../../src/helpers/envRef.ts"), "utf8");
  const cjs = fs.readFileSync(path.join(__dirname, "../../src/helpers/envRef.cjs"), "utf8");
  const re = /ENV_REF_RE = (\/.+\/);/;
  assert.equal(ts.match(re)[1], cjs.match(re)[1]);
});
