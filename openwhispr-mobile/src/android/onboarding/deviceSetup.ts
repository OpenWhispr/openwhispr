import { create } from 'zustand';
import {
  cancelAndroidDownload,
  downloadAndroidModel,
  modelReady,
  type AndroidModelId,
} from '../models';
import { CLEANUP, SPEECH } from './setup';

/** The optional rows on "Set up your device". Speech is always on. */
export type DeviceExtra = 'cleanup' | 'assistant' | 'speakers';
export type DeviceChoices = Record<DeviceExtra, boolean>;
export const SPEAKERS = 'meeting-speakers' as const;

/** Cleanup and the Assistant share one text model, so either one downloads it once. */
export function modelFor(item: 'speech' | DeviceExtra): AndroidModelId {
  return item === 'speech' ? SPEECH : item === 'speakers' ? SPEAKERS : CLEANUP;
}

/** What to download, in order: Speech first (Continue waits only for it), then what was added. */
export function modelsToDownload(choices: DeviceChoices): AndroidModelId[] {
  const models: AndroidModelId[] = [SPEECH];
  if (choices.cleanup || choices.assistant) models.push(CLEANUP);
  if (choices.speakers) models.push(SPEAKERS);
  return models;
}

export type ModelState = 'queued' | 'downloading' | 'ready' | 'failed';

type DeviceSetup = {
  choices: DeviceChoices;
  states: Partial<Record<AndroidModelId, ModelState>>;
  error: string;
};

const NONE: DeviceChoices = { cleanup: false, assistant: false, speakers: false };

/**
 * The on-device downloads. They live outside the screens so "Your device is ready" keeps showing an
 * optional model that is still arriving, and leaving a screen never stops a download.
 */
export const useDeviceSetup = create<DeviceSetup>(() => ({ choices: NONE, states: {}, error: '' }));

let running = false;

function setState(id: AndroidModelId, state: ModelState) {
  useDeviceSetup.setState((current) => ({ states: { ...current.states, [id]: state } }));
}

/** Downloads every model the current choices need, one at a time, until none is left. */
export async function runDeviceDownloads(): Promise<void> {
  if (running) return;
  running = true;
  useDeviceSetup.setState({ error: '' });
  try {
    for (;;) {
      const { choices, states } = useDeviceSetup.getState();
      const wanted = modelsToDownload(choices);
      for (const id of wanted) if (!states[id]) setState(id, 'queued');
      const next = wanted.find((id) => states[id] !== 'ready' && states[id] !== 'failed');
      if (!next) return;
      if (await modelReady(next)) {
        setState(next, 'ready');
        continue;
      }
      setState(next, 'downloading');
      try {
        await downloadAndroidModel(next);
        setState(next, 'ready');
      } catch (failure) {
        // Removed while downloading: no longer wanted, so not an error.
        if (!modelsToDownload(useDeviceSetup.getState().choices).includes(next)) {
          useDeviceSetup.setState((current) => {
            const remaining = { ...current.states };
            delete remaining[next];
            return { states: remaining };
          });
          continue;
        }
        setState(next, 'failed');
        useDeviceSetup.setState({ error: (failure as Error).message });
        return;
      }
    }
  } finally {
    running = false;
  }
}

/** Adds or removes an optional row, then downloads (or stops downloading) what that changes. */
export function setDeviceExtra(item: DeviceExtra, on: boolean): void {
  const before = modelsToDownload(useDeviceSetup.getState().choices);
  const choices = { ...useDeviceSetup.getState().choices, [item]: on };
  useDeviceSetup.setState({ choices });
  const after = modelsToDownload(choices);
  for (const id of before)
    if (!after.includes(id)) {
      const state = useDeviceSetup.getState().states[id];
      if (state === 'downloading') void cancelAndroidDownload(id);
      else if (state !== 'ready')
        useDeviceSetup.setState((current) => {
          const remaining = { ...current.states };
          delete remaining[id];
          return { states: remaining };
        });
    }
  void runDeviceDownloads();
}

/** Try again after a failed download: clears the failure and runs the queue. */
export function retryDeviceDownloads(): void {
  useDeviceSetup.setState((current) => ({
    states: Object.fromEntries(
      Object.entries(current.states).filter(([, state]) => state !== 'failed'),
    ),
  }));
  void runDeviceDownloads();
}
