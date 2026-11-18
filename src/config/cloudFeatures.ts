// Entry points to features that only exist with the hosted OpenWhispr cloud
// (FEAT-06). A fork build (CLOUD_ENABLED false) hides every one of them. Each mount
// site gates on cloudFeatureVisible explicitly, never on the OpenWhispr isSignedIn,
// which is only false in a fork by accident of the session never signing in.
// test/config/droppedFeatureGuard.test.js pins every mount site.
export const CLOUD_ONLY_FEATURES = [
  "referral",
  "leaderboard",
  "workspaceSwitcher",
  "teamJoin",
  "upgradePrompt",
  "signInCloudNudge",
  "cloudBackup",
  "enterpriseCheckout",
  "shareLink",
] as const;

export type CloudFeatureId = (typeof CLOUD_ONLY_FEATURES)[number];

export function cloudFeatureVisible(id: CloudFeatureId, cloudEnabled: boolean): boolean {
  return cloudEnabled || !CLOUD_ONLY_FEATURES.includes(id);
}
