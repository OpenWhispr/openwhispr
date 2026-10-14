import { workflowSummary } from '@/lib/aiWorkflows';
import type { UserConfig } from '@/types';

function config(overrides: Partial<UserConfig> = {}): UserConfig {
  return { defaultMode: 'private', ...overrides } as UserConfig;
}

describe('workflowSummary for Text Cleanup', () => {
  it.each([
    ['nothing saved', undefined],
    ['OpenWhispr Cloud', { mode: 'openwhispr' as const }],
  ])('is skipped in On-Device mode with %s saved', (_label, cleanup) => {
    const saved = config({ inference: cleanup ? { cleanup } : {} });
    expect(workflowSummary(saved, 'cleanup', 'private')).toBe('Skipped');
  });

  it('names the provider saved for cleanup in On-Device mode, which cleans there', () => {
    const saved = config({
      inference: { cleanup: { mode: 'providers', providerId: 'openai', modelId: 'gpt-5-mini' } },
    });
    expect(workflowSummary(saved, 'cleanup', 'private')).toBe('OpenAI');
    expect(workflowSummary(saved, 'cleanup', 'private', { keyMissing: true })).toBe(
      'OpenAI · Key missing',
    );
  });

  it('runs On-Device in On-Device mode when saved as On-Device', () => {
    const saved = config({ inference: { cleanup: { mode: 'local' } } });
    expect(workflowSummary(saved, 'cleanup', 'private')).toBe('On-Device');
  });

  it.each(['private', 'cloud'] as const)(
    'says why saved On-Device cleanup cannot run in %s mode',
    (mode) => {
      const saved = config({ defaultMode: mode, inference: { cleanup: { mode: 'local' } } });
      expect(
        workflowSummary(saved, 'cleanup', mode, { onDeviceUnavailable: 'Apple Intelligence off' }),
      ).toBe('On-Device · Apple Intelligence off');
    },
  );

  it('ignores On-Device availability for a cleanup that does not run on the phone', () => {
    const saved = config({ defaultMode: 'cloud', inference: { cleanup: { mode: 'openwhispr' } } });
    expect(
      workflowSummary(saved, 'cleanup', 'cloud', { onDeviceUnavailable: 'Apple Intelligence off' }),
    ).toBe('OpenWhispr Cloud');
  });

  it.each(['private', 'cloud', 'providers'] as const)(
    'is off in %s mode when Text Cleanup is turned off',
    (mode) => {
      const saved = config({
        defaultMode: mode,
        cleanupEnabled: false,
        inference: { cleanup: { mode: 'local' } },
      });
      expect(
        workflowSummary(saved, 'cleanup', mode, { onDeviceUnavailable: 'Apple Intelligence off' }),
      ).toBe('Off');
    },
  );

  it('still flags a provider cleanup whose key is missing', () => {
    const saved = config({
      defaultMode: 'providers',
      inference: { cleanup: { mode: 'providers', providerId: 'groq', modelId: 'llama' } },
    });
    expect(workflowSummary(saved, 'cleanup', 'providers', { keyMissing: true })).toBe(
      'Groq · Key missing',
    );
  });
});
