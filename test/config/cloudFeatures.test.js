const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/config/cloudFeatures.ts");

test("the registry lists exactly the dropped cloud features", async () => {
  const { CLOUD_ONLY_FEATURES } = await load();
  assert.deepEqual(
    [...CLOUD_ONLY_FEATURES].sort(),
    [
      "cloudBackup",
      "enterpriseCheckout",
      "leaderboard",
      "referral",
      "shareLink",
      "signInCloudNudge",
      "teamJoin",
      "upgradePrompt",
      "workspaceSwitcher",
    ].sort()
  );
});

test("every cloud-only feature is hidden when cloud is disabled and shown when enabled", async () => {
  const { CLOUD_ONLY_FEATURES, cloudFeatureVisible } = await load();
  for (const id of CLOUD_ONLY_FEATURES) {
    assert.equal(cloudFeatureVisible(id, false), false, `${id} hidden in a fork build`);
    assert.equal(cloudFeatureVisible(id, true), true, `${id} shown upstream`);
  }
});
