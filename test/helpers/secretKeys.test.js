const test = require("node:test");
const { beforeEach } = test;
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");
const Module = require("module");

// Mock electron and the OS keyring before environment.js / secretCrypto load,
// so secrets take the plaintext (process.env) fallback path instead of writing
// to the developer's real keychain.
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), "ow-secret-test-"));
process.resourcesPath = tmpUserData; // Electron-only global; harmless dummy for the .env fallback scan
const fakeElectron = {
  app: { getPath: () => tmpUserData },
  safeStorage: { isEncryptionAvailable: () => false },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return fakeElectron;
  if (request === "@napi-rs/keyring") throw new Error("keyring disabled in tests");
  if (request === "dotenv") return { config: () => ({}) };
  if (request === "./i18nMain" || request.endsWith("/i18nMain")) {
    return { normalizeUiLanguage: (v) => v || "en" };
  }
  return origLoad.call(this, request, ...rest);
};

const { BYOK_API_KEYS, SECRET_ENV_NAMES } = require("../../src/config/secretKeys");
const EnvironmentManager = require("../../src/helpers/environment");

beforeEach(() => {
  EnvironmentManager._resetShellImportedSecrets();
});

test("manifest entries are unique and complete", () => {
  const seen = { base: new Set(), env: new Set(), storeKey: new Set() };
  for (const k of BYOK_API_KEYS) {
    for (const field of ["base", "env", "get", "save", "storeKey"]) {
      assert.ok(k[field], `${field} present on ${k.base}`);
    }
    for (const field of ["base", "env", "storeKey"]) {
      assert.ok(!seen[field].has(k[field]), `duplicate ${field}: ${k[field]}`);
      seen[field].add(k[field]);
    }
  }
});

test("SECRET_ENV_NAMES includes BYOK custom keys and the cleanup alias", () => {
  for (const name of [
    "CHAT_AGENT_CUSTOM_API_KEY",
    "NOTE_FORMATTING_CUSTOM_API_KEY",
    "TRANSLATION_CUSTOM_API_KEY",
    "DICTATION_AGENT_CUSTOM_API_KEY",
    "DICTATION_AGENT_VISION_CUSTOM_API_KEY",
    "CUSTOM_CLEANUP_API_KEY",
    "CUSTOM_REASONING_API_KEY",
  ]) {
    assert.ok(SECRET_ENV_NAMES.includes(name), name);
  }
});

test("every BYOK key round-trips through the generated accessors", () => {
  const env = new EnvironmentManager();
  for (const k of BYOK_API_KEYS) {
    assert.equal(typeof env[k.get], "function", `${k.get} generated`);
    assert.equal(typeof env[k.save], "function", `${k.save} generated`);

    const secret = `sk-test-${k.base}-123`;
    env[k.save](secret);
    assert.equal(env[k.get](), secret, `${k.base} round-trips`);
    assert.equal(process.env[k.env], secret, `${k.base} persisted to its env var`);

    env[k.save]("");
    assert.equal(env[k.get](), "", `${k.base} clears`);
    assert.equal(process.env[k.env], undefined, `${k.base} env var removed on clear`);
  }
});

test("custom transcription key can reference $OPENAI_API_KEY", () => {
  const previousOpenAI = process.env.OPENAI_API_KEY;
  const previousCustom = process.env.CUSTOM_TRANSCRIPTION_API_KEY;
  const env = new EnvironmentManager();
  process.env.OPENAI_API_KEY = "sk-from-shell";
  env.saveCustomTranscriptionKey("$OPENAI_API_KEY");
  assert.equal(env.getRawKey("CUSTOM_TRANSCRIPTION_API_KEY"), "$OPENAI_API_KEY");
  assert.equal(env.getCustomTranscriptionKey(), "sk-from-shell");
  env.saveCustomTranscriptionKey("");
  if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousOpenAI;
  if (previousCustom === undefined) delete process.env.CUSTOM_TRANSCRIPTION_API_KEY;
  else process.env.CUSTOM_TRANSCRIPTION_API_KEY = previousCustom;
});

test("shell-imported secrets are not written to plaintext .env", async () => {
  const previousOpenAI = process.env.OPENAI_API_KEY;
  const env = new EnvironmentManager();
  process.env.OPENAI_API_KEY = "sk-imported-shell";
  env._shellImportedSecrets.add("OPENAI_API_KEY");
  const result = await env.saveAllKeysToEnvFile();
  const content = fs.readFileSync(result.path, "utf8");
  assert.equal(content.includes("sk-imported-shell"), false);
  assert.equal(content.includes("OPENAI_API_KEY="), false);
  if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousOpenAI;
});

