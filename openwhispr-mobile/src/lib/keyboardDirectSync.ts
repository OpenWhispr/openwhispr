import { AppGroupStorage, APP_GROUP_KEYS } from '../../modules/app-group-storage/src';
import type { LocalEngineChoice } from '@/services/transcription/localEngine';
import { DEFAULT_TRANSLATE_PROMPT } from '@/config/prompts/registry';
import {
  gatherKeyboardDirectInputs,
  subscribeKeyboardDirectInputs,
} from '@/lib/keyboardDirectInputs';

export type KeyboardDirectDisabledReason =
  | 'setting_off'
  | 'signed_out'
  | 'not_cloud'
  | 'custom_prompt'
  | 'policy'
  | 'word_limit'
  // Local Mode resolves to Whisper, which the keyboard can't run.
  | 'local_engine_unsupported'
  // Local Mode with no model installed.
  | 'local_model_missing';

export type KeyboardLocalModel = 'parakeet-v2' | 'parakeet-v3';

/**
 * What the keyboard reads from the App Group (`keyboard_direct_config`) to dictate without the
 * app: plugins/keyboard-extension/ios/DirectDictationConfig.swift decodes it. Keep the keys and
 * `version` in step with that file.
 */
export interface KeyboardDirectConfig {
  version: 2;
  enabled: boolean;
  disabledReason: KeyboardDirectDisabledReason | null;
  engine: 'cloud' | 'local';
  /** Set only when the keyboard transcribes on this iPhone, so null whenever the path is off. */
  local: { model: KeyboardLocalModel; languageHint: string | null } | null;
  userId: string | null;
  apiBaseUrl: string;
  appVersion: string | null;
  language: string | null;
  cleanup: { enabled: boolean; language: string | null; toneApplies: boolean };
  dictionary: { personal: string[]; shared: string[]; prompt: string };
  snippets: { trigger: string; replacement: string }[];
  /** `prompt` carries `{{targetLanguage}}`; the keyboard fills in the label of its target. */
  translation: { enabled: boolean; prompt: string };
}

export interface KeyboardDirectInputs {
  settingEnabled: boolean;
  /** The signed-in real account's id; null for a guest, an anonymous session or nobody. */
  userId: string | null;
  hasSessionCookie: boolean;
  /** The dictation route as the app would snapshot it; null when no route can be built. */
  route: {
    provider: 'cloud' | 'byok' | 'local';
    cleanupMode: 'openwhispr' | 'local' | 'providers' | null;
    cleanupUnavailable: boolean;
  } | null;
  cleanupEnabled: boolean;
  customCleanupPrompt: boolean;
  cloudTranscriptionAllowed: boolean;
  overWordLimit: boolean;
  apiBaseUrl: string;
  appVersion: string | null;
  language: string | null;
  toneApplies: boolean;
  dictionary: { personal: string[]; shared: string[]; prompt: string };
  snippets: { trigger: string; replacement: string }[];
  /** The on-device engine a Local Mode dictation resolves to; null until it has been read. */
  localEngine: LocalEngineChoice | null;
  /** The single selected language for Parakeet's decoder hint; null for none or several. */
  localLanguageHint: string | null;
  /** `isTranslationApplicable` for the dictation route, as the keyboard's Translate menu sees it. */
  translationApplies: boolean;
}

// The keyboard sends one fused /api/transcribe request, so it may only take dictations the app
// itself would send that way: Cloud transcription, and cleanup either off or on OpenWhispr Cloud.
function sendsLikeTheApp({ route, cleanupEnabled }: KeyboardDirectInputs): boolean {
  if (route?.provider !== 'cloud') return false;
  if (!cleanupEnabled) return true;
  return route.cleanupMode === 'openwhispr' && !route.cleanupUnavailable;
}

function isLocal(inputs: KeyboardDirectInputs): boolean {
  return inputs.route?.provider === 'local';
}

