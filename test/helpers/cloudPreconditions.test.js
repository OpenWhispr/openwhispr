const test = require("node:test");
const assert = require("node:assert/strict");

const {
  checkCloudPreconditions,
  NOT_CONFIGURED,
  NOT_AUTHENTICATED,
} = require("../../src/helpers/cloudPreconditions");

test("missing API URL is an expected state, not an error", () => {
  const gate = checkCloudPreconditions("", { Authorization: "Bearer t" });
  assert.equal(gate.ok, false);
  assert.equal(gate.result.success, false);
  assert.equal(gate.result.code, NOT_CONFIGURED);
  // The renderer gates on `success`; a bare null told it nothing about why.
  assert.equal(typeof gate.result.error, "string");
});

test("empty auth header is an expected state, not an error", () => {
  const gate = checkCloudPreconditions("https://api.example.com", {});
  assert.equal(gate.ok, false);
  assert.equal(gate.result.code, NOT_AUTHENTICATED);
});

test("a missing auth header is treated as unauthenticated", () => {
  for (const header of [undefined, null]) {
    const gate = checkCloudPreconditions("https://api.example.com", header);
    assert.equal(gate.ok, false);
    assert.equal(gate.result.code, NOT_AUTHENTICATED);
  }
});

test("an unconfigured URL is reported before authentication", () => {
  // Both preconditions fail; the actionable one for a local-only user is the URL.
  const gate = checkCloudPreconditions("", {});
  assert.equal(gate.result.code, NOT_CONFIGURED);
});

test("both preconditions met lets the caller proceed", () => {
  const gate = checkCloudPreconditions("https://api.example.com", {
    Cookie: "session=abc",
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.result, undefined);
});
