import type { CalendarAttendee } from "./calendar";
export type ConnectorPolicyState = "allowed" | "blocked" | "unavailable" | "signed_out";

export type ConnectorCancelReason = "cancelled_by_user" | "conversation_ended" | "expired";

export interface ConnectorPreviewNote {
  key: string;
  values?: Record<string, string>;
}

export interface ConnectorPreview {
  /** i18n suffix under connectors.approval.headers (e.g. "default", "post"). */
  verbKey: string;
  destinationLabel: string;
  accountLabel: string;
  workspaceLabel?: string;
  title?: string;
  body: string;
  notes?: ConnectorPreviewNote[];
  /**
   * A card layout's fields, e.g. an email's to, cc, subject and body. The
   * connector sets `body` to the same text as `fields.body`.
   */
  fields?: Record<string, string | string[]>;
}

/** What Send commits: a fields preview's fields, otherwise title and body. */
export interface ConnectorEdits {
  title?: string;
  body?: string;
  [field: string]: string | string[] | undefined;
}

export type ConnectorPrepareResult =
  | { status: "ready"; actionId: string; preview: ConnectorPreview }
  | { status: "needs_clarification"; message: string; candidates: string[] }
  | { status: "failed"; errorCode: string; message: string }
  | { status: "unavailable"; reason: string };

/** A value in a query item: flat, and capped in main (queryResult.js). */
export type ConnectorQueryValue = string | number | boolean | null | string[];

export type ConnectorQueryItem = Record<string, ConnectorQueryValue>;

export type ConnectorQueryResult =
  | { status: "ok"; items: ConnectorQueryItem[]; truncated: boolean }
  | { status: "needs_clarification"; message: string; candidates: string[] }
  | { status: "failed"; errorCode: string; message: string }
  | { status: "unavailable"; reason: string };

// destinationLabel: who the action went to, when Send could change the
// recipients (an edited email card). Absent means the prepared label stands.
export type ConnectorCommitResult =
  | { state: "sent"; url?: string; destinationLabel?: string; resultLabel?: string }
  | { state: "failed"; errorCode: string; message: string }
  | { state: "unknown"; checkUrl?: string; errorCode?: string; destinationLabel?: string }
  | { state: "not_sent"; reason: string; retryable?: boolean };

export type ConnectorDirectResult =
  | {
      state: "sent";
      destinationLabel: string;
      bodyCopied?: boolean;
      subjectCopied?: boolean;
      copyFailed?: boolean;
    }
  | { state: "failed"; errorCode: string; message: string; destinationLabel?: string }
  | { state: "unknown"; errorCode: string; message: string }
  | { state: "unavailable"; reason: string }
  | { state: "not_sent"; reason: string };

/** What the user changed on a card before pressing Send. */
export interface ApprovalEdits {
  /** The edited text of a card without fields, when the user changed it. */
  finalText?: string;
  /** A fields card's fields as the user left them, when they changed any. */
  final?: Record<string, string | string[]>;
}

export type ApprovalOutcome =
  | ({
      state: "sent";
      url?: string;
      /** Who it went to, when that differs from the prepared preview's label. */
      destinationLabel?: string;
      /** What the send created, when the connector names it ("ENG-124"). */
      resultLabel?: string;
    } & ApprovalEdits)
  | ({ state: "failed"; errorCode: string; message: string } & ApprovalEdits)
  | ({ state: "unknown"; checkUrl?: string; destinationLabel?: string } & ApprovalEdits)
  | { state: "cancelled" }
  | { state: "not_sent"; reason: string };

export interface ConnectorStatus {
  id: string;
  connected: boolean;
  /** False when the build can't connect this connector at all (Gmail without a Google OAuth client). */
  configured: boolean;
  accountLabel: string | null;
  workspaceLabel: string | null;
  needsReconnect: boolean;
}

export type ConnectorConnectResult =
  | { status: "connected"; accountLabel: string | null; workspaceLabel: string | null }
  | { status: "failed"; errorCode: string }
  | { status: "unavailable"; reason: string };

export type ConnectorDisconnectResult =
  /** grantKept: another login (Google Calendar) shares the provider's grant, so it wasn't revoked. */
  | { status: "disconnected"; grantKept?: boolean }
  | { status: "failed"; errorCode: string }
  | { status: "unavailable"; reason: string };

export type ConnectorActionState =
  "pending" | "committing" | "sent" | "failed" | "unknown" | "cancelled" | "expired";

export interface ConnectorActionRecord {
  id: string;
  connector: string;
  action: string;
  kind: "approval" | "direct";
  destinationLabel: string | null;
  state: ConnectorActionState;
  resultUrl: string | null;
  errorCode: string | null;
  createdAt: string;
}

/** A note attendee the user can address: never the user, a room or a resource. */
export interface NoteAttendee {
  name: string | null;
  email: string;
}

/** A note chat's meeting, for its attendee list (connector-note-attendees). */
export interface NoteAttendeesRequest {
  /** Its identified speakers are attendees too. */
  noteId: number | null;
  participants: CalendarAttendee[];
  /** Its calendar event, whose organizer is an attendee too. */
  calendarEventId: string | null;
  /** The signed-in user's OpenWhispr address, never listed. */
  selfEmail: string | null;
}

export interface ContactMatch {
  name: string | null;
  email: string;
  lastMet: string | null;
}
