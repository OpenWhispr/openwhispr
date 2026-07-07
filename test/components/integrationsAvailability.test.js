const test = require("node:test");
const assert = require("node:assert/strict");

test("local CLI and local MCP are available signed out", async () => {
  const { resolveIntegrationsAvailability } =
    await import("../../src/components/integrationsAvailability.ts");

  const state = resolveIntegrationsAvailability({
    isSignedIn: false,
    isPaid: false,
    isDesktopAppRunning: true,
  });

  assert.equal(state.localCli.usable, true);
  assert.equal(state.localMcp.usable, true);
  assert.equal(state.localMcp.route, "loopback");
});

test("hosted MCP and workspace API keys remain hosted-only", async () => {
  const { resolveIntegrationsAvailability } =
    await import("../../src/components/integrationsAvailability.ts");

  const free = resolveIntegrationsAvailability({
    isSignedIn: true,
    isPaid: false,
    isDesktopAppRunning: true,
  });
  const paid = resolveIntegrationsAvailability({
    isSignedIn: true,
    isPaid: true,
    isDesktopAppRunning: true,
  });

  assert.equal(free.hostedMcp.usable, false);
  assert.equal(free.hostedMcp.requiresHostedSubscription, true);
  assert.equal(free.workspaceApiKeys.usable, false);
  assert.equal(paid.hostedMcp.usable, true);
  assert.equal(paid.workspaceApiKeys.usable, true);
});
