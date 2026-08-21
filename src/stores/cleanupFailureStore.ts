import { create } from "zustand";

interface CleanupFailureState {
  /** Dictations handed back raw because cleanup failed, not yet surfaced to the user. */
  pending: number;
  /** Cause of the most recent failure, shown with the toast so it's actionable. */
  lastMessage: string;
  /** i18n key overriding lastMessage when the cause has a translated description. */
  lastMessageKey: string;
}

export const useCleanupFailureStore = create<CleanupFailureState>(() => ({
  pending: 0,
  lastMessage: "",
  lastMessageKey: "",
}));

export function recordCleanupFailure(message = ""): void {
  useCleanupFailureStore.setState((state) => ({
    pending: state.pending + 1,
    lastMessage: message,
    lastMessageKey: "",
  }));
}

/** Cleanup was switched on but skipped because no reasoning model is reachable. */
export function recordCleanupSkipped(): void {
  useCleanupFailureStore.setState((state) => ({
    pending: state.pending + 1,
    lastMessage: "",
    lastMessageKey: "app.toasts.cleanupFailed.notConfigured",
  }));
}

export function consumeCleanupFailures(): number {
  const { pending } = useCleanupFailureStore.getState();
  if (pending > 0) {
    useCleanupFailureStore.setState({ pending: 0 });
  }
  return pending;
}
