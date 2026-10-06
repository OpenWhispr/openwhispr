const mockConfigState: {
  config: { preferredLanguage?: string; languages?: string[] } | null;
} = { config: null };

jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => mockConfigState },
}));

import {
  getPreferredTranscriptionLanguage,
  getPreferredTranscriptionLanguages,
} from '../transcriptionLanguage';

describe('getPreferredTranscriptionLanguages', () => {
  beforeEach(() => {
    mockConfigState.config = null;
  });

  it('returns [] when no config or nothing selected', () => {
    expect(getPreferredTranscriptionLanguages()).toEqual([]);
    mockConfigState.config = {};
    expect(getPreferredTranscriptionLanguages()).toEqual([]);
  });

  it('prefers the Settings pick (preferredLanguage) over the onboarding list', () => {
    mockConfigState.config = { preferredLanguage: 'de', languages: ['en-US', 'he'] };
    expect(getPreferredTranscriptionLanguages()).toEqual(['de']);
  });

  it('treats an explicit Settings "auto" as auto-detect, not the onboarding list', () => {
    mockConfigState.config = { preferredLanguage: 'auto', languages: ['en-US', 'he'] };
    expect(getPreferredTranscriptionLanguages()).toEqual([]);
  });

  it('falls back to the onboarding list, stripping regions and deduping', () => {
    mockConfigState.config = { languages: ['en-US', 'en-GB', 'he'] };
    expect(getPreferredTranscriptionLanguages()).toEqual(['en', 'he']);
  });

  it('strips the region from a Settings pick', () => {
    mockConfigState.config = { preferredLanguage: 'en-GB' };
    expect(getPreferredTranscriptionLanguages()).toEqual(['en']);
  });
});

describe('getPreferredTranscriptionLanguage (singular hint)', () => {
  beforeEach(() => {
    mockConfigState.config = null;
  });

  it('returns the code only for exactly one selected language', () => {
    mockConfigState.config = { languages: ['de'] };
    expect(getPreferredTranscriptionLanguage()).toBe('de');
  });

  it('returns undefined for zero or multiple selections', () => {
    expect(getPreferredTranscriptionLanguage()).toBeUndefined();
    mockConfigState.config = { languages: ['en-US', 'he'] };
    expect(getPreferredTranscriptionLanguage()).toBeUndefined();
  });

  it('now honors the Settings pick (the pre-existing split-brain bug)', () => {
    mockConfigState.config = { preferredLanguage: 'fr', languages: ['en-US', 'he'] };
    expect(getPreferredTranscriptionLanguage()).toBe('fr');
  });
});
