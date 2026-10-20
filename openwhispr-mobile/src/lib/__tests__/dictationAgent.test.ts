import {
  getDictationAgentName,
  isDictationAgentApplicable,
  isNoteChatEnabled,
} from '@/lib/dictationAgent';
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

describe('isDictationAgentApplicable', () => {
  it('returns true when cloud mode and agent enabled', () => {
    expect(
      isDictationAgentApplicable('cloud', { ...baseConfig, dictationAgentEnabled: true }),
    ).toBe(true);
  });

  it('returns false when cloud mode but agent disabled', () => {
    expect(
      isDictationAgentApplicable('cloud', { ...baseConfig, dictationAgentEnabled: false }),
    ).toBe(false);
  });

  it('returns true when cloud mode and agent not set (default on)', () => {
    expect(isDictationAgentApplicable('cloud', baseConfig)).toBe(true);
  });

  it('returns false when cloud mode but agent explicitly disabled', () => {
    expect(
      isDictationAgentApplicable('cloud', { ...baseConfig, dictationAgentEnabled: false }),
    ).toBe(false);
  });

  it('returns false when private mode even if agent enabled', () => {
    expect(
      isDictationAgentApplicable('private', { ...baseConfig, dictationAgentEnabled: true }),
    ).toBe(false);
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
});

it('supports Providers mode', () => {
  expect(isDictationAgentApplicable('providers', { defaultMode: 'providers' })).toBe(true);
});
