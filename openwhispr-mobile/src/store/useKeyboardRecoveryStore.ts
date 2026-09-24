import { create } from 'zustand';

// How long a recovery deep link keeps the warm-resume reset suppressed. Long
// enough to cover launch and navigation, short enough that a link which never
// reaches the screen cannot pin the app to whatever happens to be on top.
const DEEP_LINK_FRESH_MS = 10_000;

// How long the screen may sit backgrounded before it stops blocking the resume
// reset. A user who opens recovery and walks away must not permanently switch off
// the app's "warm resume lands on Home" behaviour.
const BACKGROUND_STALE_MS = 10 * 60 * 1000;

interface KeyboardRecoveryState {
  /**
   * True while the Full Access recovery screen is mounted. It sends the user out
   * to Settings and needs to still be there when they come back, so the warm-resume
   * reset in app/_layout.tsx has to skip it (see `resolveResumeAction`).
   *
   * Deliberately its own store: `useHandoffStore.isActive` already means "a
   * dictation job is in flight" and is read by HomeScreen.
   */
  isRecoveryActive: boolean;
  /**
   * When the recovery deep link last arrived, cleared once the screen claims it.
   * Covers two gaps the flag above cannot: the window before the screen's passive
   * mount effect has run, and a link that arrived while AuthScreen was rendering
   * *instead of* the navigator, where nothing could route it.
   */
  deepLinkAtMs: number | null;
  /** When the screen last went to the background — the Settings trip, or leaving. */
  backgroundedAtMs: number | null;
  setRecoveryActive: (active: boolean) => void;
  markRecoveryDeepLink: () => void;
  markBackgrounded: () => void;
}

export const useKeyboardRecoveryStore = create<KeyboardRecoveryState>((set) => ({
  isRecoveryActive: false,
  deepLinkAtMs: null,
  backgroundedAtMs: null,
  // Mounting claims the deep link: the screen is up, so the hand-over it was
  // covering for is complete and a stale stamp would outlive the screen itself.
  setRecoveryActive: (active: boolean): void =>
    set(
      active
        ? { isRecoveryActive: true, deepLinkAtMs: null, backgroundedAtMs: null }
        : { isRecoveryActive: false, backgroundedAtMs: null },
    ),
  markRecoveryDeepLink: (): void => set({ deepLinkAtMs: Date.now() }),
  markBackgrounded: (): void => set({ backgroundedAtMs: Date.now() }),
}));

/** True while a recovery deep link is still expected to land on the screen. */
export function isRecoveryDeepLinkFresh(): boolean {
  const { deepLinkAtMs } = useKeyboardRecoveryStore.getState();
  return deepLinkAtMs !== null && Date.now() - deepLinkAtMs < DEEP_LINK_FRESH_MS;
}

/** True while the mounted recovery screen should still hold the user in place. */
export function isRecoveryHolding(): boolean {
  const { isRecoveryActive, backgroundedAtMs } = useKeyboardRecoveryStore.getState();
  if (!isRecoveryActive) return false;
  if (backgroundedAtMs === null) return true;
  return Date.now() - backgroundedAtMs < BACKGROUND_STALE_MS;
}

/**
 * Claims a deep link that never reached the screen, for the case where AuthScreen
 * rendered instead of the navigator. Returns whether one was outstanding.
 */
export function consumeRecoveryDeepLink(): boolean {
  const { deepLinkAtMs } = useKeyboardRecoveryStore.getState();
  if (deepLinkAtMs === null) return false;
  useKeyboardRecoveryStore.setState({ deepLinkAtMs: null });
  return true;
}
