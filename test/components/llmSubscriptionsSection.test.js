const test = require("node:test");
const assert = require("node:assert/strict");

const view = require("../../src/helpers/llmCli/llmCliSeatView.js");
const providers = require("../../src/helpers/llmCliProviders.js");

const NOT_ENABLED = { claudeEnabled: false };
const ENABLED = { claudeEnabled: true };

function actionsFor(seat, state, prefs = NOT_ENABLED, platform = "win32") {
  return view.seatViewModel(seat, state, prefs, platform).actions;
}

test("codex: actions per state", () => {
  assert.deepEqual(actionsFor("codex", { status: "missing" }), ["install", "redetect"]);
  assert.deepEqual(actionsFor("codex", { status: "outdated", version: "0.1.0" }), ["redetect"]);
  assert.deepEqual(actionsFor("codex", { status: "installed", authKnown: false }), [
    "signin",
    "test",
    "redetect",
  ]);
  assert.deepEqual(actionsFor("codex", { status: "signed-out" }), ["signin", "redetect"]);
  assert.deepEqual(actionsFor("codex", { status: "signed-in" }), ["test", "signout", "redetect"]);
  assert.deepEqual(actionsFor("codex", { status: "error", errorCode: "timeout" }), ["redetect"]);
  assert.deepEqual(actionsFor("codex", { status: "installing" }), ["cancelInstall"]);
  assert.deepEqual(actionsFor("codex", { status: "signing-in" }), ["cancelSignin"]);
});

test("codex: classified error maps to a known key, unknown code falls to generic", () => {
  const known = view.seatViewModel("codex", { status: "error", errorCode: "timeout" }, NOT_ENABLED);
  assert.equal(known.errorKey, "llmSubscriptions.errors.timeout");
  const unknown = view.seatViewModel(
    "codex",
    { status: "error", errorCode: "weird-vendor-text" },
    NOT_ENABLED
  );
  assert.equal(unknown.errorKey, "llmSubscriptions.errors.generic");
  const none = view.seatViewModel("codex", { status: "error" }, NOT_ENABLED);
  assert.equal(none.errorKey, "llmSubscriptions.errors.generic");
  assert.equal(
    view.seatViewModel("codex", { status: "signed-in" }, NOT_ENABLED).errorKey,
    null,
    "no error key when nothing failed"
  );
  assert.equal(view.errorMessageKey("not-signed-in"), "llmSubscriptions.errors.not-signed-in");
});

test("every classified error code has a message key", () => {
  for (const code of providers.ERROR_CODES) {
    assert.equal(view.errorMessageKey(code), `llmSubscriptions.errors.${code}`);
  }
});

test("an unrecognised status shows as missing, a missing state too", () => {
  assert.equal(view.seatViewModel("codex", { status: "bogus" }, NOT_ENABLED).status, "missing");
  assert.equal(view.seatViewModel("codex", undefined, NOT_ENABLED).status, "missing");
});

test("outdated seat carries the update hint and the version", () => {
  const vm = view.seatViewModel("codex", { status: "outdated", version: "0.1.0" }, NOT_ENABLED);
  assert.equal(vm.hintKey, "llmSubscriptions.outdatedHint");
  assert.equal(vm.version, "0.1.0");
});

test("unknown seat throws", () => {
  assert.throws(() => view.seatViewModel("gemini", { status: "missing" }, NOT_ENABLED));
});
