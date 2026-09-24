export type ConnectorPolicyState = "allowed" | "blocked" | "unavailable";

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
}

export interface ConnectorEdits {
  title?: string;
  body?: string;
}

export type ConnectorPrepareResult =
  | { status: "ready"; actionId: string; preview: ConnectorPreview }
  | { status: "needs_clarification"; message: string; candidates: string[] }
  | { status: "failed"; errorCode: string; message: string }
  | { status: "unavailable"; reason: string };

export type ConnectorCommitResult =
  | { state: "sent"; url?: string }
  | { state: "failed"; errorCode: string; message: string }
  | { state: "unknown"; checkUrl?: string }
  | { state: "not_sent"; reason: string };

export type ConnectorDirectResult =
  | { state: "sent"; destinationLabel: string; bodyCopied?: boolean; subjectCopied?: boolean }
  | { state: "failed"; errorCode: string; message: string; destinationLabel?: string }
  | { state: "unavailable"; reason: string }
  | { state: "not_sent"; reason: string };

export type ApprovalOutcome =
  | { state: "sent"; url?: string; finalText?: string }
  | { state: "failed"; errorCode: string; message: string }
  | { state: "unknown"; checkUrl?: string }
  | { state: "cancelled" }
  | { state: "not_sent"; reason: string };

export interface ConnectorStatus {
  id: string;
  connected: boolean;
  accountLabel: string | null;
}

export interface ConnectorActionRecord {
  id: string;
  connector: string;
  action: string;
  kind: "approval" | "direct";
  destinationLabel: string | null;
  state: string;
  resultUrl: string | null;
  errorCode: string | null;
  createdAt: string;
}

export interface ContactMatch {
  name: string | null;
  email: string;
  lastMet: string | null;
}
