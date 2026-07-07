export interface HostedSyncCapabilityInput {
  isSignedIn: boolean;
  cloudBackupEnabled: boolean;
  isSubscribed: boolean;
  isTrial: boolean;
}

export function canUseHostedSync(input: HostedSyncCapabilityInput): boolean {
  return Boolean(
    input.isSignedIn &&
      input.cloudBackupEnabled &&
      (input.isSubscribed || input.isTrial)
  );
}
