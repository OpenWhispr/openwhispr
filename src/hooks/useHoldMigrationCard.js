import { useCallback, useEffect, useRef, useState } from "react";
import { useSettingsStore } from "../stores/settingsStore";

const EXIT_MS = 200;

/**
 * Shows the Hold migration card on the first hotkey press after the update
 * changed the user's activation mode, and takes it down on the X or the next
 * press. A hotkey press reaches the pill window as start-dictation (a hold or
 * a hands-free latch) or toggle-dictation (a slot that can only Tap); a click
 * on the pill never goes through IPC and so never counts.
 */
export function useHoldMigrationCard() {
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const visibleRef = useRef(false);
  const exitTimerRef = useRef(null);

  const dismiss = useCallback(() => {
    if (!visibleRef.current || exitTimerRef.current) return;
    setExiting(true);
    exitTimerRef.current = setTimeout(() => {
      exitTimerRef.current = null;
      visibleRef.current = false;
      setVisible(false);
      setExiting(false);
    }, EXIT_MS);
  }, []);

  useEffect(() => {
    const onPress = () => {
      if (visibleRef.current) {
        dismiss();
        return;
      }
      const state = useSettingsStore.getState();
      if (
        !state.holdMigrationCardPending ||
        state.holdMigrationCardShown ||
        // The card says "hold your hotkey"; a dictation slot demoted to Tap
        // cannot, so it would be teaching a gesture that does not work.
        state.activationMode !== "push"
      ) {
        return;
      }
      state.setHoldMigrationCardShown(true);
      visibleRef.current = true;
      setVisible(true);
    };
    const unsubscribeStart = window.electronAPI?.onStartDictation?.(onPress);
    const unsubscribeToggle = window.electronAPI?.onToggleDictation?.(onPress);
    return () => {
      unsubscribeStart?.();
      unsubscribeToggle?.();
      clearTimeout(exitTimerRef.current);
    };
  }, [dismiss]);

  return { visible: visible && !exiting, exiting, dismiss };
}
