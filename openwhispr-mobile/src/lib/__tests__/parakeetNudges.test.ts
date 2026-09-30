import { getParakeetNudge, type ParakeetNudgeInput } from '../parakeetNudges';
import type { LocalEngineAvailability } from '@/services/transcription/localEngine';

const availability = (
  overrides: Partial<LocalEngineAvailability> = {},
): LocalEngineAvailability => ({
  parakeetSupported: true,
  parakeetV2Downloaded: false,
  parakeetV3Downloaded: false,
  whisperDownloaded: true,
  ...overrides,
});

const input = (overrides: Partial<ParakeetNudgeInput> = {}): ParakeetNudgeInput => ({
  activeMode: 'private',
  languages: [],
  deviceLanguages: ['en'],
  availability: availability(),
  config: {},
  ...overrides,
});

describe('getParakeetNudge', () => {
  it('never fires outside private mode or without the native module', () => {
    expect(getParakeetNudge(input({ activeMode: 'cloud' }))).toBeNull();
    expect(
      getParakeetNudge(input({ availability: availability({ parakeetSupported: false }) })),
    ).toBeNull();
  });

  it("suggests picking a language for 'auto' users, personalized from device languages", () => {
    expect(getParakeetNudge(input({ deviceLanguages: ['en'] }))).toEqual({
      kind: 'pick-language',
      suggestedLanguageCode: 'en',
    });
  });

  it('falls back to generic pick-language copy when device languages are not Parakeet-eligible', () => {
    expect(getParakeetNudge(input({ deviceLanguages: ['en', 'he'] }))).toEqual({
      kind: 'pick-language',
    });
  });

  it('suggests the faster model for a qualifying selection without the model installed', () => {
    expect(getParakeetNudge(input({ languages: ['en'] }))).toEqual({
      kind: 'faster-model',
      suggestedLanguageCode: 'en',
    });
    expect(getParakeetNudge(input({ languages: ['de'] }))).toEqual({
      kind: 'faster-model',
      suggestedLanguageCode: 'de',
    });
  });

  it('stays silent once the routed Parakeet model is installed', () => {
    expect(
      getParakeetNudge(
        input({
          languages: ['en'],
          availability: availability({ parakeetV2Downloaded: true }),
        }),
      ),
    ).toBeNull();
  });

  it('honors each dismissal flag independently', () => {
    expect(
      getParakeetNudge(input({ config: { parakeetAutoLanguageNudgeDismissedAt: '2026-01-01' } })),
    ).toBeNull();
    expect(
      getParakeetNudge(
        input({
          languages: ['en'],
          config: { parakeetUpgradeNudgeDismissedAt: '2026-01-01' },
        }),
      ),
    ).toBeNull();
    // The auto-language dismissal does not silence the faster-model nudge.
    expect(
      getParakeetNudge(
        input({
          languages: ['en'],
          config: { parakeetAutoLanguageNudgeDismissedAt: '2026-01-01' },
        }),
      ),
    ).toEqual({ kind: 'faster-model', suggestedLanguageCode: 'en' });
  });

  it('treats a mixed selection (en+he) as whisper-bound → pick-language nudge', () => {
    expect(
      getParakeetNudge(input({ languages: ['en', 'he'], deviceLanguages: ['en', 'he'] })),
    ).toEqual({ kind: 'pick-language' });
  });
});
