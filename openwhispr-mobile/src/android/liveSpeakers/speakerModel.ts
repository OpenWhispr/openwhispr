import { downloadAndroidModel, modelReady, useModelDownloads } from '@/android/models';

// Loaded on first use, so screens that only import this file don't need the native storage.
const storage = () =>
  (
    require('@react-native-async-storage/async-storage') as typeof import('@react-native-async-storage/async-storage')
  ).default;

const MODEL = 'meeting-speakers';
const REMOVED_KEY = 'android.meetingSpeakers.removedByUser';
let fetching: Promise<void> | null = null;

/** Someone removed the speaker model in Settings: don't fetch it again behind their back. */
export function speakerModelRemovedByUser(removed: boolean): void {
  void Promise.resolve()
    .then(() => (removed ? storage().setItem(REMOVED_KEY, '1') : storage().removeItem(REMOVED_KEY)))
    .catch(() => undefined);
}

/**
 * Fetches the 42 MB speaker model quietly, on Wi-Fi or mobile data, so live meetings can label
 * speakers. No prompt: a failure just means this meeting goes unlabelled, and the next try is
 * the next time meetings open. Never runs again once the person removed the model themselves.
 */
export function prefetchSpeakerModel(): Promise<void> {
  fetching ??= (async () => {
    if (
      (await Promise.resolve()
        .then(() => storage().getItem(REMOVED_KEY))
        .catch(() => null)) === '1'
    )
      return;
    if (useModelDownloads.getState().progress[MODEL] !== undefined) return;
    if (await modelReady(MODEL)) return;
    await downloadAndroidModel(MODEL);
    console.info('[live-speakers] speaker model downloaded');
  })()
    .catch((error: unknown) => {
      console.info(
        `[live-speakers] speaker model not fetched: ${error instanceof Error ? error.message : String(error)}`,
      );
    })
    .finally(() => {
      fetching = null;
    });
  return fetching;
}
