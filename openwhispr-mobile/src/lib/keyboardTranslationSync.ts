import { AppState, Platform } from 'react-native';
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
import { getLocalReasoningReadiness, isAppleLocalIntelligenceEnabled } from '@/lib/localReasoning';
import type { LocalReasoningReadiness } from '@/types';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { AppGroupStorage, APP_GROUP_KEYS } from '../../modules/app-group-storage/src';

// The keyboard's Translate menu ships in the same binary as Apple Intelligence's language list. An
// over-the-air update running on an older build has a keyboard that can neither show a picked
// language nor turn it off, so translation stays off there.
export function keyboardCanTranslate(): boolean {
  return Platform.OS === 'ios' && AppleLLM.hasSupportedLanguages();
}

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

export interface OnDeviceTranslationSupport {
  /** Language codes Apple Intelligence can translate into; null while unknown (all listed). */
  codes: string[] | null;
  readiness: LocalReasoningReadiness;
}

// Re-reads readiness rather than taking the cache, since Apple Intelligence can be turned on or
// finish downloading in iOS Settings while the app is in the background.
export async function readOnDeviceTranslationSupport(): Promise<OnDeviceTranslationSupport> {
  const [codes, readiness] = await Promise.all([
    AppleLLM.getSupportedLanguages(),
    getLocalReasoningReadiness({ refresh: true }),
  ]);
  return { codes: codes.length > 0 ? codes : null, readiness };
}

// What the last read found; null while unknown, which lists every language and counts as ready.
let onDeviceSupport: OnDeviceTranslationSupport | null = null;

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

// Pull a keyboard-made change back into config. A missing key is the keyboard's Off, so it
// wins over a stale config value; the key itself is never written from config. The app writes
// the key only from the in-app setter: a language the current route can't translate into is kept
// and reads as Off (coerceTranslationTarget), since the route can read differently for a moment
// (Local Mode before sign-in is restored) and the choice stays until the user turns it off.
export async function reconcileKeyboardTranslationFromAppGroup(): Promise<void> {
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
  const languages = translationLanguagesFor(
    route?.cleanupMode ?? null,
    onDeviceSupport?.codes ?? null,
  );
  const applicable =
    keyboardCanTranslate() &&
    isTranslationApplicable({
      mode: route?.cleanupMode ?? null,
      cleanupUnavailable: route?.cleanupUnavailable ?? false,
      guest: requiresRealAccount(user),
      onDeviceUnavailable: onDeviceSupport !== null && onDeviceSupport.readiness.status !== 'ready',
    });
  return { languages, applicable };
}

function writeLanguagesAndApplicable(): void {
  const { languages, applicable } = translationState();
  AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_TRANSLATION_LANGUAGES, JSON.stringify(languages));
  AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_TRANSLATION_APPLICABLE, applicable ? '1' : '0');
}

// Overlapping calls (start, foreground) are harmless: each re-reads the key and only ever moves
// config toward it.
function reconcileQuietly(): void {
  reconcileKeyboardTranslationFromAppGroup().catch(() => {});
}

export function startKeyboardTranslationSync(): () => void {
  let stopped = false;
  let readSequence = 0;
  let appleIntelligenceEnabled = isAppleLocalIntelligenceEnabled();
  onDeviceSupport = null;

  const refreshOnDeviceSupport = (): void => {
    const sequence = ++readSequence;
    readOnDeviceTranslationSupport()
      .then((support) => {
        // A read that outlives the sync, or a newer read, must not write over later state.
        if (stopped || sequence !== readSequence) return;
        onDeviceSupport = support;
        writeLanguagesAndApplicable();
      })
      .catch(() => {});
  };

  const onStateChange = (): void => {
    writeLanguagesAndApplicable();
    // The AI Models switch for Apple Intelligence changes readiness without leaving the app.
    const enabled = isAppleLocalIntelligenceEnabled();
    if (enabled !== appleIntelligenceEnabled) {
      appleIntelligenceEnabled = enabled;
      refreshOnDeviceSupport();
    }
  };

  writeLanguagesAndApplicable();
  reconcileQuietly();
  refreshOnDeviceSupport();

  const unsubConfig = useConfigStore.subscribe(onStateChange);
  const unsubMode = useProcessingModeStore.subscribe(onStateChange);
  const unsubAuth = useAuthStore.subscribe(onStateChange);
  const appStateSub = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      reconcileQuietly();
      refreshOnDeviceSupport();
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
