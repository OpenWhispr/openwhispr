export function updatePolicyMessageKey(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  if (error.code === "UPDATES_MANAGED_BY_ORG") {
    return "settingsPage.general.updates.itManaged";
  }
  if (error.code === "UPDATE_POLICY_UNAVAILABLE") {
    return "settingsPage.general.updates.policyUnavailable";
  }
  if (error.code === "UPDATE_POLICY_CHANGED") {
    return "settingsPage.general.updates.policyChanged";
  }
  return null;
}
