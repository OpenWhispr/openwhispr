import { bareEmailAddress } from "../../../helpers/connectors/emailCompose";
import type { ConnectorEdits, ConnectorPreview } from "../../../types/connectors";

// Destinations and recipient order can be canonicalized; message text and
// code retain their case, whitespace and line breaks.
const DESTINATION_FIELDS = new Set(["to", "cc", "destination", "repo", "target", "team", "issue"]);
function normalize(value: unknown, field = ""): unknown {
  if (typeof value === "string") {
    return DESTINATION_FIELDS.has(field) ? value.replace(/\s+/g, " ").trim().toLowerCase() : value;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, field)).sort();
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((name) => [name, normalize((value as Record<string, unknown>)[name], name)])
    );
  }
  return value;
}

// cyrb53: a fast 53-bit string hash. Synchronous, so a tool still claims its
// turn slots before its first await.
function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * The connector, action, destination and content, for this turn's duplicate
 * guard and an earlier request's "sent before" note.
 */
export function connectorActionKey(
  connectorId: string,
  action: string,
  args: Record<string, unknown>
): string {
  return `${connectorId}.${action}:${hash53(JSON.stringify(normalize(args)))}`;
}

/** The resolved destination and the fields actually shown for Send. */
export function approvalActionKey(
  connectorId: string,
  action: string,
  args: Record<string, unknown>,
  preview: Pick<ConnectorPreview, "destinationLabel" | "fields" | "title" | "body">,
  fields: ConnectorEdits = preview.fields ?? {
    ...(preview.title !== undefined ? { title: preview.title } : {}),
    body: preview.body,
  }
): string {
  const approved: Record<string, unknown> = { ...args, ...fields };
  if (connectorId === "gmail") {
    for (const field of ["to", "cc"]) {
      if (Array.isArray(approved[field])) approved[field] = approved[field].map(bareEmailAddress);
    }
  } else if (connectorId === "slack") {
    approved.destination = preview.destinationLabel;
    approved.text = fields.body;
    delete approved.body;
  } else if (connectorId === "github") {
    approved[action === "comment" ? "target" : "repo"] = preview.destinationLabel;
  } else if (connectorId === "linear") {
    approved[action === "comment" ? "issue" : "team"] = preview.destinationLabel;
    if (action === "create_issue") {
      approved.description = fields.body;
      delete approved.body;
    }
  }
  return connectorActionKey(connectorId, action, approved);
}
