import type { UsageState } from "../lib/usageStore";
import {
  isConnectorsAllowed,
  isConnectorsBlockedByOrg,
  type PolicyDecisionSnapshot,
} from "../stores/policyRules";

/**
 * Connectors are paid-only (subscription or trial, like useUsage's
 * hasPaidAccess). Usage data is only loaded while a surface mounts useUsage(),
 * so other windows (the voice assistant) pass the persisted isSubscribed flag,
 * which the API also sets for trials.
 */
export function hasConnectorPlan(usage: UsageState, isSubscribedFlag: boolean): boolean {
  if (usage.status === "success") return usage.data.isSubscribed || usage.data.isTrial;
  return isSubscribedFlag;
}

export type ConnectorIneligibleReason = "signedOut" | "reauthRequired" | "planRequired";

export interface ConnectorEligibilityInput {
  /** True for an upstream build; a fork build has no OpenWhispr session, plan or org policy. */
  cloudEnabled: boolean;
  /** Fork build: the Titanium session (accountBound false = signed in from an old session). */
  titanium: { signedIn: boolean; accountBound: boolean; licensed: boolean };
  /** Upstream build: the OpenWhispr session, plan and org policy. */
  upstream: {
    isSignedIn: boolean;
    usage: UsageState;
    isSubscribed: boolean;
    policy: PolicyDecisionSnapshot;
  };
}

export interface ConnectorEligibility {
  /** The "paid plan" check: the Titanium license in a fork, the OpenWhispr plan upstream. */
  isPaid: boolean;
  blockedByOrg: boolean;
  /** False while an org policy loads or fails; a fork has none, so it is always true there. */
  connectorsAllowed: boolean;
  /** Why connectors are off for this user, or null. */
  reason: ConnectorIneligibleReason | null;
}

/**
 * Whether this user gets connectors (Settings rows and assistant tools). The main
 * process re-checks every action (titaniumConnectorPolicy.js); this only decides
 * what is shown and offered.
 */
export function connectorEligibilityFor(input: ConnectorEligibilityInput): ConnectorEligibility {
  if (!input.cloudEnabled) {
    const { signedIn, accountBound, licensed } = input.titanium;
    const reason: ConnectorIneligibleReason | null = !signedIn
      ? "signedOut"
      : !accountBound
        ? "reauthRequired"
        : !licensed
          ? "planRequired"
          : null;
    return { isPaid: reason === null, blockedByOrg: false, connectorsAllowed: true, reason };
  }
  const { isSignedIn, usage, isSubscribed, policy } = input.upstream;
  const hasPlan = hasConnectorPlan(usage, isSubscribed);
  return {
    isPaid: isSignedIn && hasPlan,
    blockedByOrg: isConnectorsBlockedByOrg(policy),
    connectorsAllowed: isConnectorsAllowed(policy),
    reason: !isSignedIn ? "signedOut" : !hasPlan ? "planRequired" : null,
  };
}

export type CalendarOAuthProvider = "google" | "microsoft";
export type CalendarOAuthConfigured = Record<CalendarOAuthProvider, boolean>;

/**
 * Whether a calendar's Connect may be offered: its OAuth client id must be in the
 * build (fork builds ship none). `null` is main's answer not having arrived yet;
 * Connect stays offered then and main refuses a flow without a client id.
 */
export function isCalendarOAuthConfigured(
  configured: CalendarOAuthConfigured | null,
  provider: CalendarOAuthProvider
): boolean {
  return configured === null ? true : configured[provider] !== false;
}

/**
 * Whether the Home "Connect your calendar" card is shown: only once main has
 * answered and at least one calendar OAuth client is in this build.
 */
export function shouldShowCalendarConnectCard(configured: CalendarOAuthConfigured | null): boolean {
  return configured !== null && (configured.google || configured.microsoft);
}
