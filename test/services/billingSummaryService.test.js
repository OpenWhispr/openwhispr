const assert = require("node:assert/strict");
const test = require("node:test");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("billing summaries are scoped to the captured identity and tolerate unavailable data", async (t) => {
  let response;
  const requests = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        cloudApiRequest: async (request) => {
          requests.push(request);
          if (response instanceof Error) throw response;
          return response;
        },
      },
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-billing-summary-" });
  const { getBillingSummary } = await vite.ssrLoadModule("/services/BillingSummaryService.ts");
  const personal = { workspaceId: null, authGeneration: 4 };
  const workspace = { workspaceId: "A", authGeneration: 7 };

  assert.equal(await getBillingSummary(null), undefined);
  assert.deepEqual(requests, []);
  response = { success: true, data: { data: { billing_email: "owner@example.com" } } };
  assert.deepEqual(await getBillingSummary(personal), { billing_email: "owner@example.com" });
  response = { success: true, data: { data: { unit_amount: 0, interval: null } } };
  assert.deepEqual(await getBillingSummary(workspace), { unit_amount: 0, interval: null });
  assert.deepEqual(
    requests.map(({ method, path, expectedAuthGeneration, cache }) => ({
      method,
      path,
      expectedAuthGeneration,
      cache,
    })),
    [
      { method: "GET", path: "/api/billing/summary", expectedAuthGeneration: 4, cache: "no-store" },
      {
        method: "GET",
        path: "/api/workspaces/A/billing/summary",
        expectedAuthGeneration: 7,
        cache: "no-store",
      },
    ]
  );

  for (const unavailable of [
    { success: true, data: { data: null } },
    { success: true, data: {} },
    { success: true },
    { success: false, status: 403 },
    { success: false, status: 404 },
    new Error("Disconnected"),
  ]) {
    response = unavailable;
    assert.equal(await getBillingSummary(workspace), undefined);
  }
});
