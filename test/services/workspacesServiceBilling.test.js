const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals } = require("../lib/rendererTestHarness");

const CHECKOUT_URL = "https://checkout.stripe.test/session";

// Captures the IPC payload WorkspacesService hands to the main process, so the
// wire body the API's zod schema receives is pinned here.
function installCloudCapture(t, responseData = { url: CHECKOUT_URL }) {
  const requests = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        cloudApiRequest: async (options) => {
          requests.push(options);
          return { success: true, data: { data: responseData } };
        },
      },
    },
  });
  return requests;
}

test("billingCheckout without options keeps the pre-enterprise wire body", async (t) => {
  const requests = installCloudCapture(t);
  const { WorkspacesService } = require("../../src/services/WorkspacesService.ts");

  const url = await WorkspacesService.billingCheckout("ws-1", "annual");

  assert.equal(url, CHECKOUT_URL);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].path, "/api/workspaces/ws-1/billing/checkout");
  assert.deepEqual(requests[0].body, { interval: "annual" });
});

test("billingCheckout sends the enterprise tier and extra seats in the API's field names", async (t) => {
  const requests = installCloudCapture(t);
  const { WorkspacesService } = require("../../src/services/WorkspacesService.ts");

  await WorkspacesService.billingCheckout("ws-1", "monthly", {
    tier: "enterprise",
    additionalSeats: 4,
  });

  assert.deepEqual(requests[0].body, {
    interval: "monthly",
    tier: "enterprise",
    additional_seats: 4,
  });
});

test("billingCheckout omits additional_seats when the buyer keeps current occupancy", async (t) => {
  const requests = installCloudCapture(t);
  const { WorkspacesService } = require("../../src/services/WorkspacesService.ts");

  await WorkspacesService.billingCheckout("ws-1", "monthly", {
    tier: "enterprise",
    additionalSeats: 0,
  });

  assert.deepEqual(requests[0].body, { interval: "monthly", tier: "enterprise" });
});

test("previewEnterpriseUpgrade posts no body and returns the preview unchanged", async (t) => {
  const preview = {
    prorated_amount: 12300,
    currency: "usd",
    current_price_amount: 1500,
    new_price_amount: 3000,
    interval: "monthly",
    quantity: 5,
    next_billing_date: "2026-09-01T00:00:00.000Z",
  };
  const requests = installCloudCapture(t, preview);
  const { WorkspacesService } = require("../../src/services/WorkspacesService.ts");

  const result = await WorkspacesService.previewEnterpriseUpgrade("ws-1");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].path, "/api/workspaces/ws-1/billing/preview-upgrade");
  assert.equal(requests[0].body, undefined);
  assert.deepEqual(result, preview);
});

test("upgradeToEnterprise posts to the upgrade endpoint with no body", async (t) => {
  const requests = installCloudCapture(t, { plan: "enterprise" });
  const { WorkspacesService } = require("../../src/services/WorkspacesService.ts");

  await WorkspacesService.upgradeToEnterprise("ws-1");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].path, "/api/workspaces/ws-1/billing/upgrade");
  assert.equal(requests[0].body, undefined);
});
