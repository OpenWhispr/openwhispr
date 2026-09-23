const test = require("node:test");
const assert = require("node:assert/strict");

const loadState = () => import("../../../src/helpers/connectors/connectorPolicy.js");
const loadValidation = () => import("../../../src/helpers/policyValidation.js");
const loadRules = () => import("../../../src/stores/policyRules.ts");

function policy(features) {
  return {
    version: 1,
    transcription: { allowedModes: ["local"], allowedByokProviders: [] },
    llm: { allowedModes: ["local"], allowedByokProviders: [], allowedEnterpriseProviders: [] },
    features: { agentEnabled: true, webSearchEnabled: true, ...features },
    sharing: { externalLinkSharing: "allowed" },
    dataRetention: { audioRetentionMaxDays: null, localHistoryMode: "user_choice", cloudBackupAllowed: true },
    minAppVersion: null,
  };
}

test("every failed or malformed snapshot fails closed", async () => {
  const { connectorPolicyState } = await loadState();
  // Every code workspacePolicyManager.js can return with success: false, plus
  // a code it may gain later: none of them may allow an action.
  for (const code of [
    "POLICY_UNRESOLVABLE",
    "POLICY_UNAVAILABLE",
    "AUTH_CONTEXT_CHANGED",
    "POLICY_RETRY_THROTTLED",
    "SOME_FUTURE_CODE",
  ]) {
    assert.equal(connectorPolicyState({ success: false, status: "error", code }), "unavailable", code);
  }
  assert.equal(connectorPolicyState(null), "unavailable");
  assert.equal(connectorPolicyState(undefined), "unavailable");
  assert.equal(connectorPolicyState({ success: true }), "unavailable");
  assert.equal(connectorPolicyState({ success: true, managed: "yes", policy: null }), "unavailable");
  assert.equal(connectorPolicyState({ success: true, managed: true, policy: null }), "unavailable");
  assert.equal(connectorPolicyState({ success: true, managed: true, policy: { features: null } }), "unavailable");
});

test("a valid snapshot allows unless a managed policy turns connectors off", async () => {
  const { connectorPolicyState } = await loadState();
  assert.equal(connectorPolicyState({ success: true, managed: true, policy: policy({ connectorsEnabled: false }) }), "blocked");
  assert.equal(connectorPolicyState({ success: true, managed: true, policy: policy({ connectorsEnabled: true }) }), "allowed");
  assert.equal(connectorPolicyState({ success: true, managed: true, policy: policy({}) }), "allowed");
  assert.equal(connectorPolicyState({ success: true, managed: false, policy: null }), "allowed");
  assert.equal(
    connectorPolicyState({ success: true, status: "cached", managed: true, policy: policy({}) }),
    "allowed"
  );
});

test("the desktop validator accepts the field when absent or boolean, and rejects other types", async () => {
  const { isValidPolicyShape } = await loadValidation();
  assert.equal(isValidPolicyShape(policy({})), true);
  assert.equal(isValidPolicyShape(policy({ connectorsEnabled: false })), true);
  assert.equal(isValidPolicyShape(policy({ connectorsEnabled: "no" })), false);
});

test("the renderer rule mirrors the switch", async () => {
  const { isConnectorsAllowed } = await loadRules();
  const managed = (features) => ({ status: "managed", appVersion: "1.10.0", policy: policy(features) });
  assert.equal(isConnectorsAllowed(managed({ connectorsEnabled: false })), false);
  assert.equal(isConnectorsAllowed(managed({})), true);
  assert.equal(isConnectorsAllowed({ status: "unmanaged", appVersion: "1.10.0", policy: null }), true);
});
