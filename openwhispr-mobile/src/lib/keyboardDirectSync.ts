import { AppGroupStorage, APP_GROUP_KEYS } from '../../modules/app-group-storage/src';
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
  | 'word_limit';

/**
 * What the keyboard reads from the App Group (`keyboard_direct_config`) to dictate without the
 * app: plugins/keyboard-extension/ios/DirectDictationConfig.swift decodes it. Keep the keys and
 * `version` in step with that file.
 */
export interface KeyboardDirectConfig {
  version: 1;
  enabled: boolean;
  disabledReason: KeyboardDirectDisabledReason | null;
  userId: string | null;
  apiBaseUrl: string;
  appVersion: string | null;
  language: string | null;
  cleanup: { enabled: boolean; language: string | null; toneApplies: boolean };
  dictionary: { personal: string[]; shared: string[]; prompt: string };
  snippets: { trigger: string; replacement: string }[];
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
}

// The keyboard sends one fused /api/transcribe request, so it may only take dictations the app
// itself would send that way: Cloud transcription, and cleanup either off or on OpenWhispr Cloud.
function sendsLikeTheApp({ route, cleanupEnabled }: KeyboardDirectInputs): boolean {
  if (route?.provider !== 'cloud') return false;
  if (!cleanupEnabled) return true;
  return route.cleanupMode === 'openwhispr' && !route.cleanupUnavailable;
}

function disabledReason(inputs: KeyboardDirectInputs): KeyboardDirectDisabledReason | null {
  if (!inputs.settingEnabled) return 'setting_off';
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
  return {
    version: 1,
    enabled,
    disabledReason: reason,
    // Nothing personal sits in the App Group for a path that is off.
    userId: enabled ? inputs.userId : null,
    apiBaseUrl: inputs.apiBaseUrl,
    appVersion: inputs.appVersion,
    language: inputs.language,
    cleanup: {
      enabled: inputs.cleanupEnabled,
      language: inputs.language,
      toneApplies: inputs.toneApplies,
    },
    dictionary: enabled ? inputs.dictionary : { personal: [], shared: [], prompt: '' },
    snippets: enabled ? inputs.snippets : [],
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
