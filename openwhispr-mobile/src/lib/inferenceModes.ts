import type { LucideIconName } from '@/components/ui/SystemIcon';
import type { InferenceMode } from '@/types';

export type ModeDescriptor = {
  mode: InferenceMode;
  icon: string;
  mdIcon: LucideIconName;
  title: string;
  description: string;
};

export type InferenceScope = 'speech';

const BASE: Record<InferenceMode, Omit<ModeDescriptor, 'description'>> = {
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
  openwhispr: 'Hosted by OpenWhispr. Requires sign-in.',
  local: 'Audio never leaves this phone.',
};

const SPEECH_TITLES: Partial<Record<InferenceMode, string>> = {
  local: 'On-Device',
};

const SCOPE_MODES: Record<InferenceScope, InferenceMode[]> = {
  speech: ['openwhispr', 'local'],
};

export function getInferenceModes(scope: InferenceScope): ModeDescriptor[] {
  return SCOPE_MODES[scope].map((mode) => {
    const base = BASE[mode];
    return {
      ...base,
      title: SPEECH_TITLES[mode] || base.title,
      description: SPEECH_DESCRIPTIONS[mode],
    };
  });
}

export const MODE_LABELS: Record<InferenceMode, string> = {
  openwhispr: 'OpenWhispr Cloud',
  local: 'On-Device',
};
