const test = require("node:test");
const assert = require("node:assert/strict");

const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const fork = require("../../src/config/fork.config.json");

const load = () => import("../../src/services/cleanupAuth.ts");

// A stored key is never sent to our own host: there the license always wins, the
// same rule as STT (customTranscriptionKeySource). Elsewhere the stored key is used.
test("our host always takes the license; a stored key wins only on other hosts", async () => {
  const { cleanupKeySource } = await load();

  assert.equal(
    cleanupKeySource({ storedKey: "sk-mine", baseUrl: "https://x/v1", isTitaniumService: true }),
    "titanium"
  );
  assert.equal(
    cleanupKeySource({ storedKey: "sk-mine", baseUrl: "https://y/v1", isTitaniumService: false }),
    "stored"
  );
});

test("no stored key on our own host takes the Titanium license", async () => {
  const { cleanupKeySource } = await load();

  for (const storedKey of ["", "   ", null, undefined]) {
    assert.equal(
      cleanupKeySource({ storedKey, baseUrl: "https://x/v1", isTitaniumService: true }),
      "titanium"
    );
  }
});

test("no stored key on a foreign or empty endpoint sends no key of ours", async () => {
  const { cleanupKeySource } = await load();

  assert.equal(
    cleanupKeySource({ storedKey: "", baseUrl: "https://other/v1", isTitaniumService: false }),
    "none"
  );
  assert.equal(cleanupKeySource({ storedKey: "", baseUrl: "", isTitaniumService: true }), "none");
  assert.equal(
    cleanupKeySource({ storedKey: "", baseUrl: undefined, isTitaniumService: true }),
    "none"
  );
});

// ReasoningService.isAvailable() decides whether cleanup runs at all, so a
// signed-out user on our server must get raw text without a failing request.
const OUR_CLEANUP_URL = `${fork.DEFAULT_STT.baseUrl.replace(/\/+$/, "")}/chat/completions`;

