const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/agentAccessPolicy.js");

test("the assistant opens when policy allows it", async () => {
  const { resolveAgentAccessRefusal } = await load();
  assert.equal(resolveAgentAccessRefusal({ agentAllowed: true, policyResolved: true }), null);
  // Allowed is allowed, whatever is still loading.
  assert.equal(resolveAgentAccessRefusal({ agentAllowed: true, policyResolved: false }), null);
});

// An offline or failed policy fetch fails closed exactly like a restriction, and
// telling the user their org blocked something it never blocked is a lie.
test("an org restriction and an unresolved policy explain themselves differently", async () => {
  const { resolveAgentAccessRefusal, AGENT_REFUSAL_KEYS } = await load();
  assert.equal(
    resolveAgentAccessRefusal({ agentAllowed: false, policyResolved: true }),
    AGENT_REFUSAL_KEYS.agentRestricted
  );
  assert.equal(
    resolveAgentAccessRefusal({ agentAllowed: false, policyResolved: false }),
    AGENT_REFUSAL_KEYS.policyUnresolved
  );
});