// A Local take never reaches the network, so neither the session cookie nor anything the server
// enforces (custom prompts, policy, word limits) applies. The account is still required: a guest
// keeps the handoff.
function localDisabledReason(inputs: KeyboardDirectInputs): KeyboardDirectDisabledReason | null {
  if (!inputs.userId) return 'signed_out';
  switch (inputs.localEngine?.engine) {
    case 'parakeet':
      return null;
    case 'whisper':
      return 'local_engine_unsupported';
    default:
      return 'local_model_missing';
  }
}

function disabledReason(inputs: KeyboardDirectInputs): KeyboardDirectDisabledReason | null {
  if (!inputs.settingEnabled) return 'setting_off';
  if (isLocal(inputs)) return localDisabledReason(inputs);
  if (!inputs.userId || !inputs.hasSessionCookie) return 'signed_out';
  if (!sendsLikeTheApp(inputs)) return 'not_cloud';
  // The fused request can't carry a custom prompt; with cleanup off there's nothing to carry.
  if (inputs.cleanupEnabled && inputs.customCleanupPrompt) return 'custom_prompt';
  if (!inputs.cloudTranscriptionAllowed) return 'policy';
  if (inputs.overWordLimit) return 'word_limit';
  return null;
}

/** Pure: the first failing condition, in the spec's order, sets `disabledReason`. */
export function buildKeyboardDirectConfig(inputs: KeyboardDirectInputs): KeyboardDirectConfig {
  const reason = disabledReason(inputs);
  const enabled = reason === null;
  const local = isLocal(inputs);
  const engine = inputs.localEngine;
  // The keyboard translates through /api/reason only, so a route whose AI runs on the device or
  // with the user's own provider (eligible here with cleanup off) never sends its text there. A
  // Local snapshot never translates either, whatever the cleanup route: the keyboard sends nothing
  // for a Local take (Local Mode with Cloud cleanup included), so a selected target hands the take
  // to the app.
  const translates =
    enabled && !local && inputs.translationApplies && inputs.route?.cleanupMode === 'openwhispr';
  return {
    version: 2,
    enabled,
    disabledReason: reason,
    engine: local ? 'local' : 'cloud',
    local:
      enabled && local && engine?.engine === 'parakeet'
        ? { model: `parakeet-${engine.version}`, languageHint: inputs.localLanguageHint }
        : null,
    // Nothing personal sits in the App Group for a path that is off.
    userId: enabled ? inputs.userId : null,
    apiBaseUrl: inputs.apiBaseUrl,
    appVersion: inputs.appVersion,
    language: inputs.language,
    // The keyboard keeps a local take's raw Parakeet text: it never runs cleanup there.
    cleanup: {
      enabled: local ? false : inputs.cleanupEnabled,
      language: inputs.language,
      toneApplies: local ? false : inputs.toneApplies,
    },
    dictionary: enabled ? inputs.dictionary : { personal: [], shared: [], prompt: '' },
    snippets: enabled ? inputs.snippets : [],
    translation: { enabled: translates, prompt: translates ? DEFAULT_TRANSLATE_PROMPT : '' },
  };
}

export interface KeyboardDirectSyncDeps {
  gather: () => KeyboardDirectInputs;
  subscribe: (listener: () => void) => () => void;
  write: (json: string) => boolean;
}

const defaultDeps: KeyboardDirectSyncDeps = {
  gather: gatherKeyboardDirectInputs,
  subscribe: subscribeKeyboardDirectInputs,
  write: (json) => AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_DIRECT_CONFIG, json),
};

/** Keeps `keyboard_direct_config` up to date, writing only when the snapshot changes. */
export function startKeyboardDirectSync(deps: KeyboardDirectSyncDeps = defaultDeps): () => void {
  let written: string | null = null;
  const sync = (): void => {
    const json = JSON.stringify(buildKeyboardDirectConfig(deps.gather()));
    if (json === written) return;
    if (deps.write(json)) written = json;
  };
  sync();
  return deps.subscribe(sync);
}
