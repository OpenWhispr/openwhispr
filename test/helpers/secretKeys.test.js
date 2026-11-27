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
  // Only isolated per-test profiles may load dotenv. The shared fixture directory
  // and any developer or packaged profile must never affect a test.
  if (request === "dotenv") {
    let real = null;
    try {
      real = origLoad.call(this, request, ...rest);
    } catch {}
    const parse = real ? real.parse : parseEnvLines;
    return {
      parse,
      config: (options) => {
        const profile = fakeElectron.app.getPath("userData");
        if (profile === tmpUserData || options.path !== path.join(profile, ".env")) return {};
        const parsed = parse(fs.readFileSync(options.path));
        for (const [name, value] of Object.entries(parsed)) {
          if (options.override || !Object.hasOwn(process.env, name)) process.env[name] = value;
        }
        return { parsed };
      },
    };
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

test("Corti runtime credentials trim shell padding and treat a blank export as missing", (t) => {
  const env = new EnvironmentManager();
  t.mock.method(env, "_getRawKey", () => "$GROQ_API_KEY");
  const previous = process.env.GROQ_API_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previous;
  });
  process.env.GROQ_API_KEY = "  fixture-id\n";
  assert.equal(env.getCortiClientId(), "fixture-id");
  process.env.GROQ_API_KEY = "   ";
  assert.equal(env.getCortiClientSecret(), "");
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

function importFixtureShell(t, values) {
  const shell = require("../../src/helpers/envKeyResolve");
  const importMissing = shell.importMissingSecretsFromLoginShell;
  const records = Object.entries(values)
    .map(([name, value]) => `${name}=${value}\0`)
    .join("");
  t.mock.method(shell, "importMissingSecretsFromLoginShell", (options) =>
    importMissing({
      ...options,
      platform: "linux",
      passwdShell: "/bin/bash",
      existsSync: () => true,
      execFile: async () => ({ stdout: `${shell.ENV_EXPORT_SENTINEL}\n${records}` }),
    })
  );
}

test("a configured legacy Cleanup key takes precedence over a shell-only canonical key", async (t) => {
  const env = isolateCleanupSettings(t);
  process.env.CUSTOM_REASONING_API_KEY = "profile-account";
  importFixtureShell(t, { CUSTOM_CLEANUP_API_KEY: "shell-account" });
  await env._importLoginShellSecrets();
  assert.equal(env.getRawCleanupCustomKey(), "profile-account");
  assert.equal(env.getCleanupCustomKey(), "profile-account");
  assert.equal(env.resolveSecretRef("$CUSTOM_CLEANUP_API_KEY"), "shell-account");
  env.saveCleanupCustomKey(env.getRawCleanupCustomKey());
  assert.equal(env.getCleanupCustomKey(), "profile-account");
  assert.equal(env.resolveSecretRef("$CUSTOM_CLEANUP_API_KEY"), "shell-account");
});

test("an unreadable canonical Cleanup key does not redirect requests to a shell-only legacy key", async (t) => {
  const env = isolateCleanupSettings(t);
  const crypto = require("../../src/helpers/secretCrypto");
  const decrypt = t.mock.method(crypto, "decrypt", () => {
    throw new Error("locked");
  });
  const slot = env._getSecretFilePath("CUSTOM_CLEANUP_API_KEY");
  fs.mkdirSync(path.dirname(slot), { recursive: true });
  fs.writeFileSync(slot, "profile-account");
  importFixtureShell(t, { CUSTOM_REASONING_API_KEY: "shell-account" });
  await env._loadAllSecrets();
  await env._importLoginShellSecrets();
  assert.equal(env.getCleanupCustomKey(), "");
  assert.equal(env.getRawCleanupCustomKey(), "");
  assert.equal(env.resolveSecretRef("$CUSTOM_REASONING_API_KEY"), "shell-account");
  decrypt.mock.mockImplementation((blob) => ({ value: blob.toString(), needsReencrypt: false }));
  await env._loadAllSecrets();
  assert.equal(env.getCleanupCustomKey(), "profile-account");
});

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
  process.env.CUSTOM_CLEANUP_API_KEY = "  $GROQ_API_KEY  ";
  process.env.GROQ_API_KEY = "fake-reference-target";
  env._shellImportedSecrets.add("CUSTOM_CLEANUP_API_KEY");
  assert.equal(env.getCleanupCustomKey(), "fake-reference-target");
  const shown = env.getRawCleanupCustomKey();
  assert.equal(shown, "$GROQ_API_KEY");
  assert.equal(env.resolveSecretRef(shown), "fake-reference-target");
  env.saveCleanupCustomKey(shown);
  assert.equal(env._shellImportedSecrets.has("CUSTOM_CLEANUP_API_KEY"), true);
  env.saveCustomTranscriptionKey("$CUSTOM_CLEANUP_API_KEY");
  assert.equal(env.getCustomTranscriptionKey(), "");
  process.env.GROQ_API_KEY = "$OPENAI_API_KEY";
  assert.equal(env.resolveSecretRef(shown), "");
});

test("cross-scope startup seeding retains a destination imported after its initial read", (t) => {
  const env = isolateCleanupSettings(t);
  process.env.OPENROUTER_API_KEY = "shell-router";
  env._shellImportedSecrets.add("OPENROUTER_API_KEY");
  const result = env.saveOpenrouterKey("older-custom", "if-empty");
  assert.equal(result.retained, "$OPENROUTER_API_KEY");
  assert.equal(env.getOpenrouterKey(), "shell-router");
  assert.ok(env._shellImportedSecrets.has("OPENROUTER_API_KEY"));
});

