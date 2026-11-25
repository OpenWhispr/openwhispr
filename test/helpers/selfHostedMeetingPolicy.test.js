const test = require("node:test");
const assert = require("node:assert/strict");
const { managedPolicy } = require("./harness/policyFixtures");
const {
  productOperationAllowed,
  realtimeSelection,
  runningOperationAllowed,
} = require("../../src/helpers/productPolicy.js");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const selfHosted = {
  provider: "openai-compatible-realtime",
  mode: "self-hosted",
  url: "ws://127.0.0.1:9000/v1/realtime",
  model: "whisper",
};
const managed = (allowedModes) => ({
  success: true,
  managed: true,
  accountId: "account",
  policy: managedPolicy({ transcription: { allowedModes } }),
});

test("the self-hosted realtime provider is judged as Self-Hosted, whatever mode it claims", () => {
  for (const mode of ["self-hosted", "openwhispr", "byok", undefined]) {
    assert.deepEqual(realtimeSelection({ ...selfHosted, mode }), {
      mode: "self-hosted",
      provider: "openai-compatible",
    });
  }
});

test("main-process meeting policy allows a self-hosted meeting only where Self-Hosted is allowed", () => {
  for (const [modes, expected] of [
    [["self-hosted"], true],
    [["openwhispr", "self-hosted"], true],
    [["openwhispr"], false],
    [["local", "providers"], false],
  ]) {
    assert.equal(
      productOperationAllowed(managed(modes), "1.12.0", "meeting-transcription", [selfHosted]),
      expected,
      modes.join(",")
    );
  }
  // OpenWhispr's own realtime stays a cloud selection.
  const cloud = { provider: "openai-realtime", mode: "openwhispr" };
  assert.equal(
    productOperationAllowed(managed(["self-hosted"]), "1.12.0", "meeting-transcription", [cloud]),
    false
  );
});

test("a live self-hosted meeting is revoked when the policy drops Self-Hosted", () => {
  const allowed = runningOperationAllowed(
    managed(["self-hosted"]),
    "account",
    "1.12.0",
    "meeting-transcription",
    [selfHosted]
  );
  const revoked = runningOperationAllowed(
    managed(["openwhispr"]),
    "account",
    "1.12.0",
    "meeting-transcription",
    [selfHosted]
  );
  assert.deepEqual([allowed, revoked], [true, false]);
});

test("a managed member keeps Self-Hosted Note Recording only where the policy allows it", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "self-hosted-meeting-policy-" });
  const { useSettingsStore, selectPolicyEffectiveSettings } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  const raw = { ...useSettingsStore.getState(), meetingTranscriptionMode: "self-hosted" };
  const snapshot = (allowedModes) => ({
    status: "managed",
    appVersion: "1.12.0",
    policy: managedPolicy({ transcription: { allowedModes } }),
  });

  const kept = selectPolicyEffectiveSettings(raw, snapshot(["openwhispr", "self-hosted"]));
  assert.equal(kept.meetingTranscriptionMode, "self-hosted");
  const reconciled = selectPolicyEffectiveSettings(raw, snapshot(["openwhispr"]));
  assert.equal(reconciled.meetingTranscriptionMode, "openwhispr");
});
