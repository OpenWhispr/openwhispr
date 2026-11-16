import type { NotchState } from './Notch';
import type { HomeKey } from './strings';
import { uploadProgress } from './model';

/** Work the processing notch is showing. `doneText` is set once the text has arrived. */
export interface NotchModel {
  flow: 'dictate' | 'upload' | 'retry';
  startedAt: number;
  doneText: string | null;
  /** Upload only: the file chosen in the picker. */
  name?: string;
  size?: number;
}

type T = (key: HomeKey, options?: Record<string, unknown>) => string;

/**
 * Transcription reports no upload progress, so the ring is an estimate from the file size
 * (the same one the old progress bar used). It fills over the first half of the estimate,
 * then the notch moves on to "Writing it up…"; tidying the text also moves it on.
 */
const UPLOAD_SHARE = 0.5;

export function uploadRing(model: NotchModel, now: number): number {
  const estimate = uploadProgress({
    elapsedMs: now - model.startedAt,
    sizeBytes: model.size,
    done: false,
  });
  return Math.min(1, estimate / UPLOAD_SHARE);
}

function uploading(model: NotchModel, stage: string, now: number): boolean {
  return model.flow === 'upload' && stage !== 'cleaning' && uploadRing(model, now) < 1;
}

export function notchStateFor(
  model: NotchModel | null,
  stage: string,
  now: number,
  t: T,
  onCancel: () => void,
): NotchState | null {
  if (!model) return null;
  if (model.doneText) return { kind: 'done', text: model.doneText };
  if (model.flow === 'dictate') return { kind: 'busy', text: t('writingItUp') };
  if (uploading(model, stage, now)) {
    const ring = uploadRing(model, now);
    return {
      kind: 'busy',
      text: t('uploadingPercent', { percent: Math.round(ring * 100) }),
      detail: model.name || undefined,
      progress: ring,
      onCancel,
    };
  }
  return { kind: 'busy', text: t('writingItUpMinute'), onCancel };
}

/**
 * What a screen reader hears, once per state: "Writing it up", "Uploading 25 percent" in
 * steps of 25 so it isn't read every tick, then the done text.
 */
export function notchAnnouncement(
  state: NotchState | null,
  model: NotchModel | null,
  stage: string,
  now: number,
  t: T,
): string {
  if (!state || !model) return '';
  if (state.kind === 'done') return state.text;
  if (uploading(model, stage, now)) {
    const step = Math.floor(uploadRing(model, now) * 4) * 25;
    return t('announceUploading', { percent: step });
  }
  return t('announceWritingItUp');
}
