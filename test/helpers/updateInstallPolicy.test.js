const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseAutoInstallEnv,
  shouldRegisterQuitHandler,
} = require("../../src/helpers/updateInstallPolicy");

test("defaults to auto-install when the env var is unset", () => {
  assert.equal(parseAutoInstallEnv(undefined), true);
});

test("defaults to auto-install when the env var is empty", () => {
  assert.equal(parseAutoInstallEnv(""), true);
});

test("only the literal string 'false' disables auto-install", () => {
  assert.equal(parseAutoInstallEnv("false"), false);
});

test("explicit 'true' keeps auto-install on", () => {
  assert.equal(parseAutoInstallEnv("true"), true);
});

test("garbage values fail open to the historical install-on-quit default", () => {
  assert.equal(parseAutoInstallEnv("no"), true);
  assert.equal(parseAutoInstallEnv("0"), true);
  assert.equal(parseAutoInstallEnv("FALSE"), true);
});

test("re-registers the quit hook only when enabling with a download pending", () => {
  assert.equal(shouldRegisterQuitHandler(true, true), true);
});

test("does not touch the quit hook when enabling with no pending download", () => {
  assert.equal(shouldRegisterQuitHandler(true, false), false);
});

test("does not touch the quit hook when disabling", () => {
  assert.equal(shouldRegisterQuitHandler(false, true), false);
  assert.equal(shouldRegisterQuitHandler(false, false), false);
});

test("rejects non-boolean inputs instead of coercing them", () => {
  assert.equal(shouldRegisterQuitHandler(1, 1), false);
  assert.equal(shouldRegisterQuitHandler("true", true), false);
  assert.equal(shouldRegisterQuitHandler(true, "yes"), false);
});
