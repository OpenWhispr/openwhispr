import {
  getDictationAgentName,
  isDictationAgentApplicable,
  detectAgentMention,
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

describe('detectAgentMention — Layer 1: word-boundary exact match', () => {
  it('detects the name at word boundaries', () => {
    expect(detectAgentMention('Hey OpenWhispr write a follow-up email', 'OpenWhispr')).toBe(true);
  });

  it('detects the name case-insensitively', () => {
    expect(detectAgentMention('hey openwhispr do this', 'OpenWhispr')).toBe(true);
    expect(detectAgentMention('hey OPENWHISPR do this', 'OpenWhispr')).toBe(true);
  });

  it('does not match when name appears only as a substring of another word', () => {
    expect(detectAgentMention('this is OpenWhisprPro not the agent', 'OpenWhispr')).toBe(false);
  });

  it('does not match when transcript does not contain the name', () => {
    expect(detectAgentMention('write a follow-up email for the client', 'OpenWhispr')).toBe(false);
  });

  it('detects name with punctuation adjacent (word boundary)', () => {
    expect(detectAgentMention('okay, OpenWhispr, please help', 'OpenWhispr')).toBe(true);
  });
});

describe('detectAgentMention — Layer 2: space-normalized join', () => {
  it('detects compound name spoken with a space', () => {
    // STT splits "OpenWhispr" into "Open Whispr"
    expect(detectAgentMention('hey Open Whispr write this', 'OpenWhispr')).toBe(true);
  });

  it('is case-insensitive on space-normalized match', () => {
    expect(detectAgentMention('hey open whispr write this', 'OpenWhispr')).toBe(true);
  });

  it('matches a two-word configured name', () => {
    // Name is "My Agent", transcript says "My Agent" (exact)
    expect(detectAgentMention('hey my agent do the thing', 'My Agent')).toBe(true);
  });
});

describe('detectAgentMention — Layer 3: Levenshtein fuzzy match', () => {
  it('returns false for names of 4 chars or fewer (zero edits allowed)', () => {
    expect(detectAgentMention('hey Arua write this', 'Aria')).toBe(false);
  });

  it('tolerates 1 edit for a 5–6 char name', () => {
    expect(detectAgentMention('hey Jarwis write this', 'Jarvis')).toBe(true);
  });

  it('tolerates 2 edits for names longer than 6 chars', () => {
    // "openwhizer" is 2 edits from "openwhispr" (len 10)
    expect(detectAgentMention('hey openwhizer write this', 'OpenWhispr')).toBe(true);
  });

  it('does not match when edits exceed the threshold', () => {
    expect(detectAgentMention('hey openwhizzler write this', 'OpenWhispr')).toBe(false);
  });

  it('tolerates 1 edit on a combined two-word mishearing', () => {
    // "open whisper" combined → "openwhisper" is 1 edit from "openwhispr"
    expect(detectAgentMention('okay open whisper please help', 'OpenWhispr')).toBe(true);
  });
});

describe('detectAgentMention — edge cases', () => {
  it('returns false for empty transcript', () => {
    expect(detectAgentMention('', 'OpenWhispr')).toBe(false);
  });

  it('returns false when name is too short (< 2 chars)', () => {
    expect(detectAgentMention('hey A do this', 'A')).toBe(false);
  });

  it('returns false when name is blank/empty', () => {
    expect(detectAgentMention('hey do this', '')).toBe(false);
  });
});
