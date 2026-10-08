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
  /** Sends, posts or files for the user, so the model still writes the text itself. */
  delivers?: boolean;
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

/** Connector names by connectorId, as the prompt names them. */
export const CONNECTOR_NAMES: Readonly<Record<string, string>> = {
  email: "Email",
  slack: "Slack",
  linear: "Linear",
  github: "GitHub",
};

// Connectors the user connects one by one. Email always works (it falls back to
// the user's mail app) and the email_draft tool reports Gmail's own state.
const CONNECTED_ONE_BY_ONE = ["slack", "linear", "github"];

const CONNECTORS_NAME = `Integrations (${Object.values(CONNECTOR_NAMES).join(", ")})`;

export function resolveUnavailableCapabilities(
  input: UnavailableCapabilityInput
): UnavailableCapability[] {
  const { locations } = input;
  if (!input.supportsTools) {
    const tools = ["web search", "calendar", "searching or changing notes"];
    if (input.connectors) tools.push("integrations");
    return [
      { name: `Tools (${tools.join(", ")})`, reason: "modelTooSmall", where: locations.models },
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

  // Every connector entry is about sending for the user, never about writing the text.
  const unavailableConnector = (name: string, reason: UnavailableReason, where?: string): void => {
    unavailable.push({ name, reason, ...(where ? { where } : {}), delivers: true });
  };

  if (!input.isSignedIn) {
    unavailableConnector(CONNECTORS_NAME, "signedOut", locations.account);
  } else if (connectors.blockedByOrg) {
    // Before the plan: paying wouldn't help while the organization keeps them off.
    unavailableConnector(CONNECTORS_NAME, "policyOff");
  } else if (!connectors.hasPlan) {
    unavailableConnector(CONNECTORS_NAME, "planRequired", locations.plans);
  } else if (!connectors.allowed) {
    unavailableConnector(CONNECTORS_NAME, "policyLoading");
  } else {
    for (const id of CONNECTED_ONE_BY_ONE) {
      const status = connectors.statuses[id];
      // Unknown (status not loaded) says nothing; a build without the
      // provider's client hides its row, so there's nothing to connect.
      if (!status || status.configured === false) continue;
      if (!status.connected) {
        unavailableConnector(CONNECTOR_NAMES[id], "notConnected", locations.connectors);
      } else if (status.needsReconnect) {
        unavailableConnector(CONNECTOR_NAMES[id], "needsReconnect", locations.connectors);
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
      return `${name}: the selected model runs without tools (small or unrecognized local models do); the user can choose a larger model or a cloud provider${at}. You can still use anything already in this prompt, such as note text, and write any text the user asks for.`;
  }
}

const describeList = (items: ReadonlyArray<UnavailableCapability>): string =>
  items.map((item) => `- ${describeOne(item)}`).join("\n");

export function describeUnavailable(unavailable: ReadonlyArray<UnavailableCapability>): string {
  const other = unavailable.filter((item) => !item.delivers);
  const delivering = unavailable.filter((item) => item.delivers);
  const sections: string[] = [];
  if (other.length > 0) {
    sections.push(
      "Not available in this conversation. If the user asks for one of these, briefly tell them " +
        "how to enable it instead of attempting it or saying it's impossible:\n" +
        describeList(other)
    );
  }
  if (delivering.length > 0) {
    // Writing the text never needed a connector: only sending it does.
    sections.push(
      "You can't send, post, file or look anything up through these in this conversation. " +
        "When the user asks for an email, message, issue or comment, still write it in full in " +
        "your reply, then end with one short sentence on how they can have you send it for them " +
        '(for example: "Connect Slack and I can post this for you."); leave that sentence out ' +
        "when only their admin can turn it on. For anything else, briefly tell them how to " +
        "enable it:\n" +
        describeList(delivering)
    );
  }
  return sections.join("\n\n");
}