test("an acknowledged migration survives restart with the plaintext fallback", async (t) => {
  const env = isolateCleanupSettings(t);
  const file = path.join(fakeElectron.app.getPath("userData"), ".env");
  fs.writeFileSync(file, "# Existing user configuration\nUNRELATED_FLAG=keep\n");
  process.env.GROQ_API_KEY = "launcher-only";
  assert.deepEqual(await env.saveOpenrouterKey("from-legacy#custom", "if-empty"), { success: true });
  process.env = require("dotenv").parse(fs.readFileSync(file));
  assert.equal(process.env.UNRELATED_FLAG, "keep");
  assert.equal(process.env.GROQ_API_KEY, undefined);
  EnvironmentManager._resetShellImportedSecrets();
  assert.equal(new EnvironmentManager().getOpenrouterKey(), "from-legacy#custom");
});

test("a migration blocked by storage failure preserves the displaced shell alias for a retry", async (t) => {
  const env = isolateCleanupSettings(t);
  process.env.TRANSLATION_CUSTOM_API_KEY = "shell-translation";
  env._shellImportedSecrets.add("TRANSLATION_CUSTOM_API_KEY");
  const write = t.mock.method(env, "_persistMigratedPlaintext", async () => { throw new Error("disk full"); });
  assert.equal((await env.saveTranslationCustomKey("older-user-setting", true)).success, false);
  assert.equal(env.getRawKey("TRANSLATION_CUSTOM_API_KEY"), "$TRANSLATION_CUSTOM_API_KEY");
  assert.equal(env.getTranslationCustomKey(), "shell-translation");
  write.mock.restore();
  assert.deepEqual(await env.saveTranslationCustomKey("older-user-setting", true), { success: true });
});

test("concurrent migrations observe the same disk failure and a later user edit survives it", async (t) => {
  const env = isolateCleanupSettings(t);
  let rejectWrite;
  t.mock.method(env, "_persistMigratedPlaintext", () =>
    new Promise((_resolve, reject) => { rejectWrite = reject; })
  );
  const first = env.saveOpenrouterKey("upgrade-source", "if-empty");
  const second = env.saveOpenrouterKey("another-window", "if-empty");
  env.saveOpenrouterKey("user-edit");
  rejectWrite(new Error("disk full"));
  assert.equal((await first).success, false);
  assert.equal((await second).success, false);
  assert.equal(env.getOpenrouterKey(), "user-edit");
});

test("an unreadable encrypted upgrade slot survives conditional migration until the store recovers", async (t) => {
  const env = isolateCleanupSettings(t);
  const crypto = require("../../src/helpers/secretCrypto");
  t.mock.method(crypto, "isAvailable", () => true);
  t.mock.method(crypto, "encrypt", (value) => Buffer.from(value));
  const decrypt = t.mock.method(crypto, "decrypt", () => { throw new Error("locked"); });
  const slot = env._getSecretFilePath("TRANSLATION_CUSTOM_API_KEY");
  fs.mkdirSync(path.dirname(slot), { recursive: true });
  fs.writeFileSync(slot, "encrypted-old-setting");
  await env._loadAllSecrets();
  const shell = require("../../src/helpers/envKeyResolve");
  const importMissing = shell.importMissingSecretsFromLoginShell;
  t.mock.method(shell, "importMissingSecretsFromLoginShell", (options) =>
    importMissing({
      ...options,
      platform: "linux",
      passwdShell: "/bin/bash",
      existsSync: () => true,
      execFile: async () => ({
        stdout: shell.ENV_EXPORT_SENTINEL +
          "\nTRANSLATION_CUSTOM_API_KEY=wrong-shell-account\0GROQ_API_KEY=shell-account\0",
      }),
    })
  );
  assert.deepEqual(await env._importLoginShellSecrets(), ["GROQ_API_KEY"]);
  assert.equal(env.getTranslationCustomKey(), "");
  process.env.TRANSLATION_CUSTOM_API_KEY = "inherited-value";
  await env._loadAllSecrets();
  assert.equal(env.getTranslationCustomKey(), "inherited-value");
  assert.equal((await env.saveTranslationCustomKey("stale-upgrade-copy", true)).success, false);
  assert.equal(fs.readFileSync(slot, "utf8"), "encrypted-old-setting");
  decrypt.mock.mockImplementation((blob) => ({ value: blob.toString(), needsReencrypt: false }));
  await env._loadAllSecrets();
  assert.deepEqual(await env._importLoginShellSecrets(), []);
  assert.equal(env.getTranslationCustomKey(), "encrypted-old-setting");
});

