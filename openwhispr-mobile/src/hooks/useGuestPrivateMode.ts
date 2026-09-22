import { useEffect } from 'react';
import { useAuthStore } from '@/store/useAuthStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';

/**
 * Cloud transcription needs a session. A guest has none, so force Private
 * before a stored or default 'cloud' preference can leave them in a mode they
 * cannot use. Selection points upsell sign-in; this is the safety net for any
 * path that bypasses them.
 *
 * Keyed on `isGuest`, not on the absence of a user: a fresh install has no
 * user until its anonymous onboarding session lands, and forcing Private in
 * that window would send the dictation demo to a local model that is not
 * downloaded yet — nothing restores Cloud afterwards.
 */
export function useGuestPrivateMode(): void {
  const isInitialized = useAuthStore((state) => state.isInitialized);
  const isGuest = useAuthStore((state) => state.isGuest);
  const activeMode = useProcessingModeStore((state) => state.activeMode);

  useEffect(() => {
    if (!isInitialized) return;
    if (isGuest && activeMode === 'cloud') {
      useProcessingModeStore.getState().setActiveMode('private');
    }
  }, [isInitialized, isGuest, activeMode]);
}
