const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const load = () => import("../../src/config/retiredPrompts.js");
const loadRegistry = () => import("../../src/config/prompts/registry.ts");

// Byte-exact copies of retired shipped defaults, extracted from git history.
const fixtures = require("./retiredPromptFixtures.json");

const LOCALES_DIR = path.join(__dirname, "..", "..", "src", "locales");
const BUNDLE_KEYS = ["cleanupPrompt", "fullPrompt", "translatePrompt"];

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

const readLocaleBundles = () => {
  const bundles = {};
  for (const entry of fs.readdirSync(LOCALES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const bundlePath = path.join(LOCALES_DIR, entry.name, "prompts.json");
    if (!fs.existsSync(bundlePath)) continue;
    bundles[entry.name] = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  }
  return bundles;
};

const makeStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
};

test("flags the retired English two-mode fullPrompt that shadows hardened defaults", async () => {
  const { isRetiredDefaultPrompt } = await load();
  assert.equal(await isRetiredDefaultPrompt(fixtures.enTwoModeFullPrompt), true);
});

test("flags the retired pre-hardening English cleanup prompt", async () => {
  const { isRetiredDefaultPrompt } = await load();
  assert.equal(await isRetiredDefaultPrompt(fixtures.enPreHardeningCleanupPrompt), true);
});

test("flags the earliest DEFAULT_PROMPTS.agent shipped default", async () => {
  const { isRetiredDefaultPrompt } = await load();
  assert.equal(await isRetiredDefaultPrompt(fixtures.eraADefaultAgentPrompt), true);
});

test("treats a one-character edit of a retired default as a user customization", async () => {
  const { isRetiredDefaultPrompt } = await load();
  const appended = fixtures.enTwoModeFullPrompt + ".";
  const mutated =
    fixtures.enTwoModeFullPrompt.slice(0, 100) + "!" + fixtures.enTwoModeFullPrompt.slice(101);
  assert.equal(await isRetiredDefaultPrompt(appended), false);
  assert.equal(await isRetiredDefaultPrompt(mutated), false);
});

test("never flags any currently shipped locale default", async () => {
  const { isRetiredDefaultPrompt } = await load();
  const bundles = readLocaleBundles();
  assert.ok(Object.keys(bundles).length >= 9, "expected locale bundles");
  for (const [locale, bundle] of Object.entries(bundles)) {
    for (const key of BUNDLE_KEYS) {
      assert.equal(
        await isRetiredDefaultPrompt(bundle[key]),
        false,
        `current default ${locale}/${key} must not match a retired fingerprint`
      );
    }
  }
});

test("never flags user-authored text or degenerate values", async () => {
  const { isRetiredDefaultPrompt } = await load();
  assert.equal(
    await isRetiredDefaultPrompt("Always format my dictations as bullet points and fix grammar."),
    false
  );
  assert.equal(await isRetiredDefaultPrompt(""), false);
  assert.equal(await isRetiredDefaultPrompt(null), false);
  assert.equal(await isRetiredDefaultPrompt(undefined), false);
  assert.equal(await isRetiredDefaultPrompt(42), false);
  assert.equal(await isRetiredDefaultPrompt({}), false);
});

test("registry entries are well-formed sha256 hex digests", async () => {
  const { RETIRED_DEFAULT_PROMPT_HASHES, CURRENT_DEFAULT_PROMPT_HASHES } = await load();
  for (const hash of RETIRED_DEFAULT_PROMPT_HASHES) {
    assert.match(hash, /^[0-9a-f]{64}$/);
  }
  for (const hash of Object.values(CURRENT_DEFAULT_PROMPT_HASHES)) {
    assert.match(hash, /^[0-9a-f]{64}$/);
  }
});

test("current-hash snapshot matches the live locale bundles (ratchet)", async () => {
  const { CURRENT_DEFAULT_PROMPT_HASHES } = await load();
  const bundles = readLocaleBundles();
  const expected = {};
  for (const [locale, bundle] of Object.entries(bundles)) {
    for (const key of BUNDLE_KEYS) {
      if (typeof bundle[key] === "string") expected[`${locale}/${key}`] = sha256(bundle[key]);
    }
  }
  const { PROMPT_KINDS } = await loadRegistry();
  expected.chatAgent = sha256(PROMPT_KINDS.chatAgent.fallback);

  assert.deepEqual(
    CURRENT_DEFAULT_PROMPT_HASHES,
    expected,
    "a shipped default prompt changed: move its old hash into RETIRED_DEFAULT_PROMPT_HASHES " +
      "and record the new hash in CURRENT_DEFAULT_PROMPT_HASHES (src/config/retiredPrompts.js)"
  );
});

test("retired and current hash sets are disjoint", async () => {
  const { RETIRED_DEFAULT_PROMPT_HASHES, CURRENT_DEFAULT_PROMPT_HASHES } = await load();
  for (const [key, hash] of Object.entries(CURRENT_DEFAULT_PROMPT_HASHES)) {
    assert.equal(
      RETIRED_DEFAULT_PROMPT_HASHES.has(hash),
      false,
      `current default ${key} must not appear in the retired set`
    );
  }
});

