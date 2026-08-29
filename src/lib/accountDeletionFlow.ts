export type LocalCleanupFailure =
  "local-account-data" | "workspace-session-state" | "auth-session" | "device-data";

export interface AccountDeletionDependencies {
  deleteRemoteAccount: () => Promise<void>;
  deleteLocalAccountData: () => Promise<void>;
  clearWorkspaceSessionState: () => Promise<void>;
  signOut: () => Promise<void>;
  eraseDeviceData: () => Promise<void>;
}

export interface AccountDeletionResult {
  localCleanupFailures: LocalCleanupFailure[];
}

interface ExecuteAccountDeletionOptions {
  eraseDeviceData: boolean;
  dependencies: AccountDeletionDependencies;
}

async function recordLocalFailure(
  operation: () => Promise<void>,
  failure: LocalCleanupFailure,
  failures: LocalCleanupFailure[]
): Promise<void> {
  try {
    await operation();
  } catch {
    failures.push(failure);
  }
}

export async function executeAccountDeletion({
  eraseDeviceData,
  dependencies,
}: ExecuteAccountDeletionOptions): Promise<AccountDeletionResult> {
  await dependencies.deleteRemoteAccount();

  const localCleanupFailures: LocalCleanupFailure[] = [];
  await recordLocalFailure(
    dependencies.deleteLocalAccountData,
    "local-account-data",
    localCleanupFailures
  );
  await recordLocalFailure(
    dependencies.clearWorkspaceSessionState,
    "workspace-session-state",
    localCleanupFailures
  );
  await recordLocalFailure(dependencies.signOut, "auth-session", localCleanupFailures);

  if (eraseDeviceData) {
    await recordLocalFailure(dependencies.eraseDeviceData, "device-data", localCleanupFailures);
  }

  return { localCleanupFailures };
}
