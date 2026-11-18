const test = require("node:test");
const assert = require("node:assert/strict");

const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const fork = require("../../src/config/fork.config.json");

const load = () => import("../../src/services/cleanupAuth.ts");

test("a stored key always wins, on any host", async () => {
  const { cleanupKeySource } = await load();

  assert.equal(
    cleanupKeySource({ storedKey: "sk-mine", baseUrl: "https://x/v1", isTitaniumService: true }),
    "stored"
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

test("a stored cleanup key wins over the license and the license is never requested", async (t) => {
  let licenseRequested = false;
  const reasoningService = await loadReasoningService(t, {
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
