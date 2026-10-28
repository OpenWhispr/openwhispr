import { create } from "zustand";
import type { ToolExecutionContext } from "../services/tools/ToolRegistry";
import type {
  ApprovalEdits,
  ApprovalOutcome,
  ConnectorCommitResult,
  ConnectorEdits,
  ConnectorPrepareResult,
  ConnectorPreview,
} from "../types/connectors";
import type { ConnectionTarget } from "../types/agentInteractions";
import { isConnectorReady, useConnectorStatusStore } from "./connectorStatusStore";

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
  /** A reply meant for a thread that Slack posted as a new message. */
  outsideThread?: true;
  /** Failed, and the tool still waits: Retry prepares the draft for a fresh Send. */
  awaitingRetry?: true;
  /** Send needs the service connected first: the card asks, then connects. */
  reconnect?: "prompt" | "connecting";
  /** Why the last connect from the card failed (an error code). */
  connectError?: string;
  /**
   * Shown on a pending card after a Send that could not run: the policy check
   * didn't finish, or after a reconnect it would go out as someone else.
   */
  notice?: "policy_retry" | "identity_changed";
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

type FailedOutcome = Extract<ApprovalOutcome, { state: "failed" }>;

/** Prepares the same action again, on the login that is current now. */
export type Reprepare = () => Promise<ConnectorPrepareResult | undefined>;

interface PendingResolution {
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  detach: () => void;
  signal: AbortSignal;
  expiresAt: number;
  reprepare: Reprepare;
  /** The failure a card waiting for Retry shows; Cancel reports it. */
  failure?: FailedOutcome;
  /** Counts the card's connects, so only the latest one's result counts. */
  connectAttempt: number;
  /** Where the first prepare sent it, which the tool reports unless Send changed it. */
  preparedDestination: string;
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
  patchEntry(key, {
    state,
    notice: undefined,
    awaitingRetry: undefined,
    reconnect: undefined,
    connectError: undefined,
    ...patch,
  });
  pending.resolve(outcome);
}

// A connect the card started for Send.
function stopConnect(entry: ApprovalEntry): void {
  if (entry.reconnect === "connecting") {
    void window.electronAPI?.connectorCancelConnect?.(entry.connectorId);
  }
}

// A card that failed and hasn't been prepared again since (waiting for Retry,
// or asking to connect after one) still reports that failure.
function failureToReport(
  entry: ApprovalEntry,
  pending: PendingResolution
): FailedOutcome | undefined {
  return entry.awaitingRetry || entry.state === "pending" ? pending.failure : undefined;
}

// Conversation end and expiry only withdraw a card that waits on the user: a
// committing send may already have reached the provider. A card that failed
// reports that failure, so the model hears what really happened.
function withdraw(key: string, reason: "conversation_ended" | "expired"): void {
  const entry = entryFor(key);
  const pending = resolutions.get(key);
  if (!entry || !pending) return;
  // Only a connect the card started for Send runs, and only while it waits.
  stopConnect(entry);
  const failure = failureToReport(entry, pending);
  if (failure) {
    settle(key, { ...failure, ...userEditsOf(entry) }, "failed");
    return;
  }
  if (entry.state !== "pending") return;
  void window.electronAPI?.connectorCancel?.(entry.actionId, reason);
  settle(key, { state: "not_sent", reason, ...userEditsOf(entry) }, "not_sent");
}

// The card waits on the user again after a Send that didn't go out. An abort
// or expiry that fired meanwhile, while only a waiting card can be withdrawn,
// is applied now.
function waitForUserAgain(key: string, patch: Partial<ApprovalEntry>): void {
  patchEntry(key, patch);
  const pending = resolutions.get(key);
  if (!pending) return;
  if (pending.signal.aborted) withdraw(key, "conversation_ended");
  else if (Date.now() >= pending.expiresAt) withdraw(key, "expired");
}

export function requestApproval(
  context: ToolExecutionContext,
  request: { actionId: string; connectorId: string; preview: ConnectorPreview },
  reprepare: Reprepare
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
      reprepare,
      connectAttempt: 0,
      preparedDestination: request.preview.destinationLabel,
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
  });
}

export function updateApprovalDraft(
  key: string,
  patch: { title?: string; body?: string; fields?: Partial<DraftFields> }
): void {
  const entry = entryFor(key);
  if (!entry || (entry.state !== "pending" && !entry.awaitingRetry)) return;
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
  const pending = resolutions.get(key);
  if (!entry || !pending) return;
  // After a failed send the model hears that failure, with the user's edits.
  stopConnect(entry);
  const failure = failureToReport(entry, pending);
  if (failure) {
    settle(key, { ...failure, ...userEditsOf(entry) }, "cancelled");
    return;
  }
  if (entry.state !== "pending") return;
  void window.electronAPI?.connectorCancel?.(entry.actionId, "cancelled_by_user");
  settle(key, { state: "cancelled", ...userEditsOf(entry) }, "cancelled");
}

