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

test("billingCheckout maps the buyer's options to the API's request field names", async (t) => {
  const requests = installCloudCapture(t);
  const { WorkspacesService } = require("../../src/services/WorkspacesService.ts");

  const cases = [
    {
      interval: "annual",
      options: undefined,
      expectedBody: { interval: "annual" },
    },
    {
      interval: "monthly",
      options: { tier: "enterprise", additionalSeats: 4 },
      expectedBody: { interval: "monthly", tier: "enterprise", additional_seats: 4 },
    },
    {
      interval: "monthly",
      options: { tier: "enterprise", additionalSeats: 0 },
      expectedBody: { interval: "monthly", tier: "enterprise" },
    },
  ];
  for (const { interval, options } of cases) {
    const url = await WorkspacesService.billingCheckout("ws-1", interval, options);
    assert.equal(url, CHECKOUT_URL, `checkout url (${JSON.stringify(options ?? null)})`);
  }
  assert.deepEqual(
    requests.map(({ method, path, body }) => ({ method, path, body })),
    cases.map(({ expectedBody }) => ({
      method: "POST",
      path: "/api/workspaces/ws-1/billing/checkout",
      body: expectedBody,
    }))
  );
});

test("previewEnterpriseUpgrade and upgradeToEnterprise POST no body; the preview returns unchanged", async (t) => {
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

  assert.deepEqual(await WorkspacesService.previewEnterpriseUpgrade("ws-1"), preview);
  await WorkspacesService.upgradeToEnterprise("ws-1");

  assert.deepEqual(
    requests.map(({ method, path, body }) => ({ method, path, body })),
    [
      { method: "POST", path: "/api/workspaces/ws-1/billing/preview-upgrade", body: undefined },
      { method: "POST", path: "/api/workspaces/ws-1/billing/upgrade", body: undefined },
    ]
  );
});

test("seat preview uses a relative increase while confirmation sends the quoted absolute quantity", async (t) => {
  const preview = {
    current_quantity: 5,
    next_quantity: 6,
    seats_used: 4,
    amount_due: 1500,
    currency: "usd",
  };
  const requests = installCloudCapture(t, preview);
  const { WorkspacesService } = require("../../src/services/WorkspacesService.ts");

  assert.deepEqual(await WorkspacesService.previewSeats("ws-1", 1), preview);
  await WorkspacesService.updateSeats("ws-1", preview.next_quantity);
  assert.deepEqual(
    requests.map(({ method, path, body }) => ({ method, path, body })),
    [
      {
        method: "POST",
        path: "/api/workspaces/ws-1/billing/preview-seats",
        body: { additional_seats: 1 },
      },
      {
        method: "POST",
        path: "/api/workspaces/ws-1/billing/seats",
        body: { quantity: 6 },
      },
    ]
  );
});
