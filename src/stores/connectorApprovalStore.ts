import { create } from "zustand";
import type { ToolExecutionContext } from "../services/tools/ToolRegistry";
import type {
  ApprovalEdits,
  ApprovalOutcome,
  ConnectorCommitResult,
  ConnectorEdits,
  ConnectorPreview,
} from "../types/connectors";

export const APPROVAL_TTL_MS = 10 * 60 * 1000;

export type ApprovalState =
  "pending" | "committing" | "sent" | "failed" | "unknown" | "cancelled" | "not_sent";

type DraftFields = Record<string, string | string[]>;

/** What the card shows and what Send commits; starts as the preview. */
export interface ApprovalDraft {
  title?: string;
  body: string;
  /** A fields preview's fields (an email's to, cc, subject, body); Send commits these. */
  fields?: DraftFields;
}

export interface ApprovalEntry {
  /** approvalKey(messageId, toolCallId). */
  key: string;
  messageId: string;
  toolCallId: string;
  actionId: string;
  connectorId: string;
  preview: ConnectorPreview;
  draft: ApprovalDraft;
  state: ApprovalState;
  url?: string;
  message?: string;
  /** The connector's failure code, when state is "failed"; drives the card's translated copy. */
  errorCode?: string;
  /** Who a sent or unknown action went to, as main reported it after Send. */
  destinationLabel?: string;
  /** What a sent action created, as the connector named it ("ENG-124"). */
  resultLabel?: string;
  /** Shown on a pending card after a Send that could not run. */
  notice?: "policy_retry";
}

interface ApprovalStoreState {
  entries: Record<string, ApprovalEntry>;
}

export const useConnectorApprovalStore = create<ApprovalStoreState>(() => ({ entries: {} }));

/**
 * Providers may reuse tool-call ids across turns, so a card belongs to the
 * assistant message and the tool call together: a reused id on a new
 * message must never show, or settle, an old message's card.
 */
export function approvalKey(messageId: string, toolCallId: string): string {
  return `${messageId}::${toolCallId}`;
}

interface PendingResolution {
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  detach: () => void;
  signal: AbortSignal;
  expiresAt: number;
}

// Promise resolvers stay outside zustand state: they are not renderable.
const resolutions = new Map<string, PendingResolution>();

const COMMIT_RESULT_STATES = new Set(["sent", "failed", "unknown", "not_sent"]);

// Main passes an untyped CommonJS connector's result straight through, so a
// malformed commit result (wrong key, unrecognized state, or no result at
// all) must never be trusted at face value — it would otherwise leave the
// switch below with no matching case, and the approval would hang forever.
function isConnectorCommitResult(value: unknown): value is ConnectorCommitResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "state" in value &&
    typeof (value as { state: unknown }).state === "string" &&
    COMMIT_RESULT_STATES.has((value as { state: string }).state)
  );
}

// The draft owns its lists, so an edit can never reach back into the preview.
function copyFields(fields: DraftFields): DraftFields {
  return Object.fromEntries(
    Object.entries(fields).map(([name, value]) => [name, Array.isArray(value) ? [...value] : value])
  );
}

function sameValue(a: string | string[] | undefined, b: string | string[] | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => item === b[index]);
  }
  return a === b;
}

function fieldsDiffer(a: DraftFields, b: DraftFields): boolean {
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...names].some((name) => !sameValue(a[name], b[name]));
}

// An edit changes only a field the card lays out, and keeps its shape (a
// list stays a list), so the card always shows everything Send commits.
function mergeFields(current: DraftFields, patch: Partial<DraftFields>): DraftFields {
  const next = { ...current };
  for (const [name, value] of Object.entries(patch)) {
    if (value === undefined || !Object.hasOwn(current, name)) continue;
    if (Array.isArray(value) !== Array.isArray(current[name])) continue;
    next[name] = Array.isArray(value) ? [...value] : value;
  }
  return next;
}

function entryFor(key: string): ApprovalEntry | undefined {
  return useConnectorApprovalStore.getState().entries[key];
}

function patchEntry(key: string, patch: Partial<ApprovalEntry>): void {
  useConnectorApprovalStore.setState((state) => {
    const entry = state.entries[key];
    if (!entry) return state;
    return { entries: { ...state.entries, [key]: { ...entry, ...patch } } };
  });
}

function settle(
  key: string,
  outcome: ApprovalOutcome,
  state: ApprovalState,
  patch: Partial<ApprovalEntry> = {}
): void {
  const pending = resolutions.get(key);
  if (!pending) return;
  resolutions.delete(key);
  clearTimeout(pending.timer);
  pending.detach();
  patchEntry(key, { state, notice: undefined, ...patch });
  pending.resolve(outcome);
}

// Conversation end and expiry only withdraw a card that is still pending: a
// committing send may already have reached the provider.
function withdraw(key: string, reason: "conversation_ended" | "expired"): void {
  const entry = entryFor(key);
  if (!entry || entry.state !== "pending") return;
  void window.electronAPI?.connectorCancel?.(entry.actionId, reason);
  settle(key, { state: "not_sent", reason }, "not_sent");
}

// A Send whose policy check couldn't finish sent nothing, so the card goes
// back to pending. An abort or expiry that fired meanwhile — when only a
// pending card can be withdrawn — is applied now.
function returnToPending(key: string): void {
  patchEntry(key, { state: "pending", notice: "policy_retry" });
  const pending = resolutions.get(key);
  if (!pending) return;
  if (pending.signal.aborted) withdraw(key, "conversation_ended");
  else if (Date.now() >= pending.expiresAt) withdraw(key, "expired");
}

