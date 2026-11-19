import { useSyncExternalStore } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { usePolicyStore } from "../stores/policyStore";
import { isCloudBackupAllowed } from "../stores/policyRules";
import { readIsSubscribed, subscribeIsSubscribed } from "../lib/subscriptionFlag";

/** Whether Cloud backup is running: signed in, on a paid plan, switched on and allowed. */
export function useCloudBackupActive(): boolean {
  const isSignedIn = useSettingsStore((state) => state.isSignedIn);
  const backupEnabled = useSettingsStore((state) => state.cloudBackupEnabled);
  const isSubscribed = useSyncExternalStore(subscribeIsSubscribed, readIsSubscribed);
  const allowedByPolicy = usePolicyStore(isCloudBackupAllowed);
  return isSignedIn && backupEnabled && isSubscribed && allowedByPolicy;
}
