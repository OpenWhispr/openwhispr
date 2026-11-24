import { AppState } from 'react-native';
import { API_ENDPOINTS } from '@/config/constants';
import { requiresRealAccount } from '@/lib/accountAccess';
import { getClientVersionHeader } from '@/lib/apiClient';
import { buildDictationHintTiers, buildLlmDictionary } from '@/lib/dictationHints';
import { snapshotTranscriptionJob } from '@/lib/inferenceRouting';
import {
  readKeyboardLocalEngine,
  refreshKeyboardLocalEngine,
  subscribeKeyboardLocalEngine,
} from '@/lib/keyboardLocalEngine';
import { isToneApplicable } from '@/lib/keyboardTone';
import { isTranslationApplicable } from '@/lib/keyboardTranslation';
import { getPreferredTranscriptionLanguage } from '@/lib/transcriptionLanguage';
import { cloudDictationPrompt } from '@/lib/transcriptionPromptCap';
import type { KeyboardDirectInputs } from '@/lib/keyboardDirectSync';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { getActiveCustomCleanupPrompt, useCustomPromptsStore } from '@/store/useCustomPromptsStore';
import { useDictionaryStore } from '@/store/useDictionaryStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { useSharedDictionaryStore } from '@/store/useSharedDictionaryStore';
import { useSnippetsStore } from '@/store/useSnippetsStore';
import { getUsageOwnerKey, useUsageStore } from '@/store/useUsageStore';

// Keyboard dictations are dictation contexts: snippet triggers ride with personal words.
const INCLUDE_SNIPPET_TRIGGERS = true;

export function dictationRoute(): KeyboardDirectInputs['route'] {
  try {
    const job = snapshotTranscriptionJob('dictation', ['cleanup']);
    return {
      provider: job.provider,
      cleanupMode: job.cleanupRoute?.mode ?? null,
      cleanupUnavailable: Boolean(job.cleanupUnavailable),
    };
  } catch {
    // A Bring Your Own Key route that isn't set up: not something the keyboard can send.
    return null;
  }
}

// Usage the app has loaded for this account. The keyboard path would only hit a 429 anyway,
// and a tap that opens the app explains the limit.
function overWordLimit(): boolean {
  const { usage, ownerKey } = useUsageStore.getState();
  if (!usage || !ownerKey || ownerKey !== getUsageOwnerKey()) return false;
  return usage.limit > 0 && usage.wordsRemaining <= 0;
}

export function gatherKeyboardDirectInputs(): KeyboardDirectInputs {
  const config = useConfigStore.getState().config;
  const { user, sessionCookie } = useAuthStore.getState();
  const cleanupEnabled = config?.cleanupEnabled ?? true;
  const snippetState = useSnippetsStore.getState();
  const llm = buildLlmDictionary(INCLUDE_SNIPPET_TRIGGERS);
  const language = getPreferredTranscriptionLanguage() ?? null;
  const route = dictationRoute();
  const guest = requiresRealAccount(user);
  return {
    settingEnabled: config?.keyboardDirectDictation === true,
    userId: guest ? null : (user?.id ?? null),
    hasSessionCookie: Boolean(sessionCookie?.trim()),
    route,
    cleanupEnabled,
    customCleanupPrompt: getActiveCustomCleanupPrompt() !== undefined,
    // The app reads no workspace policy before it uploads a keyboard dictation; the server
    // refuses with 403, which turns the keyboard's path off until this snapshot changes.
    cloudTranscriptionAllowed: true,
    overWordLimit: overWordLimit(),
    apiBaseUrl: API_ENDPOINTS.OPENWHISPR_API,
    appVersion: getClientVersionHeader()['x-openwhispr-version'] ?? null,
    language,
    toneApplies: isToneApplicable(useProcessingModeStore.getState().activeMode, cleanupEnabled),
    dictionary: {
      personal: llm.personal,
      shared: llm.shared,
      prompt: cloudDictationPrompt(buildDictationHintTiers(INCLUDE_SNIPPET_TRIGGERS)),
    },
    snippets: snippetState.isLoaded
      ? snippetState.entries.map(({ trigger, replacement }) => ({ trigger, replacement }))
      : [],
    localEngine: readKeyboardLocalEngine(),
    // Parakeet takes the hint only for exactly one selected language, as the cloud API does.
    localLanguageHint: language,
    translationApplies: isTranslationApplicable({
      mode: route?.cleanupMode ?? null,
      cleanupUnavailable: route?.cleanupUnavailable ?? false,
      guest,
    }),
  };
}

/** Calls `listener` whenever anything the snapshot reads may have changed. */
export function subscribeKeyboardDirectInputs(listener: () => void): () => void {
  const refreshLocalEngine = (): void => {
    refreshKeyboardLocalEngine().catch(() => {});
  };
  const unsubscribers = [
    useConfigStore.subscribe(listener),
    // The picked model and the languages live in the config; installed models only change on
    // download or delete (LocalParakeetService refreshes then) or while the app was away.
    useConfigStore.subscribe(refreshLocalEngine),
    subscribeKeyboardLocalEngine(listener),
    useAuthStore.subscribe(listener),
    useProcessingModeStore.subscribe(listener),
    useSnippetsStore.subscribe(listener),
    useDictionaryStore.subscribe(listener),
    useSharedDictionaryStore.subscribe(listener),
    useCustomPromptsStore.subscribe(listener),
    useUsageStore.subscribe(listener),
  ];
  const appState = AppState.addEventListener('change', (state) => {
    if (state !== 'active') return;
    listener();
    refreshLocalEngine();
  });
  refreshLocalEngine();
  return () => {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    appState.remove();
  };
}
