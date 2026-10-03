/**
 * What the assistant can't do in this conversation, and why. Named in the
 * system prompt so the model tells the user how to turn a capability on
 * instead of claiming it's impossible (or attempting it without a tool).
 */

export type UnavailableReason =
  | "signedOut"
  | "policyOff"
  | "policyLoading"
  | "planRequired"
  | "notConnected"
  | "needsReconnect"
  | "modelTooSmall";

export interface UnavailableCapability {
  name: string;
  reason: UnavailableReason;
  /** Where in the app the user fixes it, as the UI labels it. */
  where?: string;
}

/** Where each fix lives, as the UI labels it (localized by the caller). */
export interface CapabilityLocations {
  account: string;
  plans: string;
  calendars: string;
  connectors: string;
  models: string;
}

export interface ConnectorAvailability {
  connected: boolean;
  configured: boolean;
  needsReconnect: boolean;
}

export interface UnavailableCapabilityInput {
  /** False when the selected model gets no tools at all (a small local model). */
  supportsTools: boolean;
  isSignedIn: boolean;
  webSearch: { allowed: boolean; blockedByOrg: boolean };
  calendarConnected: boolean;
  /** Omitted on surfaces that never offer connectors (container chat, onboarding demo). */
  connectors?: {
    hasPlan: boolean;
    allowed: boolean;
    blockedByOrg: boolean;
    statuses: Readonly<Record<string, ConnectorAvailability>>;
  };
  locations: CapabilityLocations;
}

// Connectors the user connects one by one. Email always works (it falls back to
// the user's mail app) and the email_draft tool reports Gmail's own state.
const CONNECTOR_NAMES: ReadonlyArray<readonly [id: string, name: string]> = [
  ["slack", "Slack"],
  ["linear", "Linear"],
  ["github", "GitHub"],
];

const CONNECTORS_NAME = "Integrations (email, Slack, Linear, GitHub)";

export function resolveUnavailableCapabilities(
  input: UnavailableCapabilityInput
): UnavailableCapability[] {
  const { locations } = input;
  if (!input.supportsTools) {
    return [
      {
        name: "Tools (web search, notes, calendar, integrations)",
        reason: "modelTooSmall",
        where: locations.models,
      },
    ];
  }

  const unavailable: UnavailableCapability[] = [];

  if (!input.isSignedIn) {
    unavailable.push({ name: "Web search", reason: "signedOut", where: locations.account });
  } else if (!input.webSearch.allowed) {
    unavailable.push({
      name: "Web search",
      reason: input.webSearch.blockedByOrg ? "policyOff" : "policyLoading",
    });
  }

  if (!input.calendarConnected) {
    unavailable.push({ name: "Calendar", reason: "notConnected", where: locations.calendars });
  }

  const connectors = input.connectors;
  if (!connectors) return unavailable;

  if (!input.isSignedIn) {
    unavailable.push({ name: CONNECTORS_NAME, reason: "signedOut", where: locations.account });
  } else if (!connectors.hasPlan) {
    unavailable.push({ name: CONNECTORS_NAME, reason: "planRequired", where: locations.plans });
  } else if (connectors.blockedByOrg) {
    unavailable.push({ name: CONNECTORS_NAME, reason: "policyOff" });
  } else if (!connectors.allowed) {
    unavailable.push({ name: CONNECTORS_NAME, reason: "policyLoading" });
  } else {
    for (const [id, name] of CONNECTOR_NAMES) {
      const status = connectors.statuses[id];
      // Unknown (status not loaded) says nothing; a build without the
      // provider's client hides its row, so there's nothing to connect.
      if (!status || status.configured === false) continue;
      if (!status.connected) {
        unavailable.push({ name, reason: "notConnected", where: locations.connectors });
      } else if (status.needsReconnect) {
        unavailable.push({ name, reason: "needsReconnect", where: locations.connectors });
      }
    }
  }

  return unavailable;
}

function describeOne({ name, reason, where }: UnavailableCapability): string {
  const at = where ? ` in ${where}` : "";
  switch (reason) {
    case "signedOut":
      return `${name}: needs the user to sign in to OpenWhispr${at}.`;
    case "policyOff":
      return `${name}: turned off by the user's organization; only their admin can turn it back on.`;
    case "policyLoading":
      return `${name}: not available right now; the user can try again in a moment.`;
    case "planRequired":
      return `${name}: needs a paid OpenWhispr plan${at}.`;
    case "notConnected":
      return `${name}: not connected; the user can connect it${at}.`;
    case "needsReconnect":
      return `${name}: the connection has expired; the user can reconnect it${at}.`;
    case "modelTooSmall":
      return `${name}: the selected model runs without tools (small or unrecognized local models do); the user can choose a larger model or a cloud provider${at}.`;
  }
}

export function describeUnavailable(unavailable: ReadonlyArray<UnavailableCapability>): string {
  if (unavailable.length === 0) return "";
  return (
    "Not available in this conversation. If the user asks for one of these, briefly tell them how " +
    "to enable it instead of attempting it or saying it's impossible:\n" +
    unavailable.map((item) => `- ${describeOne(item)}`).join("\n")
  );
}
