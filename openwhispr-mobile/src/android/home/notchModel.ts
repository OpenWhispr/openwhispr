import type { NotchState } from './Notch';
import type { HomeKey } from './strings';

/** Work the processing notch is showing. `doneText` is set once the text has arrived. */
export interface NotchModel {
  flow: 'dictate' | 'retry';
  startedAt: number;
  doneText: string | null;
  /** Cancelled or failed: the notch slides back without a done state. */
  closing?: boolean;
}

type T = (key: HomeKey, options?: Record<string, unknown>) => string;

export function notchStateFor(
  model: NotchModel | null,
  t: T,
  onCancel: () => void,
): NotchState | null {
  if (!model) return null;
  if (model.closing) return { kind: 'closing' };
  if (model.doneText) return { kind: 'done', text: model.doneText };
  if (model.flow === 'dictate') return { kind: 'busy', text: t('writingItUp') };
  return { kind: 'busy', text: t('writingItUpMinute'), onCancel };
}

/** What a screen reader hears, once per state: "Writing it up", then the done text. */
export function notchAnnouncement(state: NotchState | null, t: T): string {
  if (!state || state.kind === 'closing') return '';
  if (state.kind === 'done') return state.text;
  return t('announceWritingItUp');
}
