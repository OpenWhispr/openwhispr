import { create } from "zustand";

interface CleanupFailureState {
  /** Dictations handed back raw because cleanup failed, not yet surfaced to the user. */
  pending: number;
}

export const useCleanupFailureStore = create<CleanupFailureState>(() => ({
  pending: 0,
}));

export function recordCleanupFailure(): void {
  useCleanupFailureStore.setState((state) => ({ pending: state.pending + 1 }));
}

export function consumeCleanupFailures(): number {
  const { pending } = useCleanupFailureStore.getState();
  if (pending > 0) {
    useCleanupFailureStore.setState({ pending: 0 });
  }
  return pending;
}