// Reported whatever the outcome, so after a failure the model proposes the
// email the user settled on rather than its own draft.
function userEditsOf(entry: ApprovalEntry): ApprovalEdits {
  const { fields, body } = entry.draft;
  if (fields)
    return fieldsDiffer(fields, entry.preview.fields ?? {}) ? { final: copyFields(fields) } : {};
  return body !== entry.preview.body ? { finalText: body } : {};
}

// Main answers these when the login the action was prepared on is gone
// (disconnected, reconnected, or flagged for a reconnect): nothing was sent.
function lostConnection(result: ConnectorCommitResult): boolean {
  return (
    (result.state === "not_sent" &&
      (result.reason === "not_found" || result.reason === "connection_changed")) ||
    (result.state === "failed" && result.errorCode === "reconnect_needed")
  );
}

// The connection the store last heard of; unknown counts as ready, and main decides.
function connectorReady(connectorId: string): boolean {
  return !useConnectorStatusStore.getState().loaded || isConnectorReady(connectorId);
}

// Send commits the draft (what the card shows), never an edit-mode snapshot:
// leaving edit mode must not discard the user's changes.
export async function approveAction(key: string): Promise<void> {
  const entry = entryFor(key);
  if (!entry || entry.state !== "pending" || entry.reconnect) return;
  // Nothing can go out while the service isn't connected: connect first.
  if (!connectorReady(entry.connectorId)) {
    patchEntry(key, { reconnect: "prompt", connectError: undefined, notice: undefined });
    return;
  }
  await commitDraft(key);
}

/**
 * Prepares the draft again after a failure. Main already finished the failed
 * action, so it is prepared again on the current login; the tool has waited
 * all along. The new action waits for Send. With the service no longer
 * connected, the card asks to connect first.
 */
export async function retryApproval(key: string): Promise<void> {
  const entry = entryFor(key);
  if (!entry?.awaitingRetry) return;
  if (!connectorReady(entry.connectorId)) {
    patchEntry(key, {
      state: "pending",
      awaitingRetry: undefined,
      reconnect: "prompt",
      connectError: undefined,
    });
    return;
  }
  await rebind(key);
}

/** The card's ✓ Yes: connect the service, then prepare a fresh card for Send. */
export async function connectToSend(key: string): Promise<void> {
  const entry = entryFor(key);
  const pending = resolutions.get(key);
  if (entry?.state !== "pending" || entry.reconnect !== "prompt" || !pending) return;
  const attempt = ++pending.connectAttempt;
  patchEntry(key, { reconnect: "connecting", connectError: undefined });
  // Connected meanwhile (another card's Yes, or Settings): no second sign-in.
  if (useConnectorStatusStore.getState().loaded && isConnectorReady(entry.connectorId)) {
    await rebind(key);
    return;
  }
  // Loaded when used: the interaction store imports this one.
  const { connectTarget } = await import("./agentInteractionStore");
  const outcome = await connectTarget(entry.connectorId as Exclude<ConnectionTarget, "calendar">);
  // Withdrawn, or the user gave up (X) or started another connect, meanwhile.
  if (
    resolutions.get(key) !== pending ||
    pending.connectAttempt !== attempt ||
    entryFor(key)?.reconnect !== "connecting"
  ) {
    return;
  }
  if (outcome.status !== "connected") {
    patchEntry(key, {
      reconnect: "prompt",
      connectError:
        outcome.status === "failed"
          ? outcome.errorCode
          : outcome.status === "unavailable"
            ? outcome.reason
            : undefined,
    });
    return;
  }
  await rebind(key);
}

/** The card's X on its connect prompt: back to the draft, nothing sent. */
export function dismissReconnect(key: string): void {
  const entry = entryFor(key);
  const pending = resolutions.get(key);
  if (entry?.state !== "pending" || !entry.reconnect) return;
  stopConnect(entry);
  if (pending) pending.connectAttempt += 1;
  patchEntry(key, { reconnect: undefined, connectError: undefined });
}

// What failing to prepare again reads like on the card, for Retry.
function prepareFailure(prepared: ConnectorPrepareResult | undefined): FailedOutcome {
  if (prepared?.status === "failed") {
    return { state: "failed", errorCode: prepared.errorCode, message: prepared.message };
  }
  const errorCode = prepared?.status === "unavailable" ? prepared.reason : "prepare_failed";
  return { state: "failed", errorCode, message: "The action couldn't be prepared again." };
}

function failAwaitingRetry(key: string, failure: FailedOutcome): void {
  const pending = resolutions.get(key);
  if (pending) pending.failure = failure;
  waitForUserAgain(key, {
    state: "failed",
    awaitingRetry: true,
    errorCode: failure.errorCode,
    message: failure.message,
  });
}

/**
 * Prepares the action again on the current login for a fresh Send.
 * Nothing can go out twice: the old action is gone (finished, invalidated or
 * refused by its binding), the new one is bound to the new login, and the tool
 * has held its send claim the whole time. The new action always waits for
 * the user's Send, even when the displayed identity is unchanged.
 */
