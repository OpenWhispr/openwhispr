import { Platform } from 'react-native';
import type { LucideIconName } from '@/components/ui/SystemIcon';
import type { InferenceMode, UserConfig } from '@/types';

export type ModeDescriptor = {
  mode: InferenceMode;
  icon: string;
  mdIcon: LucideIconName;
  title: string;
  description: string;
};

export type InferenceScope = 'speech';

const BASE: Record<InferenceMode, Omit<ModeDescriptor, 'description'>> = {
  providers: { mode: 'providers', icon: 'key', mdIcon: 'KeyRound', title: 'Providers' },
  openwhispr: {
    mode: 'openwhispr',
    icon: 'cloud',
    mdIcon: 'Cloud',
    title: 'OpenWhispr Cloud',
  },
  local: {
    mode: 'local',
    icon: 'iphone',
    mdIcon: 'Smartphone',
    title: 'Local',
  },
};

const SPEECH_DESCRIPTIONS: Record<InferenceMode, string> = {
  providers: 'Use your own provider key. Billed by your provider.',
  openwhispr: 'Hosted by OpenWhispr. Requires sign-in.',
  local: 'Audio never leaves this phone.',
};

const SPEECH_TITLES: Partial<Record<InferenceMode, string>> = {
  local: 'On-Device',
};

const SCOPE_MODES: Record<InferenceScope, InferenceMode[]> = {
  speech: ['openwhispr', 'local', 'providers'],
};

export function getInferenceModes(scope: InferenceScope): ModeDescriptor[] {
  return SCOPE_MODES[scope]
    .filter((mode) => mode !== 'providers' || Platform.OS === 'ios')
    .map((mode) => {
      const base = BASE[mode];
      return {
        ...base,
        title: SPEECH_TITLES[mode] || base.title,
        description: SPEECH_DESCRIPTIONS[mode],
      };
    });
}

export const MODE_LABELS: Record<InferenceMode, string> = {
  providers: 'Providers',
  openwhispr: 'OpenWhispr Cloud',
  local: 'On-Device',
};

// The Home toggle and the Speech-to-Text picker both own the dictation mode;
// writing the scope selection alongside defaultMode keeps routing and UI in step.
export function dictationModeConfig(
  config: UserConfig | null,
  mode: 'cloud' | 'private',
): Pick<UserConfig, 'defaultMode' | 'inference'> {
  return {
    defaultMode: mode,
    inference: {
      ...config?.inference,
      dictation: { mode: mode === 'private' ? 'local' : 'openwhispr' },
    },
  };
}
