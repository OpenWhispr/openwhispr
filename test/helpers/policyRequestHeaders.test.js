const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CLIENT_CAPABILITIES,
  POLICY_CAPABILITY_VERSION,
  withPolicyRequestHeaders,
} = require("../../src/helpers/policyRequestHeaders");

test("adds the exact policy capability, canonical app version and client capability headers", () => {
  assert.equal(POLICY_CAPABILITY_VERSION, "1");
  assert.equal(CLIENT_CAPABILITIES, "orukeet");
  assert.deepEqual(withPolicyRequestHeaders({ Authorization: "Bearer token" }, "1.8.1"), {
    Authorization: "Bearer token",
    "x-openwhispr-policy-version": "1",
    "x-openwhispr-version": "1.8.1",
    "x-openwhispr-capabilities": "orukeet",
  });
});

test("does not allow callers to override desktop policy capability headers", () => {
  assert.deepEqual(
    withPolicyRequestHeaders(
      {
        "x-openwhispr-policy-version": "2",
        "x-openwhispr-version": "0.0.1",
        "x-openwhispr-capabilities": "",
      },
      "1.8.1"
    ),
    {
      "x-openwhispr-policy-version": "1",
      "x-openwhispr-version": "1.8.1",
      "x-openwhispr-capabilities": "orukeet",
    }
  );
});

test("rejects a non-canonical app version instead of advertising a malformed client", () => {
  assert.throws(() => withPolicyRequestHeaders({}, "1.8"), /canonical app version/i);
  assert.throws(() => withPolicyRequestHeaders({}, "1.8.1-beta.1"), /canonical app version/i);
});
