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
function parseEnvLines(buffer) {
  const out = {};
  for (const line of String(buffer).split("\n")) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return fakeElectron;
  if (request === "@napi-rs/keyring") throw new Error("keyring disabled in tests");
  // No .env file is loaded in tests; parse stays real (with a minimal stand-in
  // when node_modules is absent) so the .env round-trip tests read what was written.
  if (request === "dotenv") {
    let real = null;
    try {
      real = origLoad.call(this, request, ...rest);
    } catch {}
    return { config: () => ({}), parse: real ? real.parse : parseEnvLines };
  }
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

test("self-hosted header JSON round-trips through the existing plaintext fallback without dotenv truncation", async () => {
  const serialized = JSON.stringify({
    dictation: [{ name: "X-API-Key", value: "secret#with'quotes\"and\\slashes" }],
    upload: [{ name: "X-Upload", value: "a#b" }],
  });
  const previous = process.env.SELF_HOSTED_STT_HEADERS;
  try {
    const env = new EnvironmentManager();
    env.saveSelfHostedSttHeaders(serialized);
    await env.saveAllKeysToEnvFile();
    const saved = require("dotenv").parse(fs.readFileSync(path.join(tmpUserData, ".env")));
    assert.ok(saved.SELF_HOSTED_STT_HEADERS.startsWith("base64:"));
    process.env.SELF_HOSTED_STT_HEADERS = saved.SELF_HOSTED_STT_HEADERS;
    assert.equal(new EnvironmentManager().getSelfHostedSttHeaders(), serialized);
    await env.saveAllKeysToEnvFile();
    const resaved = require("dotenv").parse(fs.readFileSync(path.join(tmpUserData, ".env")));
    assert.equal(
      resaved.SELF_HOSTED_STT_HEADERS,
      saved.SELF_HOSTED_STT_HEADERS,
      "no double encoding"
    );
  } finally {
    if (previous === undefined) delete process.env.SELF_HOSTED_STT_HEADERS;
    else process.env.SELF_HOSTED_STT_HEADERS = previous;
  }
});

test("settingsStore allowlist mentions every SECRET_ENV_NAMES entry", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../src/stores/settingsStore.ts"), "utf8");
  for (const name of SECRET_ENV_NAMES) {
    assert.ok(src.includes(`"${name}"`), `${name} missing from settingsStore.ts`);
  }
});

