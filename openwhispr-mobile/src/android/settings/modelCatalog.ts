import { useCallback, useEffect, useState } from 'react';
import { useIsFocused } from '@react-navigation/native';
import {
  ANDROID_MODELS,
  modelReady,
  modelSupported,
  useModelDownloads,
  type AndroidModelId,
} from '../models';
import { canTranscribeMeetings } from '../speechSelection';
import type { SettingsKey } from './strings';

export type ModelKind = 'speech' | 'text' | 'diarization';

/** The Settings names and lines for each on-device model, best first in each kind. */
export const MODEL_ROWS: {
  id: AndroidModelId;
  kind: ModelKind;
  name: string;
  line?: SettingsKey;
  recommended?: boolean;
}[] = [
  {
    id: 'parakeet-v3',
    kind: 'speech',
    name: 'Parakeet v3',
    line: 'languages25',
    recommended: true,
  },
  { id: 'moonshine-small', kind: 'speech', name: 'Moonshine Small', line: 'englishOnly' },
  { id: 'moonshine-tiny', kind: 'speech', name: 'Moonshine Tiny', line: 'englishOnlyFastest' },
  { id: 'qwen-balanced', kind: 'text', name: 'Qwen3 1.7B', line: 'bestQuality', recommended: true },
  { id: 'qwen-small', kind: 'text', name: 'Qwen 0.5B', line: 'fasterOlder' },
  {
    id: 'meeting-speakers',
    kind: 'diarization',
    name: 'Meeting speakers',
    line: 'meetingSpeakersBody',
  },
];

/** The speech models a meeting on the phone can be recorded with, in catalog order. */
export const meetingModelRows = () =>
  MODEL_ROWS.filter(
    (row) => row.kind === 'speech' && canTranscribeMeetings(row.id) && modelSupported(row.id),
  );

export const modelName = (id: AndroidModelId) =>
  MODEL_ROWS.find((row) => row.id === id)?.name ?? ANDROID_MODELS[id].title;

/** "670 MB" or "1.1 GB". */
export function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/**
 * Which models are on this phone, re-read whenever a download ends or the screen comes back.
 * `checked` stays false until the first read (it hashes every file, a few seconds on a cold start).
 */
export function useModelsReady() {
  const [ready, setReady] = useState<Partial<Record<AndroidModelId, boolean>>>({});
  const [checked, setChecked] = useState(false);
  const progress = useModelDownloads((state) => state.progress);
  const activeDownloads = Object.keys(progress).sort().join(',');
  const focused = useIsFocused();
  const refresh = useCallback(async () => {
    const rows = await Promise.all(
      MODEL_ROWS.map(async ({ id }) => [id, await modelReady(id).catch(() => false)] as const),
    );
    setReady(Object.fromEntries(rows));
    setChecked(true);
  }, []);
  useEffect(() => {
    if (focused) refresh().catch(() => undefined);
  }, [activeDownloads, focused, refresh]);
  return { ready, checked, progress, refresh };
}
