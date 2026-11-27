const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveBillingView, settleBillingRequest } = require("../../src/lib/plansBillingView.ts");

const A = { id: "a", name: "Acme" };
const req = { kind: "workspace", workspaceId: "a" };

test("cold load keeps the requested workspace pending", () => {
  assert.deepEqual(resolveBillingView(req, { loaded: false, error: false, workspaces: [] }), {
    kind: "workspaceLoading",
    workspaceId: "a",
  });
});
test("failed load offers retry, then resolves once the list arrives", () => {
  assert.deepEqual(resolveBillingView(req, { loaded: true, error: true, workspaces: [] }), {
    kind: "workspaceUnavailable",
    workspaceId: "a",
  });
  assert.deepEqual(resolveBillingView(req, { loaded: true, error: false, workspaces: [A] }), {
    kind: "workspace",
    workspace: A,
  });
});
test("a cached list still shows the workspace after a failed refresh", () => {
  assert.equal(
    resolveBillingView(req, { loaded: true, error: true, workspaces: [A] }).kind,
    "workspace"
  );
});
test("confirmed removal falls back to Personal and settles there", () => {
  const list = { loaded: true, error: false, workspaces: [] };
  assert.deepEqual(resolveBillingView(req, list), { kind: "personal" });
  assert.deepEqual(settleBillingRequest(req, list), { kind: "personal" });
});
test("an unresolved list never settles the request", () => {
  assert.deepEqual(settleBillingRequest(req, { loaded: false, error: false, workspaces: [] }), req);
  assert.deepEqual(settleBillingRequest(req, { loaded: true, error: true, workspaces: [] }), req);
});
test("Personal ignores the list", () => {
  assert.deepEqual(
    resolveBillingView({ kind: "personal" }, { loaded: false, error: true, workspaces: [A] }),
    { kind: "personal" }
  );
});
test("settling returns the same request object when unchanged", () => {
  const list = { loaded: true, error: false, workspaces: [A] };
  assert.equal(settleBillingRequest(req, list), req);
});