test("a migrated renderer password replaces a shell alias even when their spelling matches", async (t) => {
  const env = isolateCleanupSettings(t);
  process.env.TRANSLATION_CUSTOM_API_KEY = "$GROQ_API_KEY";
  process.env.GROQ_API_KEY = "fixture-target";
  env._shellImportedSecrets.add("TRANSLATION_CUSTOM_API_KEY");
  const alias = env.getRawKey("TRANSLATION_CUSTOM_API_KEY");
  env.saveTranslationCustomKey(alias);
  assert.ok(env._shellImportedSecrets.has("TRANSLATION_CUSTOM_API_KEY"));
  const marker = "$TRANSLATION_CUSTOM_API_KEY";
  assert.deepEqual(await env.saveTranslationCustomKey(alias, true), {
    success: true,
    stored: marker,
  });
  assert.equal(env._shellImportedSecrets.has("TRANSLATION_CUSTOM_API_KEY"), false);
  const retained = env.saveTranslationCustomKey("stale-local-copy", true);
  assert.equal(retained.retained, marker);
  process.env = require("dotenv").parse(fs.readFileSync((await env.saveAllKeysToEnvFile()).path));
  EnvironmentManager._resetShellImportedSecrets();
  const restarted = new EnvironmentManager();
  assert.equal(restarted.getTranslationCustomKey(), alias);
  assert.equal(restarted.getRawKey("TRANSLATION_CUSTOM_API_KEY"), marker);
  restarted.saveTranslationCustomKey("");
  const delayedMigration = restarted.saveTranslationCustomKey("stale-local-copy", true);
  assert.equal(delayedMigration.retained, "");
  assert.equal(restarted.getRawKey("TRANSLATION_CUSTOM_API_KEY"), "");
});

test("an untagged encrypted password stays literal after a locked upgrade and a restart", async (t) => {
  const env = isolateCleanupSettings(t);
  const crypto = require("../../src/helpers/secretCrypto");
  const slot = env._getSecretFilePath("OPENAI_API_KEY");
  fs.mkdirSync(path.dirname(slot), { recursive: true });
  fs.writeFileSync(env._getMigrationSentinelPath(), "");
  fs.writeFileSync(slot, "vault:${GROQ_API_KEY}");
  let locked = true;
  t.mock.method(crypto, "isAvailable", () => !locked);
  t.mock.method(crypto, "encrypt", (value) => Buffer.from(`vault:${value}`));
  t.mock.method(crypto, "decrypt", (blob) => {
    if (locked || !blob.toString().startsWith("vault:")) throw new Error("unavailable");
    return { value: blob.toString().slice(6), needsReencrypt: false };
  });
  importFixtureShell(t, {});
  await env.init();
  assert.equal(env.getOpenAIKey(), "");
  assert.equal((await env.saveOpenAIKey("stale-mirror", true)).success, false);
  assert.equal(fs.readFileSync(slot, "utf8"), "vault:${GROQ_API_KEY}");

  locked = false;
  process.env = { GROQ_API_KEY: "different-account" };
  EnvironmentManager._resetShellImportedSecrets();
  const unlocked = new EnvironmentManager();
  await unlocked.init();
  assert.equal(unlocked.getRawKey("OPENAI_API_KEY"), "$OPENAI_API_KEY");
  assert.equal(unlocked.getOpenAIKey(), "${GROQ_API_KEY}");
  assert.equal(unlocked.resolveSecretRef("$OPENAI_API_KEY"), "${GROQ_API_KEY}");
  assert.deepEqual(unlocked.saveOpenAIKey("$OPENAI_API_KEY"), { success: true });
  const write = t.mock.method(unlocked, "_saveSecretKey");
  unlocked.saveCustomTranscriptionKey("$OPENAI_API_KEY");
  await write.mock.calls[0].result;
  assert.equal(unlocked.getCustomTranscriptionKey(), "${GROQ_API_KEY}");
  assert.equal(unlocked.resolveSecretRef("$CUSTOM_TRANSCRIPTION_API_KEY"), "");
  await unlocked.saveChatAgentCustomKey("${GROQ_API_KEY}", true);
  assert.deepEqual(
    await unlocked.saveDictationAgentCustomKey("$CHAT_AGENT_CUSTOM_API_KEY", "if-empty"),
    {
      success: true,
      stored: "$DICTATION_AGENT_CUSTOM_API_KEY",
    }
  );

  // Editing the old field explicitly may use the exact spelling of its former
  // password as a new reference. A seeded scope keeps its old password.
  unlocked.saveOpenAIKey("${GROQ_API_KEY}");
  await write.mock.calls.at(-1).result;
  process.env = { GROQ_API_KEY: "next-account" };
  EnvironmentManager._resetShellImportedSecrets();
  const restarted = new EnvironmentManager();
  await restarted.init();
  assert.equal(restarted.getRawKey("OPENAI_API_KEY"), "${GROQ_API_KEY}");
  assert.equal(restarted.getOpenAIKey(), "next-account");
  assert.equal(restarted.getCustomTranscriptionKey(), "");
  assert.equal(restarted.getDictationAgentCustomKey(), "${GROQ_API_KEY}");
});

test("startup seeding keeps an explicit source reference live when its target contains an old literal", async (t) => {
  const env = isolateCleanupSettings(t);
  await env.saveOpenAIKey("$OLD_PASSWORD", true);
  env.saveChatAgentCustomKey("$OPENAI_API_KEY");
  env.saveCleanupCustomKey("$OPENAI_API_KEY");
  await env.saveDictationAgentCustomKey(env.getRawKey("CHAT_AGENT_CUSTOM_API_KEY"), "if-empty");
  await env.saveOpenrouterKey(env.getRawCleanupCustomKey(), "if-empty");
  assert.equal(env.getDictationAgentCustomKey(), "$OLD_PASSWORD");
  assert.equal(env.getOpenrouterKey(), "$OLD_PASSWORD");
  env.saveOpenAIKey("rotated-account");
  assert.equal(env.getDictationAgentCustomKey(), "rotated-account");
  assert.equal(env.getOpenrouterKey(), "rotated-account");
  assert.equal(env.getRawKey("DICTATION_AGENT_CUSTOM_API_KEY"), "$OPENAI_API_KEY");
  assert.equal(env.getRawKey("OPENROUTER_API_KEY"), "$OPENAI_API_KEY");
});

