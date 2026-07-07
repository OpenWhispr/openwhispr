const test = require("node:test");
const assert = require("node:assert/strict");

test("hosted sync requires account cloud backup and paid entitlement", async () => {
  const { canUseHostedSync } = await import("../../src/services/syncCapability.ts");

  assert.equal(
    canUseHostedSync({
      isSignedIn: true,
      cloudBackupEnabled: true,
      isSubscribed: true,
      isTrial: false,
    }),
    true
  );
  assert.equal(
    canUseHostedSync({
      isSignedIn: true,
      cloudBackupEnabled: true,
      isSubscribed: false,
      isTrial: true,
    }),
    true
  );
  assert.equal(
    canUseHostedSync({
      isSignedIn: false,
      cloudBackupEnabled: true,
      isSubscribed: true,
      isTrial: false,
    }),
    false
  );
  assert.equal(
    canUseHostedSync({
      isSignedIn: true,
      cloudBackupEnabled: false,
      isSubscribed: true,
      isTrial: false,
    }),
    false
  );
  assert.equal(
    canUseHostedSync({
      isSignedIn: true,
      cloudBackupEnabled: true,
      isSubscribed: false,
      isTrial: false,
    }),
    false
  );
});