export function requestApproval(
  context: ToolExecutionContext,
  request: { actionId: string; connectorId: string; preview: ConnectorPreview }
): Promise<ApprovalOutcome> {
  const { messageId, toolCallId, signal } = context;
  const key = approvalKey(messageId, toolCallId);
  if (signal.aborted) {
    void window.electronAPI?.connectorCancel?.(request.actionId, "conversation_ended");
    return Promise.resolve({ state: "not_sent", reason: "conversation_ended" });
  }
  // A second request for the same message and tool call must never steal
  // the first card's resolver, timer or entry — that would cross-wire two
  // actions, and the loser's promise would never resolve.
  if (resolutions.has(key)) {
    void window.electronAPI?.connectorCancel?.(request.actionId, "cancelled_by_user");
    return Promise.resolve({ state: "not_sent", reason: "duplicate_tool_call" });
  }
  return new Promise((resolve) => {
    const onAbort = (): void => withdraw(key, "conversation_ended");
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => withdraw(key, "expired"), APPROVAL_TTL_MS);
    resolutions.set(key, {
      resolve,
      timer,
      detach: () => signal.removeEventListener("abort", onAbort),
      signal,
      expiresAt: Date.now() + APPROVAL_TTL_MS,
    });
    const draft: ApprovalDraft = {
      ...(request.preview.title !== undefined ? { title: request.preview.title } : {}),
      body: request.preview.body,
      ...(request.preview.fields !== undefined
        ? { fields: copyFields(request.preview.fields) }
        : {}),
    };
    useConnectorApprovalStore.setState((state) => ({
      entries: {
        ...state.entries,
        [key]: { key, messageId, toolCallId, ...request, draft, state: "pending" },
      },
    }));
    context.onApprovalRequested();
  });
}

export function updateApprovalDraft(
  key: string,
  patch: { title?: string; body?: string; fields?: Partial<DraftFields> }
): void {
  const entry = entryFor(key);
  if (!entry || entry.state !== "pending") return;
  const { fields } = entry.draft;
  patchEntry(key, {
    draft: {
      ...entry.draft,
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.title !== undefined && entry.preview.title !== undefined
        ? { title: patch.title }
        : {}),
      ...(patch.fields !== undefined && fields !== undefined
        ? { fields: mergeFields(fields, patch.fields) }
        : {}),
    },
  });
}

export function cancelApproval(key: string): void {
  const entry = entryFor(key);
  if (!entry || entry.state !== "pending") return;
  void window.electronAPI?.connectorCancel?.(entry.actionId, "cancelled_by_user");
  settle(key, { state: "cancelled" }, "cancelled");
}

// Send commits the draft (what the card shows), never an edit-mode snapshot:
// leaving edit mode must not discard the user's changes.
export async function approveAction(key: string): Promise<void> {
  const entry = entryFor(key);
  if (!entry || entry.state !== "pending") return;
  const { title, body, fields } = entry.draft;
  // A fields card commits its fields; main keeps only those the action declares.
  const edits: ConnectorEdits = fields
    ? copyFields(fields)
    : { ...(title !== undefined ? { title } : {}), body };
  // The expiry timer and abort listener stay armed while sending. They only
  // withdraw a pending card, and a Send that comes back retryable returns
  // the card to pending; settle() disarms them for every final outcome.
  patchEntry(key, { state: "committing", notice: undefined });

  let raw: unknown;
  try {
    raw = await window.electronAPI?.connectorCommit?.(entry.actionId, edits);
  } catch {
    // The request may have reached main and been sent; never claim it wasn't.
    raw = undefined;
  }
  // A missing or unrecognized result is exactly as uncertain as a thrown
  // IPC call — never let it fall through with no case to settle.
  const result: ConnectorCommitResult = isConnectorCommitResult(raw) ? raw : { state: "unknown" };

  if (result.state === "not_sent" && result.retryable === true) {
    returnToPending(key);
    return;
  }

  // Reported whatever the outcome, so after a failure the model proposes the
  // email the user settled on rather than its own draft.
  const userEdits: ApprovalEdits =
    fields && fieldsDiffer(fields, entry.preview.fields ?? {})
      ? { final: copyFields(fields) }
      : !fields && entry.draft.body !== entry.preview.body
        ? { finalText: entry.draft.body }
        : {};
  const destination =
    (result.state === "sent" || result.state === "unknown") &&
    typeof result.destinationLabel === "string" &&
    result.destinationLabel !== ""
      ? { destinationLabel: result.destinationLabel }
      : {};
  // resultLabel names what the send created ("ENG-124"); only a sent commit
  // ever carries one.
  const created =
    result.state === "sent" && typeof result.resultLabel === "string" && result.resultLabel !== ""
      ? { resultLabel: result.resultLabel }
      : {};
  switch (result.state) {
    case "sent":
      settle(
        key,
        {
          state: "sent",
          url: result.url,
          ...userEdits,
          ...destination,
          ...created,
        },
        "sent",
        { url: result.url, ...destination, ...created }
      );
      break;
    case "failed":
      settle(
        key,
        { state: "failed", errorCode: result.errorCode, message: result.message, ...userEdits },
        "failed",
        { message: result.message, errorCode: result.errorCode }
      );
      break;
    case "unknown":
      settle(
        key,
        {
          state: "unknown",
          ...(result.checkUrl !== undefined ? { checkUrl: result.checkUrl } : {}),
          ...userEdits,
          ...destination,
        },
        "unknown",
        { url: result.checkUrl, ...destination }
      );
      break;
    case "not_sent":
      settle(key, { state: "not_sent", reason: result.reason }, "not_sent");
      break;
  }
}
