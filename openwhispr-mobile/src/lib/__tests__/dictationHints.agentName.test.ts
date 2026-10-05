/**
 * Tests for agent name inclusion in STT hint words.
 * - agent name included when applicable (cloud + enabled)
 * - agent name excluded when disabled
 * - agent name excluded when mode is private
 * - agent name not duplicated when already present in dictionary
 */
import { buildDictationHints } from '@/lib/dictationHints';

jest.mock('@/store/useSnippetsStore', () => ({
  useSnippetsStore: { getState: () => ({ isLoaded: true, entries: [] }) },
}));

// Mutable refs so each test controls config and dict independently.
let mockDictEntries: { word: string }[] = [];
let mockConfig: Record<string, unknown> = { defaultMode: 'cloud' };
let mockActiveMode = 'cloud';

jest.mock('@/store/useDictionaryStore', () => ({
  useDictionaryStore: { getState: () => ({ isLoaded: true, entries: mockDictEntries }) },
}));

jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: mockConfig }) },
}));

jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: mockActiveMode }) },
}));

beforeEach(() => {
  mockDictEntries = [];
  mockConfig = { defaultMode: 'cloud' };
  mockActiveMode = 'cloud';
});

describe('buildDictationHints agentName', () => {
  it('includes the agent name when agent is enabled and mode is cloud', () => {
    mockActiveMode = 'cloud';
    mockConfig = { defaultMode: 'cloud', dictationAgentEnabled: true, dictationAgentName: 'Aria' };

    const hints = buildDictationHints(false);
    expect(hints).toContain('Aria');
  });

  it('includes the default agent name when dictationAgentName is unset', () => {
    mockActiveMode = 'cloud';
    mockConfig = { defaultMode: 'cloud', dictationAgentEnabled: true };

    const hints = buildDictationHints(false);
    expect(hints).toContain('OpenWhispr');
  });

  it('excludes the agent name when agent is disabled', () => {
    mockActiveMode = 'cloud';
    mockConfig = { defaultMode: 'cloud', dictationAgentEnabled: false, dictationAgentName: 'Aria' };

    const hints = buildDictationHints(false);
    expect(hints).not.toContain('Aria');
  });

  it('excludes the agent name when mode is private', () => {
    mockActiveMode = 'private';
    mockConfig = {
      defaultMode: 'private',
      dictationAgentEnabled: true,
      dictationAgentName: 'Aria',
    };

    const hints = buildDictationHints(false);
    expect(hints).not.toContain('Aria');
  });

  it('does not duplicate the agent name when it is already in the custom dictionary', () => {
    mockActiveMode = 'cloud';
    mockConfig = { defaultMode: 'cloud', dictationAgentEnabled: true, dictationAgentName: 'Aria' };
    mockDictEntries = [{ word: 'Aria' }];

    const hints = buildDictationHints(false);
    const count = hints.filter((h) => h === 'Aria').length;
    expect(count).toBe(1);
  });

  it('does not affect existing dictionary words when agent is disabled', () => {
    mockActiveMode = 'cloud';
    mockConfig = { defaultMode: 'cloud', dictationAgentEnabled: false };
    mockDictEntries = [{ word: 'Kubernetes' }, { word: 'TypeScript' }];

    const hints = buildDictationHints(false);
    expect(hints).toContain('Kubernetes');
    expect(hints).toContain('TypeScript');
  });
});
