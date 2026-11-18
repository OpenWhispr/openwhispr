import { deriveLocalTitle, generateNoteTitle } from '../generateTitle';
import { generateNoteTitle as generateAndroidNoteTitle } from '../generateTitle.android';
import { ReasoningService } from '@/services/reasoning/ReasoningService';

jest.mock('@/services/reasoning/ReasoningService', () => ({
  ReasoningService: {
    processText: jest.fn(async () => ({ text: 'Fixture title', model: 'fixture' })),
  },
}));

describe('deriveLocalTitle', () => {
  it('takes the first words of the transcript', () => {
    expect(
      deriveLocalTitle('Discuss launch risks and onboarding next steps for the team today'),
    ).toBe('Discuss launch risks and onboarding next steps for');
  });

  it('strips trailing punctuation', () => {
    expect(deriveLocalTitle('Discuss launch risks.')).toBe('Discuss launch risks');
  });

  it('returns an empty string for blank input', () => {
    expect(deriveLocalTitle('   ')).toBe('');
  });

  it('caps overly long titles at the character limit', () => {
    const longWord = 'a'.repeat(150);
    expect(deriveLocalTitle(longWord).length).toBeLessThanOrEqual(100);
  });
});

describe('title request platform contract', () => {
  beforeEach(() => jest.clearAllMocks());
  it.each([undefined, new AbortController().signal])(
    'omits the Android signal field from the default title request (%#)',
    async (signal) => {
      const callDefault: (
        text: string,
        routing?: Parameters<typeof generateNoteTitle>[1],
        signal?: AbortSignal,
      ) => Promise<string> = generateNoteTitle;
      await callDefault('Note', { isPrivateNote: true }, signal);
      const request = jest.mocked(ReasoningService.processText).mock.calls[0][0];
      expect(Object.keys(request)).not.toContain('signal');
    },
  );
  it.each([undefined, new AbortController().signal])(
    'retains the Android title signal field (%#)',
    async (signal) => {
      await generateAndroidNoteTitle('Note', { isPrivateNote: true }, signal);
      const request = jest.mocked(ReasoningService.processText).mock.calls[0][0];
      expect(Object.keys(request)).toContain('signal');
      expect(request.signal).toBe(signal);
    },
  );
});
