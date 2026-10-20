import type { ProcessingMode, UserConfig } from '@/types';

const DEFAULT_AGENT_NAME = 'OpenWhispr';

export function getDictationAgentName(config: UserConfig): string {
  const name = config.dictationAgentName?.trim();
  return name || DEFAULT_AGENT_NAME;
}

export function isDictationAgentEnabled(config: UserConfig): boolean {
  return config.dictationAgentEnabled ?? true;
}

// The voice assistant is the keyboard's compose wand, which has no on-device version yet, so Local
// Mode keeps it off.
export function isDictationAgentApplicable(mode: ProcessingMode, config: UserConfig): boolean {
  return (mode === 'cloud' || mode === 'providers') && isDictationAgentEnabled(config);
}

// Configs from before Note Chat had a switch of its own get it saved at launch (noteChatSplitConfig).
export function isNoteChatEnabled(config: UserConfig): boolean {
  return config.noteChatEnabled ?? true;
}
