const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isClientIdConfigured,
  assertClientIdConfigured,
} = require("../../src/helpers/calendarOAuthConfig");

test("a client id is configured only when it is a non-blank string", () => {
  assert.equal(isClientIdConfigured("abc.apps.googleusercontent.com"), true);
  for (const missing of [undefined, null, "", "   "]) {
    assert.equal(isClientIdConfigured(missing), false);
  }
});

test("starting a flow without a client id throws a typed not_configured error", () => {
  assert.throws(
    () => assertClientIdConfigured(undefined, "GOOGLE_CALENDAR_CLIENT_ID"),
    (error) => error.code === "not_configured" && /GOOGLE_CALENDAR_CLIENT_ID/.test(error.message)
  );
  assert.doesNotThrow(() => assertClientIdConfigured("id", "GOOGLE_CALENDAR_CLIENT_ID"));
});