test("committing the shown legacy cleanup alias keeps the shell import it names", () => {
  const env = new EnvironmentManager();
  const saved = {
    CUSTOM_CLEANUP_API_KEY: process.env.CUSTOM_CLEANUP_API_KEY,
    CUSTOM_REASONING_API_KEY: process.env.CUSTOM_REASONING_API_KEY,
  };
  try {
    delete process.env.CUSTOM_CLEANUP_API_KEY;
    process.env.CUSTOM_REASONING_API_KEY = "fake-legacy-shell-key";
    env._shellImportedSecrets.add("CUSTOM_REASONING_API_KEY");
    assert.equal(env.getRawCleanupCustomKey(), "$CUSTOM_REASONING_API_KEY");
    assert.equal(env.saveCleanupCustomKey("$CUSTOM_REASONING_API_KEY").success, true);
    assert.equal(process.env.CUSTOM_REASONING_API_KEY, "fake-legacy-shell-key");
    assert.equal(env.getCleanupCustomKey(), "fake-legacy-shell-key");
    // A real new key replaces Cleanup; the shell export is still a valid target.
    env.saveCleanupCustomKey("fake-new-cleanup-key");
    assert.equal(env.resolveSecretRef("$CUSTOM_REASONING_API_KEY"), "fake-legacy-shell-key");
    assert.equal(env.getCleanupCustomKey(), "fake-new-cleanup-key");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

function isolateCleanupSettings(t) {
  const originalEnvironment = process.env;
  process.env = {};
  const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-cleanup-settings-"));
  t.mock.method(fakeElectron.app, "getPath", () => settingsDir);
  t.after(() => {
    process.env = originalEnvironment;
    fs.rmSync(settingsDir, { recursive: true, force: true });
  });
  return new EnvironmentManager();
}

test("clearing legacy Cleanup preserves another scope's reference across a restart", async (t) => {
  const env = isolateCleanupSettings(t);
  process.env.CUSTOM_REASONING_API_KEY = "fake-legacy-shell-key";
  env._shellImportedSecrets.add("CUSTOM_REASONING_API_KEY");
  env.saveCustomTranscriptionKey("${CUSTOM_REASONING_API_KEY}");
  env.saveCleanupCustomKey("");
  assert.equal(env.getRawCleanupCustomKey(), "");
  assert.equal(env.getCleanupCustomKey(), "");
  assert.equal(env.getCustomTranscriptionKey(), "fake-legacy-shell-key");
  const saved = require("dotenv").parse(fs.readFileSync((await env.saveAllKeysToEnvFile()).path));
  assert.equal(saved.CUSTOM_REASONING_API_KEY, undefined);
  process.env = saved;
  EnvironmentManager._resetShellImportedSecrets();
  const restarted = new EnvironmentManager();
  process.env.CUSTOM_REASONING_API_KEY = "rotated-shell-key";
  restarted._shellImportedSecrets.add("CUSTOM_REASONING_API_KEY");
  assert.equal(restarted.getRawCleanupCustomKey(), "");
  assert.equal(restarted.getCustomTranscriptionKey(), "rotated-shell-key");
  restarted.saveCleanupCustomKey("$CUSTOM_REASONING_API_KEY");
  assert.equal(restarted.getCleanupCustomKey(), "rotated-shell-key");
  restarted.saveCleanupCustomKey("$GROQ_API_KEY");
  assert.equal(restarted.getCleanupCustomKey(), "");
  await restarted.clearAllPersistedData();
  assert.equal(restarted.getRawCleanupCustomKey(), "");
  process.env.CUSTOM_REASONING_API_KEY = "new-install-legacy-key";
  assert.equal(restarted.getCleanupCustomKey(), "new-install-legacy-key");
});

test("Cleanup expands the selected shell field's reference once", (t) => {
  const env = isolateCleanupSettings(t);
  process.env.CUSTOM_CLEANUP_API_KEY = "$GROQ_API_KEY";
  process.env.GROQ_API_KEY = "fake-reference-target";
  env._shellImportedSecrets.add("CUSTOM_CLEANUP_API_KEY");
  assert.equal(env.getCleanupCustomKey(), "fake-reference-target");
});

test("a late shell import cannot undo an explicit clear of Cleanup", async (t) => {
  const env = isolateCleanupSettings(t);
  env.saveCleanupCustomKey("");
  process.env.CUSTOM_REASONING_API_KEY = "late-shell-key";
  env._shellImportedSecrets.add("CUSTOM_REASONING_API_KEY");
  assert.equal(env.getRawCleanupCustomKey(), "");
  assert.equal(env.resolveSecretRef("$CUSTOM_REASONING_API_KEY"), "late-shell-key");
  await env.saveAllKeysToEnvFile();
});

test("migration and restart retain encrypted legacy keys referenced by other scopes", async (t) => {
  const env = isolateCleanupSettings(t);
  const crypto = require("../../src/helpers/secretCrypto");
  t.mock.method(crypto, "isAvailable", () => true);
  t.mock.method(crypto, "encrypt", (value) => Buffer.from(value));
  t.mock.method(crypto, "decrypt", (data) => ({ value: data.toString(), needsReencrypt: false }));
  process.env.CUSTOM_REASONING_API_KEY = "legacy-credential";
  process.env.CUSTOM_TRANSCRIPTION_API_KEY = "${CUSTOM_REASONING_API_KEY}";
  await env._migrateToSecureStorage();
  const write = t.mock.method(env, "_saveSecretKey");
  env.saveCleanupCustomKey("new-cleanup");
  await Promise.all(write.mock.calls.map((call) => call.result));
  process.env = {};
  const restarted = new EnvironmentManager();
  await restarted._loadAllSecrets();
  assert.equal(restarted.getCleanupCustomKey(), "new-cleanup");
  assert.equal(restarted.getCustomTranscriptionKey(), "legacy-credential");
  const clear = t.mock.method(restarted, "_saveSecretKey");
  restarted.saveCleanupCustomKey("");
  await Promise.all(clear.mock.calls.map((call) => call.result));
  process.env = require("dotenv").parse(fs.readFileSync((await restarted.saveAllKeysToEnvFile()).path));
  assert.equal(process.env.CUSTOM_REASONING_API_KEY, undefined);
  await restarted._loadAllSecrets();
  assert.equal(restarted.getRawCleanupCustomKey(), "");
  assert.equal(restarted.getCustomTranscriptionKey(), "legacy-credential");
  restarted.saveCustomTranscriptionKey("");
  restarted.saveCleanupCustomKey("replacement");
  await Promise.all(clear.mock.calls.map((call) => call.result));
  process.env = {};
  await restarted._loadAllSecrets();
  assert.equal(restarted.getCleanupCustomKey(), "replacement");
  assert.equal(restarted.resolveSecretRef("$CUSTOM_REASONING_API_KEY"), "");
});

test("the self-hosted headers secret is stored but never a $VAR target or shell import", () => {
  const { NON_REF_SECRET_ENV } = require("../../src/config/secretKeys");
  assert.ok(NON_REF_SECRET_ENV.includes("SELF_HOSTED_STT_HEADERS"));
  assert.equal(SECRET_ENV_NAMES.includes("SELF_HOSTED_STT_HEADERS"), false);
  const previous = process.env.SELF_HOSTED_STT_HEADERS;
  try {
    process.env.SELF_HOSTED_STT_HEADERS = '{"dictation":[],"upload":[]}';
    const env = new EnvironmentManager();
    assert.equal(env.resolveSecretRef("$SELF_HOSTED_STT_HEADERS"), "");
    const result = env.saveCustomTranscriptionKey("$SELF_HOSTED_STT_HEADERS");
    assert.equal(result.success, false);
    assert.equal(result.reason, "unknown-ref");
  } finally {
    if (previous === undefined) delete process.env.SELF_HOSTED_STT_HEADERS;
    else process.env.SELF_HOSTED_STT_HEADERS = previous;
  }
});

test("ElevenLabs key: a $VAR stays raw in Settings and expands only on use", () => {
  const saved = {
    ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  const env = new EnvironmentManager();
  assert.ok(SECRET_ENV_NAMES.includes("ELEVENLABS_API_KEY"));
  process.env.OPENAI_API_KEY = "fake-shared-secret";
  env.saveElevenlabsKey("${OPENAI_API_KEY}");
  assert.equal(env.getRawKey("ELEVENLABS_API_KEY"), "${OPENAI_API_KEY}");
  assert.equal(env.getElevenlabsKey(), "fake-shared-secret");
  // A literal reference to itself is refused and never becomes the credential.
  const refused = env.saveElevenlabsKey("$ELEVENLABS_API_KEY");
  assert.equal(refused.reason, "self-reference");
  delete process.env.OPENAI_API_KEY;
  assert.equal(env.getElevenlabsKey(), "");
  // A secret that merely contains a dollar sign is not a reference.
  env.saveElevenlabsKey("fake$KEY-with-dollar");
  assert.equal(env.getElevenlabsKey(), "fake$KEY-with-dollar");
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
