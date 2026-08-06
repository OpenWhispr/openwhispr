export type UpsellDecision = "show" | "hide" | "unknown";

export interface UpsellInput {
  authLoaded: boolean;
  isSignedIn: boolean;
  /** `null` while the entitlement is unresolved. */
  hasPaidAccess: boolean | null;
  isPastDue: boolean;
}

export function decideUpsell({
  authLoaded,
  isSignedIn,
  hasPaidAccess,
  isPastDue,
}: UpsellInput): UpsellDecision {
  if (!authLoaded) return "unknown";
  // Signed out there is no usage response to await; the upsell is the point.
  if (!isSignedIn) return "show";
  if (hasPaidAccess === null) return "unknown";
  // Past due already has its own banner, toast and recovery button.
  if (isPastDue || hasPaidAccess) return "hide";
  return "show";
}
