export interface EnterpriseInferenceReadinessInput {
  authLoaded: boolean;
  policyResolved: boolean;
  isSignedIn: boolean;
  enterpriseStatus: "idle" | "loading" | "ready" | "error";
  enterpriseFailClosed: boolean;
}

export function isEnterpriseInferenceReady({
  authLoaded,
  policyResolved,
  isSignedIn,
  enterpriseStatus,
  enterpriseFailClosed,
}: EnterpriseInferenceReadinessInput): boolean {
  if (!authLoaded || !policyResolved) return false;
  if (!isSignedIn) return true;
  return enterpriseStatus === "ready" || (enterpriseStatus === "error" && !enterpriseFailClosed);
}
