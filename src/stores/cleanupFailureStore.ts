import { create } from "zustand";

interface CleanupFailureState {
  /** Dictations handed back raw because cleanup failed, not yet surfaced to the user. */
  pending: number;
  /** Cause of the most recent failure, shown with the toast so it's actionable. */
  lastMessage: string;
}

export const useCleanupFailureStore = create<CleanupFailureState>(() => ({
  pending: 0,
  lastMessage: "",
}));

export function recordCleanupFailure(message = ""): void {
  useCleanupFailureStore.setState((state) => ({
    pending: state.pending + 1,
    lastMessage: message,
  }));
}

export function consumeCleanupFailures(): number {
  const { pending } = useCleanupFailureStore.getState();
  if (pending > 0) {
    useCleanupFailureStore.setState({ pending: 0 });
  }
  return pending;
}