async function rebind(key: string): Promise<void> {
  const entry = entryFor(key);
  const pending = resolutions.get(key);
  if (!entry || !pending) return;
  const retrying = entry.awaitingRetry;
  // The turn ended or the card expired while the Send ran: nothing new is
  // prepared, and the card is withdrawn as it would have been while it waited.
  if (pending.signal.aborted || Date.now() >= pending.expiresAt) {
    waitForUserAgain(
      key,
      retrying
        ? { state: "failed", awaitingRetry: true }
        : { state: "pending", reconnect: undefined }
    );
    return;
  }
  patchEntry(key, {
    state: "committing",
    awaitingRetry: undefined,
    reconnect: undefined,
    notice: undefined,
  });
  // The old action, if main still holds it. No receipt reason fits one
  // replaced by a new action; it reads as cancelled, and the new one waits for Send.
  void window.electronAPI?.connectorCancel?.(entry.actionId, "cancelled_by_user");
  const prepared = await pending.reprepare().catch(() => undefined);
  // The turn ended or the card expired meanwhile: the new action goes, and the
  // card is withdrawn as it would have been while it waited.
  if (
    resolutions.get(key) !== pending ||
    pending.signal.aborted ||
    Date.now() >= pending.expiresAt
  ) {
    if (prepared?.status === "ready") {
      void window.electronAPI?.connectorCancel?.(prepared.actionId, "conversation_ended");
    }
    waitForUserAgain(
      key,
      retrying ? { state: "failed", awaitingRetry: true } : { state: "pending" }
    );
    return;
  }
  if (prepared?.status === "needs_clarification") {
    // The draft can't go where it was going (a channel archived, an app
    // uninstalled): the model hears the question and asks the user.
    settle(
      key,
      {
        state: "not_sent",
        reason: "needs_clarification",
        clarification: prepared,
        ...userEditsOf(entry),
      },
      "not_sent"
    );
    return;
  }
  if (prepared?.status !== "ready") {
    const needsConnect =
      (prepared?.status === "failed" && prepared.errorCode === "reconnect_needed") ||
      (prepared?.status === "unavailable" && prepared.reason === "not_connected");
    if (needsConnect) waitForUserAgain(key, { state: "pending", reconnect: "prompt" });
    else failAwaitingRetry(key, prepareFailure(prepared));
    return;
  }
  const identityChanged =
    entry.preview.accountLabel !== prepared.preview.accountLabel ||
    entry.preview.workspaceLabel !== prepared.preview.workspaceLabel ||
    entry.preview.destinationLabel !== prepared.preview.destinationLabel;
  // Prepared again: an earlier failure is no longer what the card stands for.
  pending.failure = undefined;
  patchEntry(key, { actionId: prepared.actionId, preview: prepared.preview });
  // Display labels cannot prove that a new action has the same sender or destination.
  waitForUserAgain(key, {
    state: "pending",
    ...(identityChanged ? { notice: "identity_changed" } : {}),
  });
}

// Commits what the card holds and settles the card on the outcome. A send that
// lost its login prepares again on its own once per Send, when the service is
// connected; otherwise the card asks to connect.
async function commitDraft(key: string): Promise<void> {
  const entry = entryFor(key);
  if (!entry) return;
  const { title, body, fields } = entry.draft;
  // A fields card commits its fields; main keeps only those the action declares.
  const edits: ConnectorEdits = fields
    ? copyFields(fields)
    : { ...(title !== undefined ? { title } : {}), body };
  // The expiry timer and abort listener stay armed while sending. They only
  // withdraw a card waiting on the user, and a Send that comes back without
  // sending returns the card to that; settle() disarms them for every final
  // outcome.
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
    waitForUserAgain(key, { state: "pending", notice: "policy_retry" });
    return;
  }
  if (lostConnection(result)) {
    const reconnectNeeded = result.state === "failed";
    if (!reconnectNeeded && connectorReady(entry.connectorId)) await rebind(key);
    else waitForUserAgain(key, { state: "pending", reconnect: "prompt" });
    return;
  }

  const userEdits = userEditsOf(entry);
  // Where it went, when that isn't where the first prepare said: as main
  // reports it, or as the card showed it after a reconnect prepared it again.
  const reported =
    (result.state === "sent" || result.state === "unknown") &&
    typeof result.destinationLabel === "string" &&
    result.destinationLabel !== ""
      ? result.destinationLabel
      : entry.preview.destinationLabel !== resolutions.get(key)?.preparedDestination
        ? entry.preview.destinationLabel
        : undefined;
  const destination = reported ? { destinationLabel: reported } : {};
  // What a sent commit reports about the send: what it created ("ENG-124"),
  // and a reply meant for a thread that went out as a new message.
  const created = {
    ...(result.state === "sent" &&
    typeof result.resultLabel === "string" &&
    result.resultLabel !== ""
      ? { resultLabel: result.resultLabel }
      : {}),
    ...(result.state === "sent" && result.outsideThread === true
      ? { outsideThread: true as const }
      : {}),
  };
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
      // The provider confirmed nothing went out: the draft stays, with Retry.
      failAwaitingRetry(key, {
        state: "failed",
        errorCode: result.errorCode,
        message: result.message,
      });
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