test("sweep clears an override matching a retired default and archives it", async () => {
  const { sweepRetiredPromptOverrides } = await load();
  const storage = makeStorage({
    "customPrompt.cleanup": fixtures.enTwoModeFullPrompt,
    "customPrompt.dictationAgent": fixtures.enTwoModeFullPrompt,
  });
  const swept = await sweepRetiredPromptOverrides(storage, ["cleanup", "dictationAgent"]);
  assert.deepEqual(swept, ["cleanup", "dictationAgent"]);
  assert.equal(storage.getItem("customPrompt.cleanup"), null);
  assert.equal(storage.getItem("customPrompt.dictationAgent"), null);
  assert.equal(storage.getItem("customPrompt.cleanup.retired"), fixtures.enTwoModeFullPrompt);
  assert.equal(
    storage.getItem("customPrompt.dictationAgent.retired"),
    fixtures.enTwoModeFullPrompt
  );
});

test("sweep never touches a prompt the user edited, even by one character", async () => {
  const { sweepRetiredPromptOverrides } = await load();
  const edited = fixtures.enTwoModeFullPrompt + "\nAlways sign my name.";
  const storage = makeStorage({ "customPrompt.cleanup": edited });
  const swept = await sweepRetiredPromptOverrides(storage, ["cleanup"]);
  assert.deepEqual(swept, []);
  assert.equal(storage.getItem("customPrompt.cleanup"), edited);
  assert.equal(storage.getItem("customPrompt.cleanup.retired"), null);
});

test("sweep leaves a stored copy of the current default alone", async () => {
  const { sweepRetiredPromptOverrides } = await load();
  const bundles = readLocaleBundles();
  const current = bundles.en.cleanupPrompt;
  const storage = makeStorage({ "customPrompt.cleanup": current });
  const swept = await sweepRetiredPromptOverrides(storage, ["cleanup"]);
  assert.deepEqual(swept, []);
  assert.equal(storage.getItem("customPrompt.cleanup"), current);
});

test("sweep is idempotent across restarts", async () => {
  const { sweepRetiredPromptOverrides } = await load();
  const storage = makeStorage({ "customPrompt.cleanup": fixtures.enPreHardeningCleanupPrompt });
  const first = await sweepRetiredPromptOverrides(storage, ["cleanup"]);
  const second = await sweepRetiredPromptOverrides(storage, ["cleanup"]);
  assert.deepEqual(first, ["cleanup"]);
  assert.deepEqual(second, []);
  assert.equal(
    storage.getItem("customPrompt.cleanup.retired"),
    fixtures.enPreHardeningCleanupPrompt
  );
});

test("sweep skips removal when the value changes while hashing", async () => {
  const { sweepRetiredPromptOverrides } = await load();
  const storage = makeStorage({ "customPrompt.cleanup": fixtures.enTwoModeFullPrompt });
  const userSaved = "My own prompt, saved mid-sweep.";
  let reads = 0;
  const racy = {
    getItem(key) {
      if (key === "customPrompt.cleanup") {
        reads += 1;
        return reads === 1 ? fixtures.enTwoModeFullPrompt : userSaved;
      }
      return storage.getItem(key);
    },
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: (key) => storage.removeItem(key),
  };
  const swept = await sweepRetiredPromptOverrides(racy, ["cleanup"]);
  assert.deepEqual(swept, []);
  assert.equal(storage.getItem("customPrompt.cleanup"), fixtures.enTwoModeFullPrompt);
  assert.equal(storage.getItem("customPrompt.cleanup.retired"), null);
});

test("a storage failure on one kind does not stop the sweep of the others", async () => {
  const { sweepRetiredPromptOverrides } = await load();
  const storage = makeStorage({
    "customPrompt.dictationAgent": fixtures.enTwoModeFullPrompt,
  });
  const failing = {
    getItem(key) {
      if (key === "customPrompt.cleanup") throw new Error("storage unavailable");
      return storage.getItem(key);
    },
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: (key) => storage.removeItem(key),
  };
  const swept = await sweepRetiredPromptOverrides(failing, ["cleanup", "dictationAgent"]);
  assert.deepEqual(swept, ["dictationAgent"]);
  assert.equal(
    storage.getItem("customPrompt.dictationAgent.retired"),
    fixtures.enTwoModeFullPrompt
  );
});

test("sweep is a no-op on missing or empty overrides", async () => {
  const { sweepRetiredPromptOverrides } = await load();
  const storage = makeStorage({ "customPrompt.translate": "" });
  const swept = await sweepRetiredPromptOverrides(storage, [
    "cleanup",
    "dictationAgent",
    "translate",
    "chatAgent",
  ]);
  assert.deepEqual(swept, []);
  assert.equal(storage.getItem("customPrompt.translate"), "");
  assert.equal(
    [...storage.map.keys()].some((k) => k.endsWith(".retired")),
    false
  );
});
