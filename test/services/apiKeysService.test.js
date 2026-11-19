const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals } = require("../lib/rendererTestHarness");

function installCloud(t, response) {
  const policyReads = { count: 0 };
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        cloudApiRequest: async () => response,
        getEffectivePolicy: async () => {
          policyReads.count += 1;
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
  assert.equal(policyReads.count, 1);
});

test("any other failure leaves the policy alone", async (t) => {
  const policyReads = installCloud(t, { success: false, status: 500, error: "API error: 500" });

  await assert.rejects(create(), { status: 500 });
  assert.equal(policyReads.count, 0);
});
