import { AppState } from 'react-native';
import { requiresRealAccount } from '@/lib/accountAccess';
import { AppleLLM } from '@/lib/appleLLM';
import type { AuthUser } from '@/lib/authClient';
import { dictationRoute } from '@/lib/keyboardDirectInputs';
import {
  coerceTranslationTarget,
  isTranslationApplicable,
  translationLanguagesFor,
  type TranslationLanguage,
} from '@/lib/keyboardTranslation';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { AppGroupStorage, APP_GROUP_KEYS } from '../../modules/app-group-storage/src';

// Off is the absence of the target key; an empty string is only ever a per-job snapshot of Off.
function readTarget(): string | null {
  return AppGroupStorage.getItem(APP_GROUP_KEYS.KEYBOARD_TRANSLATION_TARGET) || null;
}

function writeTarget(code: string | null): void {
  if (code === null) {
    AppGroupStorage.removeItem(APP_GROUP_KEYS.KEYBOARD_TRANSLATION_TARGET);
  } else {
    AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_TRANSLATION_TARGET, code);
  }
}

// Freezes the effective target for the in-flight job, tagged with the job id, so a later
// change in the keyboard can't alter a dictation that is already recording. It is the target
// the keyboard shows: Off when translation isn't applicable or the stored code isn't listed.
// `user` is the account the job runs under: at a cold launch the handoff starts before sign-in
// is restored, so it passes the cached account in place of the still-empty auth store.
export function snapshotKeyboardTranslation(
  jobId: string,
  user: AuthUser | null = useAuthStore.getState().user,
): string | null {
  const { languages, applicable } = translationState(user);
  const target = applicable ? coerceTranslationTarget(readTarget(), languages) : null;
  AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_RECORDING_TRANSLATION, target ?? '');
  AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_RECORDING_TRANSLATION_JOB_ID, jobId);
  return target;
}

// The snapshot only when it belongs to this job. On a mismatch (orphan recovery, or a
// snapshot superseded by a newer job) it is Off, never the live target.
export function readKeyboardTranslationSnapshot(jobId: string | null | undefined): string | null {
  const snapshotJobId = AppGroupStorage.getItem(
    APP_GROUP_KEYS.KEYBOARD_RECORDING_TRANSLATION_JOB_ID,
  );
  if (jobId && snapshotJobId && snapshotJobId === jobId) {
    return AppGroupStorage.getItem(APP_GROUP_KEYS.KEYBOARD_RECORDING_TRANSLATION) || null;
  }
  return null;
}

// Language codes the on-device model can translate into; null while unknown.
let onDeviceCodes: string[] | null = null;

function currentLanguages(): TranslationLanguage[] {
  return translationLanguagesFor(dictationRoute()?.cleanupMode ?? null, onDeviceCodes);
}

function configTarget(): string | null {
  return useConfigStore.getState().config?.keyboardTranslationTarget ?? null;
}

// Shared picker setter: write the App Group key immediately so the keyboard reflects the
// choice without waiting on async config persistence.
export function setKeyboardTranslationTarget(code: string | null): void {
  writeTarget(code);
  useConfigStore
    .getState()
    .updateConfig({ keyboardTranslationTarget: code })
    .catch(() => {});
}

// The App Group key is the single source of truth for the target; config only mirrors it for
// the settings UI. The app writes the key only from the in-app setter and when clearing a
// target the current model can't translate into.
function clearUnsupportedTarget(): boolean {
  const stored = readTarget();
  if (stored === null || coerceTranslationTarget(stored, currentLanguages()) !== null) return false;
  writeTarget(null);
  useConfigStore
    .getState()
    .updateConfig({ keyboardTranslationTarget: null })
    .catch(() => {});
  return true;
}

// Pull a keyboard-made change back into config. A missing key is the keyboard's Off, so it
// wins over a stale config value; the key itself is never written from config.
export async function reconcileKeyboardTranslationFromAppGroup(): Promise<void> {
  if (clearUnsupportedTarget()) return;
  const stored = readTarget();
  if (stored !== configTarget()) {
    await useConfigStore.getState().updateConfig({ keyboardTranslationTarget: stored });
  }
}

function translationState(user: AuthUser | null = useAuthStore.getState().user): {
  languages: TranslationLanguage[];
  applicable: boolean;
} {
  const route = dictationRoute();
  const languages = translationLanguagesFor(route?.cleanupMode ?? null, onDeviceCodes);
  const applicable = isTranslationApplicable({
    mode: route?.cleanupMode ?? null,
    cleanupUnavailable: route?.cleanupUnavailable ?? false,
    guest: requiresRealAccount(user),
  });
  return { languages, applicable };
}

function writeLanguagesAndApplicable(): void {
  const { languages, applicable } = translationState();
  AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_TRANSLATION_LANGUAGES, JSON.stringify(languages));
  AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_TRANSLATION_APPLICABLE, applicable ? '1' : '0');
}

// Overlapping calls (start, foreground, post-fetch) are harmless: each re-reads the key and
// only ever moves config toward it.
function reconcileQuietly(): void {
  reconcileKeyboardTranslationFromAppGroup().catch(() => {});
}

export function startKeyboardTranslationSync(): () => void {
  let stopped = false;
  onDeviceCodes = null;

  const refreshOnDeviceCodes = (): void => {
    AppleLLM.getSupportedLanguages()
      .then((codes) => {
        // A fetch that outlives the sync must not write over a later start's state.
        if (stopped) return;
        onDeviceCodes = codes.length > 0 ? codes : null;
        writeLanguagesAndApplicable();
        reconcileQuietly();
      })
      .catch(() => {});
  };

  const onStateChange = (): void => {
    writeLanguagesAndApplicable();
    clearUnsupportedTarget();
  };

  writeLanguagesAndApplicable();
  reconcileQuietly();
  refreshOnDeviceCodes();

  const unsubConfig = useConfigStore.subscribe(onStateChange);
  const unsubMode = useProcessingModeStore.subscribe(onStateChange);
  const unsubAuth = useAuthStore.subscribe(onStateChange);
  const appStateSub = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      reconcileQuietly();
      refreshOnDeviceCodes();
    }
  });

  return () => {
    stopped = true;
    unsubConfig();
    unsubMode();
    unsubAuth();
    appStateSub.remove();
  };
}
