import type { UserConfig } from '@/types';

const DEFAULT_AGENT_NAME = 'OpenWhispr';

export function getDictationAgentName(config: UserConfig): string {
  const name = config.dictationAgentName?.trim();
  return name || DEFAULT_AGENT_NAME;
}

export function isDictationAgentEnabled(config: UserConfig): boolean {
  return config.dictationAgentEnabled ?? true;
}

// Configs from before Note Chat had a switch of its own get it saved at launch (noteChatSplitConfig).
export function isNoteChatEnabled(config: UserConfig): boolean {
  return config.noteChatEnabled ?? true;
}

/** The chat switch as the chat screens read it: on until a config has loaded. */
export function isChatEnabled(config: UserConfig | null): boolean {
  return config ? isNoteChatEnabled(config) : true;
}
