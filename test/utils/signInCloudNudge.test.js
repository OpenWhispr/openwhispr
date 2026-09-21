const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/signInCloudNudge.ts");

const NOW = 1_700_000_000_000;
const UNMANAGED = { status: "unmanaged", policy: null, appVersion: null };

const decide = async (overrides) => {
  const { decideSignInCloudNudge } = await load();
  return decideSignInCloudNudge({
    promptedAt: NOW - 60_000,
    now: NOW,
    isSignedIn: true,
    policy: UNMANAGED,
    transcriptionMode: "providers",
    ...overrides,
  });
};

const managedPolicy = (allowedModes) => ({
  status: "managed",
  appVersion: "1.10.0",
  policy: {
    version: 1,
    transcription: { allowedModes, allowedByokProviders: [], allowedEnterpriseProviders: [] },
    llm: { allowedModes: [], allowedByokProviders: [], allowedEnterpriseProviders: [] },
    features: { agentEnabled: false, webSearchEnabled: false },
    sharing: { externalLinkSharing: "disabled" },
    dataRetention: {
      audioRetentionMaxDays: null,
      localHistoryMode: "user_choice",
      cloudBackupAllowed: false,
    },
    minAppVersion: null,
  },
});

test("a signed-in user on their own dictation setup is nudged towards Cloud", async () => {
  for (const transcriptionMode of ["local", "providers", "self-hosted"]) {
    assert.equal(await decide({ transcriptionMode }), "nudge", transcriptionMode);
  }
});

test("dictation already on Cloud needs no nudge", async () => {
  assert.equal(await decide({ transcriptionMode: "openwhispr" }), "skip");
});

test("it waits for the sign-in and for the account's policy to settle", async () => {
  assert.equal(await decide({ isSignedIn: false }), "wait");
  // A failed load is retried on the next identity refresh, and the prompt window
  // absorbs that; dropping the marker here would lose the nudge to a flaky connection.
  for (const status of ["idle", "loading", "error"]) {
    assert.equal(await decide({ policy: { ...UNMANAGED, status } }), "wait", status);
  }
});

test("a policy that forbids Cloud gets no nudge", async () => {
  assert.equal(await decide({ policy: managedPolicy(["local", "providers"]) }), "skip");
  assert.equal(await decide({ policy: managedPolicy(["openwhispr", "providers"]) }), "nudge");
});

test("a prompt that is too old or unreadable is dropped", async () => {
  const { SIGN_IN_CLOUD_NUDGE_WINDOW_MS } = await load();
  assert.equal(await decide({ promptedAt: NOW - SIGN_IN_CLOUD_NUDGE_WINDOW_MS }), "nudge");
  assert.equal(await decide({ promptedAt: NOW - SIGN_IN_CLOUD_NUDGE_WINDOW_MS - 1 }), "skip");
  assert.equal(await decide({ promptedAt: Number.NaN }), "skip");
  assert.equal(await decide({ promptedAt: Number.NaN, isSignedIn: false }), "skip");
});
