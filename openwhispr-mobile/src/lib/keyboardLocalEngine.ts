import { getPickedLocalModel } from '@/lib/inferenceRouting';
import { getPreferredTranscriptionLanguages } from '@/lib/transcriptionLanguage';
import { LocalTranscriptionService } from '@/services/transcription/LocalTranscriptionService';
import { selectLocalEngine, type LocalEngineChoice } from '@/services/transcription/localEngine';

/**
 * The on-device engine a dictation would use right now, kept for the keyboard's snapshot.
 * Whether a model is installed is an async native read, while the snapshot is built
 * synchronously, so the last resolved choice is held here and refreshed when it may change.
 */

let current: LocalEngineChoice | null = null;
let latestRefresh = 0;
const listeners = new Set<() => void>();

/** The last resolved choice; null before the first refresh or when availability can't be read. */
export function readKeyboardLocalEngine(): LocalEngineChoice | null {
  return current;
}

/** Resolves the engine the way LocalTranscriptionService.transcribe does, stores it, notifies. */
export async function refreshKeyboardLocalEngine(): Promise<void> {
  const refresh = ++latestRefresh;
  let next: LocalEngineChoice | null;
  try {
    const availability = await LocalTranscriptionService.getAvailability();
    next = selectLocalEngine(
      getPreferredTranscriptionLanguages(),
      availability,
      getPickedLocalModel('dictation'),
    );
  } catch {
    next = null;
  }
  // A refresh started later read newer state; an older one finishing last mustn't overwrite it.
  if (refresh !== latestRefresh) return;
  current = next;
  listeners.forEach((listener) => listener());
}

export function subscribeKeyboardLocalEngine(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
