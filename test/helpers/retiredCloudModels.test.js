const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/config/retiredCloudModels.ts");

const CLEANUP = { provider: "cleanupProvider", model: "cleanupModel" };
const CHAT = { provider: "chatAgentProvider", model: "chatAgentModel" };
const NOTES = { provider: "noteFormattingProvider", model: "noteFormattingModel" };

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
  };
};

test("remaps a scope pinned to a model Tinfoil retired", async () => {
  const { sweepRetiredCloudModelSelections } = await load();
  const storage = makeStorage({ cleanupProvider: "tinfoil", cleanupModel: "glm-5-2" });

  assert.deepEqual(sweepRetiredCloudModelSelections(storage, [CLEANUP]), [
    { storeKey: "cleanupModel", provider: "tinfoil", from: "glm-5-2", to: "glm-5-3" },
  ]);
  assert.equal(storage.map.get("cleanupModel"), "glm-5-3");
});

test("remaps every other Tinfoil model the app has offered and Tinfoil has since retired", async () => {
  const { sweepRetiredCloudModelSelections } = await load();
  // deepseek-v4-pro and kimi-k2-6 shipped as seed defaults; deepseek-v4-flash
  // was served live (and was deepseek-v4-pro's replacement here) until Tinfoil
  // retired it too. All three 404 exactly like glm-5-2 did.
  const storage = makeStorage({
    cleanupProvider: "tinfoil",
    cleanupModel: "deepseek-v4-pro",
    chatAgentProvider: "tinfoil",
    chatAgentModel: "kimi-k2-6",
    noteFormattingProvider: "tinfoil",
    noteFormattingModel: "deepseek-v4-flash",
  });

  sweepRetiredCloudModelSelections(storage, [CLEANUP, CHAT, NOTES]);

  assert.equal(storage.map.get("cleanupModel"), "deepseek-v4-1-flash");
  assert.equal(storage.map.get("chatAgentModel"), "kimi-k3");
  assert.equal(storage.map.get("noteFormattingModel"), "deepseek-v4-1-flash");
});

test("still remaps the models Groq retired", async () => {
  const { sweepRetiredCloudModelSelections } = await load();
  const storage = makeStorage({
    cleanupProvider: "groq",
    cleanupModel: "llama-3.3-70b-versatile",
    chatAgentProvider: "groq",
    chatAgentModel: "qwen/qwen3-32b",
  });

  sweepRetiredCloudModelSelections(storage, [CLEANUP, CHAT]);

  assert.equal(storage.map.get("cleanupModel"), "openai/gpt-oss-120b");
  assert.equal(storage.map.get("chatAgentModel"), "openai/gpt-oss-120b");
});

test("leaves a model the provider still serves alone", async () => {
  const { sweepRetiredCloudModelSelections } = await load();
  const storage = makeStorage({ cleanupProvider: "tinfoil", cleanupModel: "gpt-oss-120b" });

  assert.deepEqual(sweepRetiredCloudModelSelections(storage, [CLEANUP]), []);
  assert.equal(storage.map.get("cleanupModel"), "gpt-oss-120b");
});

test("a retired id under a different provider is not remapped", async () => {
  const { sweepRetiredCloudModelSelections } = await load();
  // Someone self-hosting GLM-5.2 behind the custom provider keeps their model.
  const storage = makeStorage({ cleanupProvider: "custom", cleanupModel: "glm-5-2" });

  assert.deepEqual(sweepRetiredCloudModelSelections(storage, [CLEANUP]), []);
  assert.equal(storage.map.get("cleanupModel"), "glm-5-2");
});

test("each provider's remap is one-shot, so a re-picked model is left alone", async () => {
  const { sweepRetiredCloudModelSelections } = await load();
  const storage = makeStorage({ cleanupProvider: "tinfoil", cleanupModel: "glm-5-2" });

  sweepRetiredCloudModelSelections(storage, [CLEANUP]);
  storage.setItem("cleanupModel", "glm-5-2");

  assert.deepEqual(sweepRetiredCloudModelSelections(storage, [CLEANUP]), []);
  assert.equal(storage.map.get("cleanupModel"), "glm-5-2");
});

