const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { captureAuthFence } = require("../../src/helpers/cloudApiRequest");

function setup() {
  const handlers = new Map();
  const state = { token: "account-a", generation: 7 };
  const requests = [];
  let fetch = async () => new Response(JSON.stringify({ url: "https://checkout.stripe.com/test" }));
  const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/ipcHandlers.js"), "utf8");
  vm.runInNewContext(
    source.slice(
      source.indexOf("    const fetchStripeUrl ="),
      source.indexOf('    ipcMain.handle("cloud-switch-plan"')
    ),
    {
      ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
      getApiUrl: () => "https://api.openwhispr.test",
      getAuthHeader: async () => ({ Authorization: `Bearer ${state.token}` }),
      captureAuthFence,
      tokenStore: { getState: () => ({ ...state }) },
      proxyFetch: async (...args) => {
        requests.push(args);
        return fetch(...args);
      },
      debugLogger: { error() {} },
      JSON,
    }
  );
  return {
    state,
    requests,
    checkout: (generation) => handlers.get("cloud-checkout")({}, { plan: "annual" }, generation),
    setFetch: (callback) => {
      fetch = callback;
    },
  };
}

test("native checkout refuses a stale generation before sending any request", async () => {
  const checkout = setup();
  const result = await checkout.checkout(6);
  assert.equal(result.success, false);
  assert.equal(result.code, "AUTH_CONTEXT_CHANGED");
  assert.equal(checkout.requests.length, 0);
});

test("native checkout discards the URL when its credential changes during the request", async () => {
  const checkout = setup();
  checkout.setFetch(async () => {
    checkout.state.token = "account-b";
    checkout.state.generation++;
    return new Response(JSON.stringify({ url: "https://checkout.stripe.com/stale" }));
  });
  const result = await checkout.checkout(7);
  assert.equal(result.success, false);
  assert.equal(result.code, "AUTH_CONTEXT_CHANGED");
  assert.equal(result.url, undefined);
});