test("getRawKey returns $NAME for shell-imported secrets and saving that ref does not persist", async () => {
  const previousOpenAI = process.env.OPENAI_API_KEY;
  const env = new EnvironmentManager();
  process.env.OPENAI_API_KEY = "sk-imported-shell";
  env._shellImportedSecrets.add("OPENAI_API_KEY");
  assert.equal(env.getRawKey("OPENAI_API_KEY"), "$OPENAI_API_KEY");
  assert.equal(env.getOpenAIKey(), "sk-imported-shell");
  env.saveOpenAIKey("$OPENAI_API_KEY");
  assert.equal(process.env.OPENAI_API_KEY, "sk-imported-shell");
  assert.equal(env._shellImportedSecrets.has("OPENAI_API_KEY"), true);
  const result = await env.saveAllKeysToEnvFile();
  const content = fs.readFileSync(result.path, "utf8");
  assert.equal(content.includes("sk-imported-shell"), false);
  if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousOpenAI;
});

test("resolveSecretRef only expands known secret names", () => {
  const previousOpenAI = process.env.OPENAI_API_KEY;
  const env = new EnvironmentManager();
  process.env.OPENAI_API_KEY = "sk-ok";
  assert.equal(env.resolveSecretRef("$PATH"), "");
  assert.equal(env.resolveSecretRef("$OPENAI_API_KEY"), "sk-ok");
  if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousOpenAI;
});

test("self-referential $OPENAI_API_KEY is rejected and does not become a bearer token", () => {
  const previousOpenAI = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const env = new EnvironmentManager();
  const saved = env.saveOpenAIKey("$OPENAI_API_KEY");
  assert.equal(saved.success, false);
  assert.equal(saved.reason, "self-reference");
  assert.equal(process.env.OPENAI_API_KEY, undefined);
  assert.equal(env.getOpenAIKey(), "");
  env.saveOpenAIKey("${OPENAI_API_KEY}");
  assert.equal(process.env.OPENAI_API_KEY, undefined);
  if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousOpenAI;
});

test("_getKey does not expand non-secret env names", () => {
  const previous = process.env.CUSTOM_TRANSCRIPTION_API_KEY;
  const env = new EnvironmentManager();
  process.env.CUSTOM_TRANSCRIPTION_API_KEY = "$PATH";
  assert.equal(env.getCustomTranscriptionKey(), "");
  if (previous === undefined) delete process.env.CUSTOM_TRANSCRIPTION_API_KEY;
  else process.env.CUSTOM_TRANSCRIPTION_API_KEY = previous;
});

test("openrouter is a first-class secret", () => {
  const or = BYOK_API_KEYS.find((k) => k.base === "openrouter");
  assert.ok(or, "openrouter present in manifest");
  assert.equal(or.env, "OPENROUTER_API_KEY");
  const env = new EnvironmentManager();
  env.saveOpenrouterKey("sk-or-abc");
  assert.equal(env.getOpenrouterKey(), "sk-or-abc");
});

// The accessor names come verbatim from the manifest rather than from `base`,
// and realtimeTokenProviders.js / stt-canary.mjs call these exact spellings —
// a base-derived rename would give getAssemblyaiKey and break them silently.
test("the STT accessors keep the spellings their callers use", () => {
  const env = new EnvironmentManager();
  assert.equal(typeof env.getAssemblyAIKey, "function");
  assert.equal(typeof env.saveAssemblyAIKey, "function");
  assert.equal(typeof env.getDeepgramKey, "function");
  assert.equal(typeof env.saveDeepgramKey, "function");
});

test("preload BYOK_KEY_BRIDGES mirror the manifest exactly", () => {
  // preload.js can't require the manifest under sandbox, so it inlines the
  // {base, get, save} tuples. Assert they stay in lockstep with the manifest.
  const preloadSrc = fs.readFileSync(path.join(__dirname, "../../preload.js"), "utf8");
  const block = preloadSrc.match(/BYOK_KEY_BRIDGES = \[([\s\S]*?)\];/);
  assert.ok(block, "BYOK_KEY_BRIDGES declared in preload.js");
  for (const k of BYOK_API_KEYS) {
    const entry = new RegExp(
      `\\{\\s*base:\\s*"${k.base}",\\s*get:\\s*"${k.get}",\\s*save:\\s*"${k.save}",?\\s*\\}`
    );
    assert.match(block[1], entry, `preload mirrors ${k.base}`);
  }
  const bridgeCount = (block[1].match(/base:/g) || []).length;
  assert.equal(bridgeCount, BYOK_API_KEYS.length, "no extra/missing preload bridges");
});

test("settingsStore allowlist mentions every SECRET_ENV_NAMES entry", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../src/stores/settingsStore.ts"), "utf8");
  for (const name of SECRET_ENV_NAMES) {
    assert.ok(src.includes(`"${name}"`), `${name} missing from settingsStore.ts`);
  }
});
