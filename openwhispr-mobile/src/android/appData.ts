import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useTranscriptStore } from '@/store/useTranscriptStore';
import { useDictionaryStore } from '@/store/useDictionaryStore';
import { useSnippetsStore } from '@/store/useSnippetsStore';

let booting: Promise<void> | null = null;

async function load(): Promise<void> {
  await useConfigStore.getState().loadConfig();
  await useAuthStore.getState().initialize();
  await Promise.all([
    useTranscriptStore.getState().loadTranscripts(),
    useDictionaryStore.getState().load(),
    useSnippetsStore.getState().load(),
  ]);
}

/**
 * Loads what dictation needs: config, then auth, then transcripts, dictionary and snippets. The app
 * and the bubble's headless pipeline share one load; a failed load runs again on the next call.
 */
export function bootAppData(): Promise<void> {
  if (booting) return booting;
  const current: Promise<void> = load().catch((error: unknown) => {
    // A newer load (the app's Retry) is not undone by an older one failing.
    if (booting === current) booting = null;
    throw error;
  });
  booting = current;
  return current;
}

/** The app's Retry: the next bootAppData() loads everything again. */
export function forgetAppData(): void {
  booting = null;
}
