import { create } from "zustand";

export interface CleanupFailure {
  message: string;
  messageKey?: string;
  messageParams?: Record<string, string | number>;
  action?: string;
  actionKey?: string;
  copyCommand?: string;
  technicalDetails?: {
    status?: number;
    exceptionType?: string;
    requestId?: string;
    underlyingError?: string;
  };
}

interface CleanupFailureState {
  /** Dictations handed back raw because cleanup failed, not yet surfaced to the user. */
  pending: number;
  /** Cause of the most recent failure, shown with the toast so it's actionable. */
  lastMessage: string;
  /** Structured cause and AWS diagnostics for the most recent fallback. */
  lastFailure: CleanupFailure | null;
}

export const useCleanupFailureStore = create<CleanupFailureState>(() => ({
  pending: 0,
  lastMessage: "",
  lastFailure: null,
}));

export function recordCleanupFailure(failure: string | CleanupFailure = ""): void {
  const normalized = typeof failure === "string" ? { message: failure } : failure;
  useCleanupFailureStore.setState((state) => ({
    pending: state.pending + 1,
    lastMessage: normalized.message,
    lastFailure: normalized,
  }));
}

export function consumeCleanupFailures(): number {
  const { pending } = useCleanupFailureStore.getState();
  if (pending > 0) {
    useCleanupFailureStore.setState({ pending: 0 });
  }
  return pending;
}
