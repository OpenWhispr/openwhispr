import { DOCS_ORIGIN } from "../helpers/productHelpFallback";
import type { ConnectionTarget } from "../types/agentInteractions";
import type { CalendarProvider } from "../utils/calendarConnect";
import { getCachedPlatform } from "../utils/platform";

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
  /** The user can connect it from the chat: request_connection's target for it. */
  connectTarget?: ConnectionTarget;
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
  /** What request_connection can connect in this conversation (none without interactions). */
  connectionTargets?: readonly ConnectionTarget[];
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
const CONNECTED_ONE_BY_ONE: ConnectionTarget[] = ["slack", "linear", "github"];

/**
 * What request_connection can connect, as the model reads it. Cards use these
 * brand names too, but translate the generic calendar.
 */
export const CONNECTION_TARGET_NAMES: Readonly<Record<ConnectionTarget, string>> = {
  gmail: "Gmail",
  slack: CONNECTOR_NAMES.slack,
  linear: CONNECTOR_NAMES.linear,
  github: CONNECTOR_NAMES.github,
  google: "Google Calendar",
  microsoft: "Microsoft Calendar",
  apple: "Apple Calendar",
  calendar: "a calendar",
};

/** The calendar providers the chat can connect; Apple Calendar only on macOS. */
export function calendarProviders(): CalendarProvider[] {
  return getCachedPlatform() === "darwin"
    ? ["google", "microsoft", "apple"]
    : ["google", "microsoft"];
}

const CONNECTORS_NAME = `Integrations (${Object.values(CONNECTOR_NAMES).join(", ")})`;
const GMAIL_TO_SEND =
  "Gmail, to send email from here (without it, email_draft opens a draft in the user's email app)";

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
  const connectable = (target: ConnectionTarget) =>
    input.connectionTargets?.includes(target) ? { connectTarget: target } : {};

  if (!input.isSignedIn) {
    unavailable.push({ name: "Web search", reason: "signedOut", where: locations.account });
  } else if (!input.webSearch.allowed) {
    unavailable.push({
      name: "Web search",
      reason: input.webSearch.blockedByOrg ? "policyOff" : "policyLoading",
    });
  }

  if (!input.calendarConnected) {
    unavailable.push({
      name: "Calendar",
      reason: "notConnected",
      where: locations.calendars,
      ...connectable("calendar"),
    });
  }

  const connectors = input.connectors;
  if (!connectors) return unavailable;

  // Every connector entry is about sending for the user, never about writing the text.
  const unavailableConnector = (
    name: string,
    reason: UnavailableReason,
    where?: string,
    target?: ConnectionTarget
  ): void => {
    unavailable.push({
      name,
      reason,
      ...(where ? { where } : {}),
      delivers: true,
      ...(target ? connectable(target) : {}),
    });
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
        unavailableConnector(CONNECTOR_NAMES[id], "notConnected", locations.connectors, id);
      } else if (status.needsReconnect) {
        unavailableConnector(CONNECTOR_NAMES[id], "needsReconnect", locations.connectors, id);
      }
    }
    // Email works without Gmail (a draft in the user's mail app), so Gmail is
    // named only when the chat can connect it to send from here.
    if (input.connectionTargets?.includes("gmail")) {
      unavailableConnector(GMAIL_TO_SEND, "notConnected", locations.connectors, "gmail");
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
      return `${name}: the selected model runs without tools (small or unrecognized local models do); the user can choose a larger model or a cloud provider${at}. For OpenWhispr product questions, the user can open ${DOCS_ORIGIN} or inspect their current settings in Settings. You can still use anything already in this prompt, such as note text, and write any text the user asks for.`;
  }
}

const describeList = (items: ReadonlyArray<UnavailableCapability>): string =>
  items.map((item) => `- ${describeOne(item)}`).join("\n");

export function describeUnavailable(unavailable: ReadonlyArray<UnavailableCapability>): string {
  const connectable = unavailable.filter((item) => item.connectTarget);
  const other = unavailable.filter((item) => !item.delivers && !item.connectTarget);
  const delivering = unavailable.filter((item) => item.delivers && !item.connectTarget);
  const sections: string[] = [];
  if (connectable.length > 0) {
    sections.push(
      "Not connected yet, but the user can connect these right here. When the request needs " +
        "one, use its tools as usual: they ask the user to connect it first and then carry on. " +
        "To connect one that no tool of yours needs yet (Gmail, to send email from here), call " +
        "request_connection with its target. Don't just tell the user to connect it themselves:\n" +
        connectable
          .map(
            (item) =>
              `- ${item.name}${item.reason === "needsReconnect" ? ", connection expired" : ""} (target: ${item.connectTarget})`
          )
          .join("\n")
    );
  }
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
