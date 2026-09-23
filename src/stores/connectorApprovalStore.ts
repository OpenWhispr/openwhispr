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

  let result: ConnectorCommitResult;
  try {
    result = (await window.electronAPI?.connectorCommit?.(entry.actionId, edits)) ?? {
      state: "unknown",
    };
  } catch {
    // The request may have reached main and been sent; never claim it wasn't.
    result = { state: "unknown" };
  }

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
