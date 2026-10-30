const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const en = require("../../src/locales/en/translation.json");

test("a request refused for an unvalidated session reads as translated copy", async (t) => {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        authGetTokenState: async () => ({ token: "token-a", generation: 1 }),
        cloudApiRequest: async () => ({
          success: false,
          status: 0,
          code: "AUTH_CONTEXT_UNVALIDATED",
          error: "Authenticated request has no validated credential generation",
        }),
      },
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-cloud-api-unconfirmed-" });
  const { cloudPost } = await vite.ssrLoadModule("/services/cloudApi.ts");

  await assert.rejects(cloudPost("/api/workspaces", {}), {
    code: "AUTH_CONTEXT_UNVALIDATED",
    message: en.auth.unconfirmedSession,
  });
});