test("recovering an old Cleanup mirror preserves its configured legacy name or a previous clear", async (t) => {
  const env = isolateCleanupSettings(t);
  const profile = path.join(fakeElectron.app.getPath("userData"), ".env");
  fs.writeFileSync(profile, "CUSTOM_REASONING_API_KEY=$OLD_PASSWORD\n");
  env.loadEnvironmentVariables();
  assert.deepEqual(await env.saveCleanupCustomKey("$STALE_MIRROR", true), {
    success: true,
    retained: "$CUSTOM_REASONING_API_KEY",
  });
  assert.equal(env.getCleanupCustomKey(), "$OLD_PASSWORD");
  assert.deepEqual(await env.saveOpenrouterKey(env.getRawCleanupCustomKey(), "if-empty"), {
    success: true,
    stored: "$OPENROUTER_API_KEY",
  });
  await env.saveCleanupCustomKey("");
  await env.saveAllKeysToEnvFile();
  assert.deepEqual(await env.saveCleanupCustomKey("$STALE_MIRROR", true), {
    success: true,
    retained: "",
  });
  assert.equal(env.getOpenrouterKey(), "$OLD_PASSWORD");
});

test("explicit reference and literal edits replace locked slots before the next profile flush", async (t) => {
  const env = isolateCleanupSettings(t);
  const slot = env._getSecretFilePath("CUSTOM_TRANSCRIPTION_API_KEY");
  fs.mkdirSync(path.dirname(slot), { recursive: true });
  fs.writeFileSync(env._getMigrationSentinelPath(), "");
  fs.writeFileSync(slot, "vault:$OLD_PASSWORD");
  fs.writeFileSync(env._getSecretFilePath("OPENAI_API_KEY"), "vault:old-account");
  const crypto = require("../../src/helpers/secretCrypto");
  let locked = true;
  t.mock.method(crypto, "isAvailable", () => !locked);
  t.mock.method(crypto, "encrypt", (value) => Buffer.from(`vault:${value}`));
  t.mock.method(crypto, "decrypt", (blob) => {
    if (locked || !blob.toString().startsWith("vault:")) throw new Error("locked");
    return { value: blob.toString().slice(6), needsReencrypt: false };
  });
  importFixtureShell(t, {});
  await env.init();
  assert.deepEqual(await env.saveCustomTranscriptionKey("$GROQ_API_KEY"), { success: true });
  assert.deepEqual(await env.saveOpenAIKey("new-literal-account"), { success: true });
  process.env = { GROQ_API_KEY: "new-account" };
  EnvironmentManager._resetShellImportedSecrets();
  locked = false;
  const restarted = new EnvironmentManager();
  await restarted.init();
  assert.equal(restarted.getRawKey("CUSTOM_TRANSCRIPTION_API_KEY"), "$GROQ_API_KEY");
  assert.equal(restarted.getCustomTranscriptionKey(), "new-account");
  assert.equal(restarted.getOpenAIKey(), "new-literal-account");
  const { path: profile } = await restarted.saveAllKeysToEnvFile();
  assert.doesNotMatch(fs.readFileSync(profile, "utf8"), /CUSTOM_TRANSCRIPTION_API_KEY/);
  process.env = { GROQ_API_KEY: "rotated-account" };
  EnvironmentManager._resetShellImportedSecrets();
  const encryptedAgain = new EnvironmentManager();
  await encryptedAgain.init();
  assert.equal(encryptedAgain.getCustomTranscriptionKey(), "rotated-account");
  assert.equal(encryptedAgain.getOpenAIKey(), "new-literal-account");
});

