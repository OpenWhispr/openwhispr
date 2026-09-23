import { create } from "zustand";
import type { ToolExecutionContext } from "../services/tools/ToolRegistry";
import type {
  ApprovalOutcome,
  ConnectorCommitResult,
  ConnectorEdits,
  ConnectorPreview,
} from "../types/connectors";

export const APPROVAL_TTL_MS = 10 * 60 * 1000;

export type ApprovalState =
  | "pending"
  | "committing"
  | "sent"
  | "failed"
  | "unknown"
  | "cancelled"
  | "not_sent";

/** What the card shows and what Send commits; starts as the preview. */
export interface ApprovalDraft {
  title?: string;
  body: string;
}

export interface ApprovalEntry {
  toolCallId: string;
  actionId: string;
  connectorId: string;
  preview: ConnectorPreview;
  draft: ApprovalDraft;
  state: ApprovalState;
  url?: string;
  message?: string;
}

interface ApprovalStoreState {
  entries: Record<string, ApprovalEntry>;
}

export const useConnectorApprovalStore = create<ApprovalStoreState>(() => ({ entries: {} }));

interface PendingResolution {
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  detach: () => void;
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

function entryFor(toolCallId: string): ApprovalEntry | undefined {
  return useConnectorApprovalStore.getState().entries[toolCallId];
}

function patchEntry(toolCallId: string, patch: Partial<ApprovalEntry>): void {
  useConnectorApprovalStore.setState((state) => {
    const entry = state.entries[toolCallId];
    if (!entry) return state;
    return { entries: { ...state.entries, [toolCallId]: { ...entry, ...patch } } };
  });
}

function settle(
  toolCallId: string,
  outcome: ApprovalOutcome,
  state: ApprovalState,
  patch: Partial<ApprovalEntry> = {}
): void {
  const pending = resolutions.get(toolCallId);
  if (!pending) return;
  resolutions.delete(toolCallId);
  clearTimeout(pending.timer);
  pending.detach();
  patchEntry(toolCallId, { state, ...patch });
  pending.resolve(outcome);
}

// Conversation end and expiry only withdraw a card that is still pending: a
// committing send may already have reached the provider.
function withdraw(toolCallId: string, reason: "conversation_ended" | "expired"): void {
  const entry = entryFor(toolCallId);
  if (!entry || entry.state !== "pending") return;
  void window.electronAPI?.connectorCancel?.(entry.actionId, reason);
  settle(toolCallId, { state: "not_sent", reason }, "not_sent");
}

export function requestApproval(
  context: ToolExecutionContext,
  request: { actionId: string; connectorId: string; preview: ConnectorPreview }
): Promise<ApprovalOutcome> {
  const { toolCallId, signal } = context;
  if (signal.aborted) {
    void window.electronAPI?.connectorCancel?.(request.actionId, "conversation_ended");
    return Promise.resolve({ state: "not_sent", reason: "conversation_ended" });
  }
  // A second request for the same tool call must never steal the first
  // card's resolver, timer or entry — that would cross-wire two actions:
  // the first card would show the second action's outcome (or vice versa)
  // and the loser's promise would never resolve.
  if (resolutions.has(toolCallId)) {
    void window.electronAPI?.connectorCancel?.(request.actionId, "cancelled_by_user");
    return Promise.resolve({ state: "not_sent", reason: "duplicate_tool_call" });
  }
  return new Promise((resolve) => {
    const onAbort = (): void => withdraw(toolCallId, "conversation_ended");
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => withdraw(toolCallId, "expired"), APPROVAL_TTL_MS);
    resolutions.set(toolCallId, {
      resolve,
      timer,
      detach: () => signal.removeEventListener("abort", onAbort),
    });
    const draft: ApprovalDraft = {
      ...(request.preview.title !== undefined ? { title: request.preview.title } : {}),
      body: request.preview.body,
    };
    useConnectorApprovalStore.setState((state) => ({
      entries: {
        ...state.entries,
        [toolCallId]: { toolCallId, ...request, draft, state: "pending" },
      },
    }));
    context.onApprovalRequested();
  });
}

export function updateApprovalDraft(toolCallId: string, patch: Partial<ApprovalDraft>): void {
  const entry = entryFor(toolCallId);
  if (!entry || entry.state !== "pending") return;
  patchEntry(toolCallId, {
    draft: {
      ...entry.draft,
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.title !== undefined && entry.preview.title !== undefined
        ? { title: patch.title }
        : {}),
    },
  });
}

export function cancelApproval(toolCallId: string): void {
  const entry = entryFor(toolCallId);
  if (!entry || entry.state !== "pending") return;
  void window.electronAPI?.connectorCancel?.(entry.actionId, "cancelled_by_user");
  settle(toolCallId, { state: "cancelled" }, "cancelled");
}

// Send commits the draft (what the card shows), never an edit-mode snapshot:
// leaving edit mode must not discard the user's changes.
export async function approveAction(toolCallId: string): Promise<void> {
  const entry = entryFor(toolCallId);
  if (!entry || entry.state !== "pending") return;
  const edits: ConnectorEdits = { ...entry.draft };
  patchEntry(toolCallId, { state: "committing" });
  const pending = resolutions.get(toolCallId);
  if (pending) {
    clearTimeout(pending.timer);
    pending.detach();
  }

  let raw: unknown;
  try {
    raw = await window.electronAPI?.connectorCommit?.(entry.actionId, edits);
  } catch {
    // The request may have reached main and been sent; never claim it wasn't.
    raw = undefined;
  }
  // A missing result, or one that doesn't match a state the switch below
  // understands (wrong key, unrecognized state), is exactly as uncertain as
  // a thrown IPC call — never let it fall through with no case to settle.
  const result: ConnectorCommitResult = isConnectorCommitResult(raw) ? raw : { state: "unknown" };

  const finalText = entry.draft.body !== entry.preview.body ? entry.draft.body : undefined;
  switch (result.state) {
    case "sent":
      settle(
        toolCallId,
        { state: "sent", url: result.url, ...(finalText !== undefined ? { finalText } : {}) },
        "sent",
        { url: result.url }
      );
      break;
    case "failed":
      settle(
        toolCallId,
        { state: "failed", errorCode: result.errorCode, message: result.message },
        "failed",
        { message: result.message }
      );
      break;
    case "unknown":
      settle(
        toolCallId,
        {
          state: "unknown",
          ...(result.checkUrl !== undefined ? { checkUrl: result.checkUrl } : {}),
        },
        "unknown",
        { url: result.checkUrl }
      );
      break;
    case "not_sent":
      settle(toolCallId, { state: "not_sent", reason: result.reason }, "not_sent");
      break;
  }
}