test("Groq's already-shipped sentinel does not suppress another provider's remap", async () => {
  const { sweepRetiredCloudModelSelections } = await load();
  // Anyone upgrading from a build that ran the Groq-only migration carries it.
  const storage = makeStorage({
    _retiredGroqModelsMigrated: "1",
    cleanupProvider: "tinfoil",
    cleanupModel: "glm-5-2",
  });

  assert.deepEqual(sweepRetiredCloudModelSelections(storage, [CLEANUP]), [
    { storeKey: "cleanupModel", provider: "tinfoil", from: "glm-5-2", to: "glm-5-3" },
  ]);
  assert.equal(storage.map.get("cleanupModel"), "glm-5-3");
});

test("a provider whose sentinel is already set is skipped", async () => {
  const { sweepRetiredCloudModelSelections } = await load();
  const storage = makeStorage({
    _retiredGroqModelsMigrated: "1",
    cleanupProvider: "groq",
    cleanupModel: "llama-3.3-70b-versatile",
  });

  assert.deepEqual(sweepRetiredCloudModelSelections(storage, [CLEANUP]), []);
  assert.equal(storage.map.get("cleanupModel"), "llama-3.3-70b-versatile");
});

test("a sentinel a shipped build already wrote does not stop the rotated sweep", async () => {
  const { sweepRetiredCloudModelSelections } = await load();
  // v1.10.x ran the first Tinfoil sweep; deepseek-v4-flash retired after it.
  const storage = makeStorage({
    _retiredTinfoilModelsMigrated: "1",
    cleanupProvider: "tinfoil",
    cleanupModel: "deepseek-v4-flash",
  });

  assert.deepEqual(sweepRetiredCloudModelSelections(storage, [CLEANUP]), [
    {
      storeKey: "cleanupModel",
      provider: "tinfoil",
      from: "deepseek-v4-flash",
      to: "deepseek-v4-1-flash",
    },
  ]);
  assert.equal(storage.map.get("_retiredTinfoilModelsMigrated2"), "1");
});

test("no replacement is itself retired, and every provider has its own sentinel", async () => {
  const { RETIRED_CLOUD_MODELS } = await load();
  const sentinels = new Set();

  for (const [provider, entry] of Object.entries(RETIRED_CLOUD_MODELS)) {
    assert.ok(!sentinels.has(entry.migratedKey), `${provider} reuses another provider's sentinel`);
    sentinels.add(entry.migratedKey);

    for (const [retired, replacement] of Object.entries(entry.models)) {
      assert.notEqual(retired, replacement, `${provider}: ${retired} maps to itself`);
      assert.ok(
        !(replacement in entry.models),
        `${provider}: ${retired} maps to ${replacement}, which is itself retired`
      );
    }
  }
});

// The sweep is one-shot per sentinel, so an id added under a key installed apps
// already carry never runs. Tripping on either edit is what forces the rotation
// into the diff — this cannot check it happened.
test("each provider's sentinel is pinned to the exact set of ids it covers", async () => {
  const { RETIRED_CLOUD_MODELS } = await load();

  const covered = Object.fromEntries(
    Object.entries(RETIRED_CLOUD_MODELS).map(([provider, entry]) => [
      provider,
      { migratedKey: entry.migratedKey, retired: Object.keys(entry.models).sort() },
    ])
  );

  assert.deepEqual(covered, {
    groq: {
      migratedKey: "_retiredGroqModelsMigrated",
      retired: ["llama-3.1-8b-instant", "llama-3.3-70b-versatile", "qwen/qwen3-32b"],
    },
    tinfoil: {
      migratedKey: "_retiredTinfoilModelsMigrated2",
      retired: ["deepseek-v4-flash", "deepseek-v4-pro", "glm-5-2", "kimi-k2-6"],
    },
  });
});

test("a storage that cannot be written leaves the sentinel unset, so the next launch retries", async () => {
  const { sweepRetiredCloudModelSelections } = await load();
  const storage = makeStorage({ cleanupProvider: "tinfoil", cleanupModel: "glm-5-2" });
  storage.setItem = () => {
    throw new Error("QuotaExceededError");
  };

  assert.deepEqual(sweepRetiredCloudModelSelections(storage, [CLEANUP]), []);
  assert.equal(storage.map.get("_retiredTinfoilModelsMigrated2"), undefined);
  // Groq shares the storage but not the failure's blast radius.
  assert.equal(storage.map.get("_retiredGroqModelsMigrated"), undefined);
});
