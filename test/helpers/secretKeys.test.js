const test = require("node:test");
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
  return origLoad.call(this, request, ...rest);
};

const { BYOK_API_KEYS, SCOPE_CUSTOM_API_KEYS } = require("../../src/config/secretKeys");
const ALL_KEYS = [...BYOK_API_KEYS, ...SCOPE_CUSTOM_API_KEYS];
const EnvironmentManager = require("../../src/helpers/environment");

test("manifest entries are unique and complete", () => {
  const seen = { base: new Set(), env: new Set(), storeKey: new Set() };
  for (const k of ALL_KEYS) {
    for (const field of ["base", "env", "get", "save", "storeKey"]) {
      assert.ok(k[field], `${field} present on ${k.base}`);
    }
    for (const field of ["base", "env", "storeKey"]) {
      assert.ok(!seen[field].has(k[field]), `duplicate ${field}: ${k[field]}`);
      seen[field].add(k[field]);
    }
  }
});

test("every manifest key round-trips through the generated accessors", () => {
  const env = new EnvironmentManager();
  for (const k of ALL_KEYS) {
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

test("openrouter is a first-class secret", () => {
  const or = BYOK_API_KEYS.find((k) => k.base === "openrouter");
  assert.ok(or, "openrouter present in manifest");
  assert.equal(or.env, "OPENROUTER_API_KEY");
  const env = new EnvironmentManager();
  env.saveOpenrouterKey("sk-or-abc");
  assert.equal(env.getOpenrouterKey(), "sk-or-abc");
});

// preload.js can't require the manifest under sandbox, so it inlines the
// {base, get, save} tuples. Assert they stay in lockstep with the manifest.
for (const [name, manifest] of [
  ["BYOK_KEY_BRIDGES", BYOK_API_KEYS],
  ["SCOPE_KEY_BRIDGES", SCOPE_CUSTOM_API_KEYS],
]) {
  test(`preload ${name} mirrors its manifest exactly`, () => {
    const preloadSrc = fs.readFileSync(path.join(__dirname, "../../preload.js"), "utf8");
    const block = preloadSrc.match(new RegExp(`${name} = \\[([\\s\\S]*?)\\];`));
    assert.ok(block, `${name} declared in preload.js`);
    for (const k of manifest) {
      const entry = new RegExp(
        `\\{\\s*base:\\s*"${k.base}",\\s*get:\\s*"${k.get}",\\s*save:\\s*"${k.save}",?\\s*\\}`
      );
      assert.match(block[1], entry, `preload mirrors ${k.base}`);
    }
    const bridgeCount = (block[1].match(/base:/g) || []).length;
    assert.equal(bridgeCount, manifest.length, "no extra/missing preload bridges");
  });
}
