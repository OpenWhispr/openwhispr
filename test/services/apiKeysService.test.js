const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals } = require("../lib/rendererTestHarness");

function installCloud(t, response) {
  const policyReads = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        cloudApiRequest: async () => response,
        getEffectivePolicy: async (options) => {
          policyReads.push(options);
          return { revision: 0, status: "loading", deviceReady: true };
        },
      },
    },
  });
  return policyReads;
}

const create = () =>
  require("../../src/services/ApiKeysService.ts").ApiKeysService.create({
    name: "CI",
    scopes: ["notes:read"],
  });

test("a refused key creation re-reads the organization's policy", async (t) => {
  const policyReads = installCloud(t, {
    success: false,
    status: 403,
    error: "Your organization has turned off API and MCP access.",
  });

  await assert.rejects(create(), { status: 403 });
  // Without `refresh`, main answers from the verdict it cached minutes ago.
  assert.deepEqual(policyReads, [{ refresh: true }]);
});

test("any other failure leaves the policy alone", async (t) => {
  const policyReads = installCloud(t, { success: false, status: 500, error: "API error: 500" });

  await assert.rejects(create(), { status: 500 });
  assert.deepEqual(policyReads, []);
});
