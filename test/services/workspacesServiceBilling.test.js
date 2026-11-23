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

test("previewSeats sends the captured generation and preserves the detailed zero-proration quote", async (t) => {
  const preview = {
    current_quantity: 10,
    next_quantity: 11,
    seats_used: 8,
    member_seats: 7,
    pending_seats: 1,
    amount_due: 159960,
    currency: "usd",
    unit_amount: 15996,
    interval: "annual",
    proration_amount: 0,
    next_invoice_amount: 159960,
    next_invoice_date: null,
  };
  const requests = installCloudCapture(t, preview);
  const { WorkspacesService } = require("../../src/services/WorkspacesService.ts");

  const result = await WorkspacesService.previewSeats("ws-1", 1, 42);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].path, "/api/workspaces/ws-1/billing/preview-seats");
  assert.deepEqual(requests[0].body, { additional_seats: 1 });
  assert.equal(requests[0].expectedAuthGeneration, 42);
  assert.deepEqual(result, preview);
});

test("workspace portal honors an optional captured auth generation without changing the legacy request", async (t) => {
  const requests = installCloudCapture(t);
  const { WorkspacesService } = require("../../src/services/WorkspacesService.ts");
  assert.equal(await WorkspacesService.billingPortal("ws-1", 41), CHECKOUT_URL);
  assert.equal(await WorkspacesService.billingPortal("ws-1"), CHECKOUT_URL);
  assert.equal(requests[0].expectedAuthGeneration, 41);
  assert.equal(requests[1].expectedAuthGeneration, undefined);
  for (const request of requests) {
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/api/workspaces/ws-1/billing/portal");
    assert.equal(request.body, undefined);
  }
});

test("workspace people counts use fresh membership and invitation totals", async (t) => {
  const counts = { member_count: 1, pending_invitations: 2 };
  const requests = installCloudCapture(t, counts);
  const { WorkspacesService } = require("../../src/services/WorkspacesService.ts");
  assert.deepEqual(await WorkspacesService.getPeopleCounts("ws-1"), counts);
  assert.equal(requests[0].path, "/api/workspaces/ws-1/stats");
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].cache, "no-store");
});

test("an incomplete stats response leaves membership unknown", async (t) => {
  installCloudCapture(t, { member_count: 1 });
  const { WorkspacesService } = require("../../src/services/WorkspacesService.ts");
  await assert.rejects(WorkspacesService.getPeopleCounts("ws-1"));
});
