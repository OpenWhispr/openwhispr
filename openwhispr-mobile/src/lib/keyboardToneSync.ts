import { AppState } from 'react-native';
import type { KeyboardTone } from '@/types';
import { KEYBOARD_TONES, DEFAULT_KEYBOARD_TONE, isToneApplicable } from '@/lib/keyboardTone';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { AppGroupStorage, APP_GROUP_KEYS } from '../../modules/app-group-storage/src';

const VALID = new Set<string>(KEYBOARD_TONES.map((tone) => tone.value));

function coerceTone(value: string | null | undefined): KeyboardTone {
  return value && VALID.has(value) ? (value as KeyboardTone) : DEFAULT_KEYBOARD_TONE;
}

// Reads the current sticky tone and freezes it for the in-flight job, tagged
// with the job id. Called at record-start so a later tone change can't affect a
// job already recording, and a stale snapshot can't leak into a different job.
export function snapshotKeyboardTone(jobId: string): KeyboardTone {
  const tone = coerceTone(AppGroupStorage.getItem(APP_GROUP_KEYS.KEYBOARD_DICTATION_TONE));
  AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_RECORDING_TONE, tone);
  AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_RECORDING_TONE_JOB_ID, jobId);
  return tone;
}

// Returns the per-job snapshot ONLY when it belongs to this job. On any
// mismatch/absence (orphan/recovery, or a snapshot superseded by a newer job)
// it returns Default, never the live sticky tone.
export function readKeyboardToneSnapshot(jobId: string | null | undefined): KeyboardTone {
  const snapJobId = AppGroupStorage.getItem(APP_GROUP_KEYS.KEYBOARD_RECORDING_TONE_JOB_ID);
  if (jobId && snapJobId && snapJobId === jobId) {
    return coerceTone(AppGroupStorage.getItem(APP_GROUP_KEYS.KEYBOARD_RECORDING_TONE));
  }
  return DEFAULT_KEYBOARD_TONE;
}

function writeAppGroupDictationTone(): void {
  const tone = useConfigStore.getState().config?.keyboardTone ?? DEFAULT_KEYBOARD_TONE;
  AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_DICTATION_TONE, tone);
}

// Pull a keyboard-made tone change back into config so the settings UI reflects
// it. A missing or invalid App Group value means config remains the source of
// truth and is mirrored out instead.
export async function reconcileKeyboardToneFromAppGroup(): Promise<void> {
  const raw = AppGroupStorage.getItem(APP_GROUP_KEYS.KEYBOARD_DICTATION_TONE);
  if (raw === null || !VALID.has(raw)) {
    writeAppGroupDictationTone();
    return;
  }

  const stored = raw as KeyboardTone;
  const current = useConfigStore.getState().config?.keyboardTone ?? DEFAULT_KEYBOARD_TONE;
  if (stored !== current) {
    await useConfigStore.getState().updateConfig({ keyboardTone: stored });
  }
}

function writeAppGroupApplicable(): void {
  const config = useConfigStore.getState().config;
  const mode = useProcessingModeStore.getState().activeMode;
  const applicable = isToneApplicable(mode, config?.cleanupEnabled);
  AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_TONE_APPLICABLE, applicable ? '1' : '0');
}

let reconciling = false;

function writeAppGroupToneState(): void {
  if (!reconciling) writeAppGroupDictationTone();
  writeAppGroupApplicable();
}

async function guardedReconcile(): Promise<void> {
  reconciling = true;
  try {
    await reconcileKeyboardToneFromAppGroup();
  } finally {
    reconciling = false;
    writeAppGroupDictationTone();
  }
}

// Shared picker setter: write the App Group key immediately so the keyboard
// reflects the choice without waiting on async config persistence.
export function setKeyboardTone(tone: KeyboardTone): void {
  AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_DICTATION_TONE, tone);
  useConfigStore
    .getState()
    .updateConfig({ keyboardTone: tone })
    .catch(() => {});
}

export function startKeyboardToneSync(): () => void {
  writeAppGroupApplicable();
  guardedReconcile().catch(() => {});

  const unsubConfig = useConfigStore.subscribe(writeAppGroupToneState);
  const unsubMode = useProcessingModeStore.subscribe(writeAppGroupToneState);
  const appStateSub = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      guardedReconcile().catch(() => {});
    }
  });

  return () => {
    unsubConfig();
    unsubMode();
    appStateSub.remove();
  };
}