async function loadReasoningService(t, { baseUrl = OUR_CLEANUP_URL, electronAPI }) {
  installBrowserGlobals(t, {
    initialStorage: {
      cleanupMode: "providers",
      cleanupCloudMode: "byok",
      cleanupProvider: "custom",
      cleanupCloudBaseUrl: baseUrl,
    },
    window: { electronAPI },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-cleanup-auth-test-" });
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.10.0", policy: null });
  t.after(() => reasoningService.destroy());
  return reasoningService;
}

test("isAvailable: Custom on our host with no stored key and no license is unavailable", async (t) => {
  const asked = [];
  const reasoningService = await loadReasoningService(t, {
    electronAPI: {
      getCleanupCustomKey: async () => "",
      getTitaniumServiceKey: async (url) => {
        asked.push(url);
        return null;
      },
    },
  });

  assert.equal(await reasoningService.isAvailable(), false);
  assert.deepEqual(asked, [OUR_CLEANUP_URL]);
});

test("isAvailable: Custom on our host with a license is available, and the license is the key", async (t) => {
  const reasoningService = await loadReasoningService(t, {
    electronAPI: {
      getCleanupCustomKey: async () => "",
      getTitaniumServiceKey: async () => "license/key.sig",
    },
  });

  assert.equal(await reasoningService.isAvailable(), true);
  assert.equal(await reasoningService.getApiKey("custom"), "license/key.sig");
});

test("on our host a stored cleanup key is never sent; the license is the key", async (t) => {
  const reasoningService = await loadReasoningService(t, {
    electronAPI: {
      getCleanupCustomKey: async () => "sk-stored",
      getTitaniumServiceKey: async () => "license/key.sig",
    },
  });

  assert.equal(await reasoningService.isAvailable(), true);
  assert.equal(await reasoningService.getApiKey("custom"), "license/key.sig");
});

test("on a foreign host a stored cleanup key is used and the license is never requested", async (t) => {
  let licenseRequested = false;
  const reasoningService = await loadReasoningService(t, {
    baseUrl: "https://llm.example.invalid/v1/chat/completions",
    electronAPI: {
      getCleanupCustomKey: async () => "sk-stored",
      getTitaniumServiceKey: async () => {
        licenseRequested = true;
        return "license/key.sig";
      },
    },
  });

  assert.equal(await reasoningService.isAvailable(), true);
  assert.equal(await reasoningService.getApiKey("custom"), "sk-stored");
  assert.equal(licenseRequested, false);
});

test("a Custom endpoint that is not ours never gets the license and stays available keyless", async (t) => {
  let licenseRequested = false;
  const reasoningService = await loadReasoningService(t, {
    baseUrl: "https://llm.example.invalid/v1/chat/completions",
    electronAPI: {
      getCleanupCustomKey: async () => "",
      getTitaniumServiceKey: async () => {
        licenseRequested = true;
        return "license/key.sig";
      },
    },
  });

  assert.equal(await reasoningService.isAvailable(), true);
  assert.equal(await reasoningService.getApiKey("custom"), "");
  assert.equal(licenseRequested, false);
});

test("seeding policy: only a signed-in user who never configured cleanup and has no BYOK key", async () => {
  const { shouldSeedSttApiCleanup } = await load();
  const fresh = { licensed: true, hasByokKey: false };

  assert.equal(shouldSeedSttApiCleanup(fresh), true);
  assert.equal(shouldSeedSttApiCleanup({ ...fresh, storedMode: "providers" }), true);
  // Signed out, BYOK, or any stored choice keeps today's behavior.
  assert.equal(shouldSeedSttApiCleanup({ ...fresh, licensed: false }), false);
  assert.equal(shouldSeedSttApiCleanup({ ...fresh, hasByokKey: true }), false);
  assert.equal(shouldSeedSttApiCleanup({ ...fresh, storedProvider: "openai" }), false);
  assert.equal(shouldSeedSttApiCleanup({ ...fresh, storedBaseUrl: "https://x/v1" }), false);
  assert.equal(shouldSeedSttApiCleanup({ ...fresh, storedModel: "gpt-5-mini" }), false);
  assert.equal(shouldSeedSttApiCleanup({ ...fresh, storedMode: "local" }), false);
});

const TARGET = {
  provider: "custom",
  baseUrl: "https://stt.example.test/v1/chat/completions",
  model: "haiku",
};

async function loadSeed(t, { storage = {}, secrets = {}, hydrate = true } = {}) {
  // The fork (cloud disabled) runs cleanup in "providers" mode; the test env enables the cloud.
  installBrowserGlobals(t, {
    initialStorage: { cleanupMode: "providers", ...storage },
    // Every secret read from the main process answers "none stored".
    window: {
      electronAPI: new Proxy(
        {},
        { get: (_, key) => (key === "then" ? undefined : async () => "") }
      ),
    },
  });
  // Hydration fires lazy imports of these; stubbing them keeps the heavy module graph (and its
  // file watchers) out of this test.
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cleanup-seed-test-",
    mockModules: {
      "/services/ReasoningService": "export default { clearApiKeyCache() {} };",
      "/services/SyncService.js": "export const syncService = { canSync: () => false };",
    },
  });
  const { seedSttApiCleanup } = await vite.ssrLoadModule("/config/forkCleanupSeed.ts");
  const { useSettingsStore, getSettings, initializeSettings, areSecretsHydrated } =
    await vite.ssrLoadModule("/stores/settingsStore.ts");
  // Seeding is gated on secrets having been read, so a BYOK user is never mistaken for keyless.
  if (hydrate) {
    await initializeSettings();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  useSettingsStore.setState(secrets);
  return { seedSttApiCleanup, getSettings, areSecretsHydrated };
}

test("a fresh signed-in install is seeded onto our server and persists the choice", async (t) => {
  const { seedSttApiCleanup, getSettings } = await loadSeed(t);

  assert.equal(seedSttApiCleanup(true, TARGET), true);
  assert.equal(getSettings().cleanupProvider, "custom");
  assert.equal(getSettings().cleanupCloudBaseUrl, TARGET.baseUrl);
  assert.equal(getSettings().cleanupModel, "haiku");
  assert.equal(globalThis.localStorage.getItem("cleanupProvider"), "custom");
});

test("a signed-out install keeps the upstream cleanup default", async (t) => {
  const { seedSttApiCleanup, getSettings } = await loadSeed(t);

  assert.equal(seedSttApiCleanup(false, TARGET), false);
  assert.equal(getSettings().cleanupProvider, "openai");
});

test("an existing BYOK install (key or stored provider) is never changed", async (t) => {
  const withKey = await loadSeed(t, { secrets: { openaiApiKey: "sk-user" } });
  assert.equal(withKey.seedSttApiCleanup(true, TARGET), false);
  assert.equal(withKey.getSettings().cleanupProvider, "openai");
});

test("a stored cleanup provider is never overwritten by the seed", async (t) => {
  const stored = await loadSeed(t, {
    storage: { cleanupProvider: "anthropic", cleanupModel: "claude-sonnet-4-6" },
  });
  assert.equal(stored.seedSttApiCleanup(true, TARGET), false);
  assert.equal(stored.getSettings().cleanupProvider, "anthropic");
  assert.equal(stored.getSettings().cleanupModel, "claude-sonnet-4-6");
});

test("seeding waits for secrets to hydrate, so a keyless-looking BYOK user is never seeded", async (t) => {
  const early = await loadSeed(t, { hydrate: false });

  assert.equal(early.areSecretsHydrated(), false);
  assert.equal(early.seedSttApiCleanup(true, TARGET), false);
  assert.equal(early.getSettings().cleanupProvider, "openai");
});
