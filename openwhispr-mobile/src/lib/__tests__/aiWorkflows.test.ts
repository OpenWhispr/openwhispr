import { workflowSummary } from '@/lib/aiWorkflows';
import type { UserConfig } from '@/types';

function config(overrides: Partial<UserConfig> = {}): UserConfig {
  return { defaultMode: 'private', ...overrides } as UserConfig;
}

describe('workflowSummary for Text Cleanup', () => {
  // With nothing saved, Local Mode cleans on OpenWhispr Cloud for a signed-in account and on this
  // phone otherwise, since a separate Cloud pass needs a real account.
  it.each([
    ['account', 'OpenWhispr Cloud'],
    ['session', 'On-Device'],
    ['none', 'On-Device'],
  ] as const)('with nothing saved in Local Mode and %s access, runs %s', (cloudAccess, label) => {
    expect(workflowSummary(config({}), 'cleanup', 'private', { cloudAccess })).toBe(label);
  });

  it('runs a saved OpenWhispr Cloud cleanup in Local Mode for a signed-in account', () => {
    const saved = config({ inference: { cleanup: { mode: 'openwhispr' } } });
    expect(workflowSummary(saved, 'cleanup', 'private', { cloudAccess: 'account' })).toBe(
      'OpenWhispr Cloud',
    );
  });

  // Local Mode dictates on this phone, so Cloud cleanup is a separate pass that needs an account.
  it.each(['session', 'none'] as const)(
    'skips a saved OpenWhispr Cloud cleanup in Local Mode with %s access',
    (cloudAccess) => {
      const saved = config({ inference: { cleanup: { mode: 'openwhispr' } } });
      expect(workflowSummary(saved, 'cleanup', 'private', { cloudAccess })).toBe(
        'Skipped · Sign in',
      );
      expect(
        workflowSummary({ ...saved, defaultMode: 'cloud' }, 'cleanup', 'cloud', { cloudAccess }),
      ).toBe('OpenWhispr Cloud');
    },
  );

  it('is skipped in Local Mode when Apple Intelligence cannot run', () => {
    expect(
      workflowSummary(config({}), 'cleanup', 'private', {
        onDeviceUnavailable: 'Not supported on this iPhone',
      }),
    ).toBe('Skipped · Not supported on this iPhone');
  });

  it('names a cleanup provider saved in Local Mode', () => {
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
    'says why saved On-Device cleanup is skipped in %s mode',
    (mode) => {
      const saved = config({ defaultMode: mode, inference: { cleanup: { mode: 'local' } } });
      expect(
        workflowSummary(saved, 'cleanup', mode, { onDeviceUnavailable: 'Apple Intelligence off' }),
      ).toBe('Skipped · Apple Intelligence off');
    },
  );

  it('ignores On-Device availability for a cleanup provider saved in Local Mode', () => {
    const saved = config({
      inference: { cleanup: { mode: 'providers', providerId: 'openai', modelId: 'gpt-5-mini' } },
    });
    expect(
      workflowSummary(saved, 'cleanup', 'private', {
        onDeviceUnavailable: 'Apple Intelligence off',
      }),
    ).toBe('OpenAI');
  });

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

describe('workflowSummary for Uploads', () => {
  // With nothing saved, Local Mode uploads to OpenWhispr Cloud whenever there is a session.
  it.each([
    ['account', 'OpenWhispr Cloud'],
    ['session', 'OpenWhispr Cloud'],
    ['none', 'On-Device'],
  ] as const)('with nothing saved in Local Mode and %s access, runs %s', (cloudAccess, label) => {
    expect(workflowSummary(config({}), 'upload', 'private', { cloudAccess })).toBe(label);
  });

  it('names an upload provider saved in Local Mode', () => {
    const saved = config({
      inference: { upload: { mode: 'providers', providerId: 'openai', modelId: 'whisper-1' } },
    });
    expect(workflowSummary(saved, 'upload', 'private')).toBe('OpenAI');
  });

  it('keeps dictation On-Device in Local Mode whatever is saved', () => {
    const saved = config({ inference: { dictation: { mode: 'openwhispr' } } });
    expect(workflowSummary(saved, 'dictation', 'private', { cloudAccess: 'account' })).toBe(
      'On-Device',
    );
  });
});
