import { downloadAndroidModel, modelReady, useModelDownloads } from '@/android/models';

const MODEL = 'meeting-speakers';
/** After a failed fetch, the next try waits this long, then twice as long, up to RETRY_MAX_MS. */
export const RETRY_FIRST_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;
let fetching: Promise<void> | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let wait = RETRY_FIRST_MS;

/**
 * Fetches the 42 MB speaker model quietly, on Wi-Fi or mobile data, for Cloud and On device
 * meetings alike, so speakers are named without anyone choosing it. No prompt and no switch: a
 * failure tries again a minute later (doubling, up to half an hour) and at the next launch, and
 * a meeting that ends before the model is here keeps its transcript without speaker names.
 */
export function prefetchSpeakerModel(): Promise<void> {
  if (retry) {
    clearTimeout(retry);
    retry = null;
  }
  fetching ??= (async () => {
    if (useModelDownloads.getState().progress[MODEL] !== undefined) return;
    if (await modelReady(MODEL)) return;
    await downloadAndroidModel(MODEL);
    wait = RETRY_FIRST_MS;
    console.info('[live-speakers] speaker model downloaded');
  })()
    .catch((error: unknown) => {
      console.info(
        `[live-speakers] speaker model not fetched: ${error instanceof Error ? error.message : String(error)}`,
      );
      retry = setTimeout(() => {
        retry = null;
        void prefetchSpeakerModel();
      }, wait);
      wait = Math.min(wait * 2, RETRY_MAX_MS);
    })
    .finally(() => {
      fetching = null;
    });
  return fetching;
}
