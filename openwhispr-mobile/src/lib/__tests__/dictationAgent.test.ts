import { getDictationAgentName, isChatEnabled, isNoteChatEnabled } from '@/lib/dictationAgent';
import type { UserConfig } from '@/types';

const baseConfig: UserConfig = { defaultMode: 'cloud' };

describe('getDictationAgentName', () => {
  it('returns the default name when dictationAgentName is unset', () => {
    expect(getDictationAgentName(baseConfig)).toBe('OpenWhispr');
  });

  it('returns the default name when dictationAgentName is blank', () => {
    expect(getDictationAgentName({ ...baseConfig, dictationAgentName: '   ' })).toBe('OpenWhispr');
  });

  it('returns the configured name trimmed', () => {
    expect(getDictationAgentName({ ...baseConfig, dictationAgentName: '  Aria  ' })).toBe('Aria');
  });

  it('returns the configured name as-is when already trimmed', () => {
    expect(getDictationAgentName({ ...baseConfig, dictationAgentName: 'Aria' })).toBe('Aria');
  });
});

// Note chat's switch is its own; configs from before it was are saved apart at launch.
describe('note chat', () => {
  it('is on by default', () => {
    expect(isNoteChatEnabled(baseConfig)).toBe(true);
  });

  it('ignores the voice assistant switch', () => {
    expect(isNoteChatEnabled({ ...baseConfig, dictationAgentEnabled: false })).toBe(true);
    expect(isNoteChatEnabled({ ...baseConfig, noteChatEnabled: false })).toBe(false);
  });

  it('counts as on until a config has loaded', () => {
    expect(isChatEnabled(null)).toBe(true);
    expect(isChatEnabled({ ...baseConfig, noteChatEnabled: false })).toBe(false);
  });
});