test("old plaintext literals and newly saved references retain separate meanings during promotion", async (t) => {
  const initial = isolateCleanupSettings(t);
  const profile = path.join(fakeElectron.app.getPath("userData"), ".env");
  fs.writeFileSync(profile, "OPENAI_API_KEY=$GROQ_API_KEY\nGROQ_API_KEY=other-account\n");
  const crypto = require("../../src/helpers/secretCrypto");
  let available = false;
  t.mock.method(crypto, "isAvailable", () => available);
  t.mock.method(crypto, "encrypt", (value) => {
    if (!available) throw new Error("unavailable");
    return Buffer.from(`vault:${value}`);
  });
  t.mock.method(crypto, "decrypt", (blob) => ({
    value: blob.toString().slice(6),
    needsReencrypt: false,
  }));
  importFixtureShell(t, {});
  const locked = new EnvironmentManager();
  await locked.init();
  assert.equal(locked.getOpenAIKey(), "$GROQ_API_KEY");
  assert.equal(locked.getRawKey("OPENAI_API_KEY"), "$OPENAI_API_KEY");
  locked.saveCustomTranscriptionKey("$GROQ_API_KEY");
  await locked.saveAllKeysToEnvFile();
  const parsed = require("dotenv").parse(fs.readFileSync(profile));
  assert.equal(parsed.OPENWHISPR_REF_OPENAI_API_KEY, undefined);
  assert.equal(parsed.OPENWHISPR_REF_CUSTOM_TRANSCRIPTION_API_KEY, "GROQ_API_KEY");
  process.env = {};
  EnvironmentManager._resetShellImportedSecrets();
  available = true;
  const recovered = new EnvironmentManager();
  await recovered.init();
  assert.equal(recovered.getCustomTranscriptionKey(), "other-account");
  assert.equal(recovered.getOpenAIKey(), "$GROQ_API_KEY");
  assert.equal(recovered.resolveSecretRef("$OPENAI_API_KEY"), "$GROQ_API_KEY");
  assert.ok(fs.existsSync(initial._getMigrationSentinelPath()));
  assert.doesNotMatch(fs.readFileSync(profile, "utf8"), /OPENWHISPR_REF_|OPENAI_API_KEY=/);
  process.env = {};
  EnvironmentManager._resetShellImportedSecrets();
  const restarted = new EnvironmentManager();
  await restarted.init();
  assert.equal(restarted.getRawKey("OPENAI_API_KEY"), "$OPENAI_API_KEY");
  assert.equal(restarted.getRawKey("CUSTOM_TRANSCRIPTION_API_KEY"), "$GROQ_API_KEY");
  assert.equal(restarted.getOpenAIKey(), "$GROQ_API_KEY");
  assert.equal(restarted.getCustomTranscriptionKey(), "other-account");
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

test("a legacy renderer password named for the Cleanup alias survives a restart literally", async (t) => {
  const env = isolateCleanupSettings(t);
  const crypto = require("../../src/helpers/secretCrypto");
  t.mock.method(crypto, "isAvailable", () => true);
  t.mock.method(crypto, "encrypt", (value) => Buffer.from(value));
  t.mock.method(crypto, "decrypt", (blob) => ({ value: blob.toString(), needsReencrypt: false }));
  process.env.CUSTOM_REASONING_API_KEY = "profile-cleanup";
  await env._migrateToSecureStorage();
  // Main initializes before renderer localStorage is available.
  await env.saveTranslationCustomKey("$CUSTOM_REASONING_API_KEY", true);
  assert.equal(env.getTranslationCustomKey(), "$CUSTOM_REASONING_API_KEY");
  process.env = {};
  EnvironmentManager._resetShellImportedSecrets();
  const restarted = new EnvironmentManager();
  await restarted._loadAllSecrets();
  assert.equal(restarted.getCleanupCustomKey(), "profile-cleanup");
  assert.equal(restarted.getTranslationCustomKey(), "$CUSTOM_REASONING_API_KEY");
});

test("interrupted migration preserves an existing encrypted slot when the keyring is locked", async (t) => {
  const env = isolateCleanupSettings(t);
  const crypto = require("../../src/helpers/secretCrypto");
  t.mock.method(crypto, "isAvailable", () => true);
  t.mock.method(crypto, "encrypt", (value) => Buffer.from(value));
  const decrypt = t.mock.method(crypto, "decrypt", () => { throw new Error("locked"); });
  const slot = env._getSecretFilePath("OPENAI_API_KEY");
  fs.mkdirSync(path.dirname(slot), { recursive: true });
  fs.writeFileSync(slot, "encrypted-user-setting");
  process.env.OPENAI_API_KEY = "older-copy";
  await env._migrateToSecureStorage();
  assert.equal(fs.readFileSync(slot, "utf8"), "encrypted-user-setting");
  assert.equal(fs.existsSync(env._getMigrationSentinelPath()), false);
  decrypt.mock.mockImplementation((blob) => ({ value: blob.toString(), needsReencrypt: false }));
  await env._migrateToSecureStorage();
  await env._loadAllSecrets();
  assert.equal(env.getOpenAIKey(), "encrypted-user-setting");
});

test("a rotation saved in the profile during interrupted migration survives vault recovery", async (t) => {
  const env = isolateCleanupSettings(t);
  const crypto = require("../../src/helpers/secretCrypto");
  const slot = env._getSecretFilePath("OPENAI_API_KEY");
  fs.mkdirSync(path.dirname(slot), { recursive: true });
  fs.writeFileSync(slot, "older-account");
  // The older release wrote locked-vault edits to the profile only.
  const file = path.join(fakeElectron.app.getPath("userData"), ".env");
  fs.writeFileSync(file, "OPENAI_API_KEY=rotated-account\n");
  env.loadEnvironmentVariables();
  // A restored backup may make the ciphertext appear newer than the edited profile.
  fs.utimesSync(file, new Date(1), new Date(1));
  assert.equal(require("dotenv").parse(fs.readFileSync(file)).OPENAI_API_KEY, "rotated-account");
  EnvironmentManager._resetShellImportedSecrets();
  t.mock.method(crypto, "isAvailable", () => true);
  t.mock.method(crypto, "encrypt", (value) => Buffer.from(value));
  t.mock.method(crypto, "decrypt", (blob) => ({ value: blob.toString(), needsReencrypt: false }));
  await env._migrateToSecureStorage();
  process.env = {};
  await env._loadAllSecrets();
  assert.equal(env.getOpenAIKey(), "rotated-account");
  assert.equal(require("dotenv").parse(fs.readFileSync(file)).OPENAI_API_KEY, undefined);
});

test("a completed migration promotes a fallback scope key before stripping it from the profile", async (t) => {
  const env = isolateCleanupSettings(t);
  const crypto = require("../../src/helpers/secretCrypto");
  fs.mkdirSync(env._getSecureKeysDir(), { recursive: true });
  fs.writeFileSync(env._getMigrationSentinelPath(), "");
  assert.equal((await env.saveTranslationCustomKey("$GROQ_API_KEY", "if-empty")).success, true);
  const file = path.join(fakeElectron.app.getPath("userData"), ".env");
  const saved = () => require("dotenv").parse(fs.readFileSync(file)).TRANSLATION_CUSTOM_API_KEY;
  assert.equal(saved(), "$GROQ_API_KEY");
  t.mock.method(crypto, "isAvailable", () => true);
  t.mock.method(crypto, "encrypt", (value) => Buffer.from(value));
  const decrypt = t.mock.method(crypto, "decrypt", () => {
    throw new Error("verification failed");
  });
  process.env.DICTATION_KEY = "Alt+X";
  await env.saveAllKeysToEnvFile();
  assert.equal(saved(), "$GROQ_API_KEY");
  assert.equal(require("dotenv").parse(fs.readFileSync(file)).DICTATION_KEY, "Alt+X");
  assert.equal(fs.existsSync(env._getSecretFilePath("TRANSLATION_CUSTOM_API_KEY")), false);
  decrypt.mock.mockImplementation((blob) => ({ value: blob.toString(), needsReencrypt: false }));
  process.env.GROQ_API_KEY = "launcher-account";
  await env.saveAllKeysToEnvFile();
  assert.equal(saved(), undefined);
  assert.equal(fs.existsSync(env._getSecretFilePath("GROQ_API_KEY")), false);
  process.env = { GROQ_API_KEY: "second-launch-account" };
  EnvironmentManager._resetShellImportedSecrets();
  await env._loadAllSecrets();
  assert.equal(env.getRawKey("TRANSLATION_CUSTOM_API_KEY"), "$GROQ_API_KEY");
  assert.equal(env.getTranslationCustomKey(), "second-launch-account");
});

test("one unreadable slot does not undo another field's newer plaintext rotation", async (t) => {
  const env = isolateCleanupSettings(t);
  const crypto = require("../../src/helpers/secretCrypto");
  fs.mkdirSync(env._getSecureKeysDir(), { recursive: true });
  fs.writeFileSync(env._getSecretFilePath("OPENAI_API_KEY"), "locked-slot");
  const groq = env._getSecretFilePath("GROQ_API_KEY");
  fs.writeFileSync(groq, "previous-groq");
  const file = path.join(fakeElectron.app.getPath("userData"), ".env");
  fs.writeFileSync(file, "GROQ_API_KEY=rotated-groq\n");
  process.env.GROQ_API_KEY = "rotated-groq";
  t.mock.method(crypto, "isAvailable", () => true);
  t.mock.method(crypto, "encrypt", (value) => Buffer.from(value));
  t.mock.method(crypto, "decrypt", (blob) => {
    if (blob.toString() === "locked-slot") throw new Error("locked");
    return { value: blob.toString(), needsReencrypt: false };
  });
  importFixtureShell(t, {});
  await env.init();
  assert.equal(env.getGroqKey(), "rotated-groq");
  assert.equal(fs.readFileSync(groq, "utf8"), "rotated-groq");
  assert.equal(fs.existsSync(env._getMigrationSentinelPath()), false);
  await env.saveAllKeysToEnvFile();
  assert.equal(require("dotenv").parse(fs.readFileSync(file)).GROQ_API_KEY, "rotated-groq");
});

test("a queued fallback migration preserves an encrypted destination that appeared after its initial read", async (t) => {
  const env = isolateCleanupSettings(t);
  const slot = env._getSecretFilePath("TRANSLATION_CUSTOM_API_KEY");
  fs.mkdirSync(path.dirname(slot), { recursive: true });
  const migration = env.saveTranslationCustomKey("source", "if-empty");
  fs.writeFileSync(slot, "pre-existing-account");
  assert.equal((await migration).success, false);
  assert.equal(fs.readFileSync(slot, "utf8"), "pre-existing-account");
  assert.equal(fs.existsSync(path.join(fakeElectron.app.getPath("userData"), ".env")), false);
});

test("recovery retains the effective fallback over stale ciphertext and a concurrent edit wins", async (t) => {
  const env = isolateCleanupSettings(t);
  const crypto = require("../../src/helpers/secretCrypto");
  const slot = env._getSecretFilePath("TRANSLATION_CUSTOM_API_KEY");
  fs.mkdirSync(path.dirname(slot), { recursive: true });
  fs.writeFileSync(env._getMigrationSentinelPath(), "");
  assert.ok((await env.saveTranslationCustomKey("effective-fallback", true)).success);
  fs.writeFileSync(slot, "stale-ciphertext");
  t.mock.method(crypto, "isAvailable", () => true);
  t.mock.method(crypto, "encrypt", (value) => Buffer.from(value));
  const decrypt = t.mock.method(crypto, "decrypt", (blob) => ({
    value: blob.toString(),
    needsReencrypt: false,
  }));
  await env.saveAllKeysToEnvFile();
  assert.equal(fs.readFileSync(slot, "utf8"), "effective-fallback");

  // A concurrent explicit edit during verification must be written after the recovery.
  const file = path.join(fakeElectron.app.getPath("userData"), ".env");
  fs.writeFileSync(file, "TRANSLATION_CUSTOM_API_KEY=effective-fallback\n");
  const write = t.mock.method(env, "_saveSecretKey");
  decrypt.mock.mockImplementationOnce((blob) => {
    env.saveTranslationCustomKey("latest-edit");
    return { value: blob.toString(), needsReencrypt: false };
  });
  await env.saveAllKeysToEnvFile();
  await Promise.all(write.mock.calls.map(({ result }) => result));
  assert.equal(env.getTranslationCustomKey(), "latest-edit");
  assert.equal(fs.readFileSync(slot, "utf8"), "latest-edit");
});

test("an old encrypted format is re-encrypted on load without changing its value", async (t) => {
  const env = isolateCleanupSettings(t);
  const crypto = require("../../src/helpers/secretCrypto");
  const slot = env._getSecretFilePath("TRANSLATION_CUSTOM_API_KEY");
  fs.mkdirSync(path.dirname(slot), { recursive: true });
  fs.writeFileSync(slot, "old:active-value");
  t.mock.method(crypto, "encrypt", (value) => Buffer.from(`new:${value}`));
  t.mock.method(crypto, "decrypt", (blob) => ({
    value: blob.toString().slice(4),
    needsReencrypt: blob.toString().startsWith("old:"),
  }));
  await env._loadAllSecrets();
  assert.equal(env.getTranslationCustomKey(), "active-value");
  assert.equal(fs.readFileSync(slot, "utf8"), "new:active-value");
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

test("a locked clear removes every persisted copy and blocks a stale renderer migration after restart", async (t) => {
  const env = isolateCleanupSettings(t);
  const crypto = require("../../src/helpers/secretCrypto");
  const slot = env._getSecretFilePath("TRANSLATION_CUSTOM_API_KEY");
  const file = path.join(fakeElectron.app.getPath("userData"), ".env");
  fs.mkdirSync(path.dirname(slot), { recursive: true });
  fs.writeFileSync(slot, "account-before-clear");
  fs.writeFileSync(env._getMigrationSentinelPath(), "");
  const unrelated = '# untouched\nUNRELATED="line one\nTRANSLATION_CUSTOM_API_KEY=part-of-value"\n';
  fs.writeFileSync(
    file,
    unrelated +
      "export TRANSLATION_CUSTOM_API_KEY='first\nsecond'\nOPENWHISPR_REF_TRANSLATION_CUSTOM_API_KEY=GROQ_API_KEY\nTRANSLATION_CUSTOM_API_KEY=duplicate\n"
  );
  process.env.TRANSLATION_CUSTOM_API_KEY = "duplicate";
  const decrypt = t.mock.method(crypto, "decrypt", () => {
    throw new Error("locked");
  });
  await env._loadAllSecrets();
  assert.equal((await env.saveTranslationCustomKey("")).success, true);
  assert.equal(fs.readFileSync(file, "utf8"), unrelated);
  assert.ok(!fs.readFileSync(slot).includes(Buffer.from("account-before-clear")));
  process.env = require("dotenv").parse(fs.readFileSync(file));
  process.env.TRANSLATION_CUSTOM_API_KEY = "launcher-account";
  EnvironmentManager._resetShellImportedSecrets();
  const restarted = new EnvironmentManager();
  await restarted._loadAllSecrets();
  importFixtureShell(t, {
    TRANSLATION_CUSTOM_API_KEY: "shell-account",
    GROQ_API_KEY: "independent-shell-account",
  });
  await restarted._importLoginShellSecrets();
  assert.equal(restarted.getTranslationCustomKey(), "");
  assert.equal(restarted.getGroqKey(), "independent-shell-account");
  assert.deepEqual(await restarted.saveTranslationCustomKey("stale-renderer-copy", true), {
    success: true,
    retained: "",
  });
  assert.equal((await restarted.saveTranslationCustomKey("different-account")).success, true);
  process.env = require("dotenv").parse(fs.readFileSync(file));
  EnvironmentManager._resetShellImportedSecrets();
  t.mock.method(crypto, "isAvailable", () => true);
  t.mock.method(crypto, "encrypt", (value) => Buffer.from(value));
  decrypt.mock.mockImplementation((blob) => ({ value: blob.toString(), needsReencrypt: false }));
  const unlocked = new EnvironmentManager();
  await unlocked._loadAllSecrets();
  assert.equal(unlocked.getTranslationCustomKey(), "different-account");
  await unlocked.saveAllKeysToEnvFile();
  process.env = {};
  await unlocked._loadAllSecrets();
  assert.equal(unlocked.getTranslationCustomKey(), "different-account");
});

test("a failed locked clear keeps its fallback and ciphertext for retry", async (t) => {
  const env = isolateCleanupSettings(t);
  const slot = env._getSecretFilePath("OPENAI_API_KEY");
  const file = path.join(fakeElectron.app.getPath("userData"), ".env");
  fs.mkdirSync(path.dirname(slot), { recursive: true });
  fs.writeFileSync(slot, "original-ciphertext");
  fs.writeFileSync(file, "OPENAI_API_KEY=working-fallback\n");
  process.env.OPENAI_API_KEY = "working-fallback";
  const fsp = require("node:fs/promises");
  const rename = fsp.rename;
  const fault = t.mock.method(fsp, "rename", async (from, to) => {
    if (to === slot) throw new Error("slot unavailable");
    return rename(from, to);
  });
  assert.equal((await env.saveOpenAIKey("")).success, false);
  assert.equal(env.getOpenAIKey(), "working-fallback");
  assert.equal(fs.readFileSync(file, "utf8"), "OPENAI_API_KEY=working-fallback\n");
  assert.equal(fs.readFileSync(slot, "utf8"), "original-ciphertext");
  fault.mock.restore();
  assert.equal((await env.saveOpenAIKey("")).success, true);
});

test("clearing locked Cleanup keeps an explicit reference to its legacy source working", async (t) => {
  const env = isolateCleanupSettings(t);
  const legacy = env._getSecretFilePath("CUSTOM_REASONING_API_KEY");
  const file = path.join(fakeElectron.app.getPath("userData"), ".env");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, "encrypted-legacy-account");
  fs.writeFileSync(
    file,
    "CUSTOM_REASONING_API_KEY=transcription-account\nCUSTOM_TRANSCRIPTION_API_KEY=$CUSTOM_REASONING_API_KEY\nOPENWHISPR_REF_CUSTOM_TRANSCRIPTION_API_KEY=CUSTOM_REASONING_API_KEY\n"
  );
  env.loadEnvironmentVariables();
  assert.equal(env.getCleanupCustomKey(), "transcription-account");
  assert.equal((await env.saveCleanupCustomKey("")).success, true);
  process.env = {};
  EnvironmentManager._resetShellImportedSecrets();
  const restarted = new EnvironmentManager();
  t.mock.method(require("../../src/helpers/secretCrypto"), "decrypt", () => {
    throw new Error("locked");
  });
  await restarted._loadAllSecrets();
  assert.equal(restarted.getCleanupCustomKey(), "");
  assert.equal(restarted.getCustomTranscriptionKey(), "transcription-account");
  assert.equal(fs.readFileSync(legacy, "utf8"), "encrypted-legacy-account");
});

test("clearing while an encrypted write is queued discards that credential on disk", async (t) => {
  const env = isolateCleanupSettings(t);
  const crypto = require("../../src/helpers/secretCrypto");
  const available = t.mock.method(crypto, "isAvailable", () => true);
  t.mock.method(crypto, "encrypt", (value) => Buffer.from(value));
  env.saveOpenAIKey("queued-account");
  available.mock.mockImplementation(() => false);
  const clear = env.saveOpenAIKey("");
  assert.equal(env.saveOpenAIKey(""), clear);
  const seed = env.saveOpenAIKey("stale-upgrade", true);
  assert.deepEqual(await clear, { success: true, stored: "" });
  assert.deepEqual(await seed, { success: true, retained: "" });
  process.env = { OPENAI_API_KEY: "launcher-account" };
  EnvironmentManager._resetShellImportedSecrets();
  const restarted = new EnvironmentManager();
  await restarted._migrateToSecureStorage();
  await restarted._loadAllSecrets();
  assert.equal(restarted.getOpenAIKey(), "");
  assert.ok(
    !fs
      .readFileSync(env._getSecretFilePath("OPENAI_API_KEY"))
      .includes(Buffer.from("queued-account"))
  );
});

test("a failed locked clear does not undo a newer local edit", async (t) => {
  const env = isolateCleanupSettings(t);
  const slot = env._getSecretFilePath("OPENAI_API_KEY");
  fs.mkdirSync(path.dirname(slot), { recursive: true });
  fs.writeFileSync(slot, "locked-account");
  const fsp = require("node:fs/promises");
  const rename = fsp.rename;
  let failNextClear = true;
  t.mock.method(fsp, "rename", async (from, to) => {
    if (to === slot && failNextClear) {
      failNextClear = false;
      throw new Error("clear unavailable");
    }
    return rename(from, to);
  });
  const clear = env.saveOpenAIKey("");
  const seed = env.saveOpenAIKey("stale-upgrade", true);
  const replacement = env.saveOpenAIKey("new-edit");
  assert.equal((await clear).success, false);
  assert.equal((await seed).success, false);
  assert.equal((await replacement).success, true);
  assert.equal(env.getOpenAIKey(), "new-edit");
});

test("two failed locked edits restore the last usable credential in memory and on restart", async (t) => {
  const env = isolateCleanupSettings(t);
  const slot = env._getSecretFilePath("CUSTOM_CLEANUP_API_KEY");
  const profile = path.join(fakeElectron.app.getPath("userData"), ".env");
  fs.mkdirSync(path.dirname(slot), { recursive: true });
  fs.writeFileSync(slot, "unreadable");
  fs.writeFileSync(profile, "CUSTOM_CLEANUP_API_KEY=$OLD_PASSWORD\n");
  t.mock.method(require("../../src/helpers/secretCrypto"), "decrypt", () => {
    throw new Error("locked");
  });
  env.loadEnvironmentVariables();
  await env._loadAllSecrets();
  const fsp = require("node:fs/promises");
  const rename = fsp.rename;
  t.mock.method(fsp, "rename", async (from, to) => {
    if (to === slot) throw new Error("disk unavailable");
    return rename(from, to);
  });
  const clear = env.saveCleanupCustomKey("");
  const edit = env.saveCleanupCustomKey("replacement-account");
  assert.equal((await clear).success, false);
  assert.deepEqual(await edit, {
    success: false, reason: "storage-unavailable", retained: "$CUSTOM_CLEANUP_API_KEY",
  });
  assert.equal(env.getCleanupCustomKey(), "$OLD_PASSWORD");
  assert.equal(env.getRawCleanupCustomKey(), "$CUSTOM_CLEANUP_API_KEY");
  assert.equal(process.env.CUSTOM_CLEANUP_LEGACY_FALLBACK_DISABLED, undefined);
  process.env = {};
  EnvironmentManager._resetShellImportedSecrets();
  const restarted = new EnvironmentManager();
  await restarted._loadAllSecrets();
  assert.equal(restarted.getCleanupCustomKey(), "$OLD_PASSWORD");
  assert.equal(restarted.getRawCleanupCustomKey(), "$CUSTOM_CLEANUP_API_KEY");
});
