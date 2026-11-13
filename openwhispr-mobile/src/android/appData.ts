import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useTranscriptStore } from '@/store/useTranscriptStore';
import { useDictionaryStore } from '@/store/useDictionaryStore';
import { useSnippetsStore } from '@/store/useSnippetsStore';

let booting: Promise<void> | null = null;
let settled = false;

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
  settled = false;
  const current: Promise<void> = load().then(
    () => {
      if (booting === current) settled = true;
    },
    (error: unknown) => {
      // A newer load (the app's Retry) is not undone by an older one failing.
      if (booting === current) booting = null;
      throw error;
    },
  );
  booting = current;
  return current;
}

/**
 * The app opening: joins a load still in progress, otherwise loads again, so a session restored
 * earlier by the bubble's headless pipeline (perhaps offline) is checked again as at any launch.
 */
export function refreshAppData(): Promise<void> {
  if (booting && !settled) return booting;
  booting = null;
  return bootAppData();
}

/** The app's Retry: the next bootAppData() loads everything again. */
export function forgetAppData(): void {
  booting = null;
}
