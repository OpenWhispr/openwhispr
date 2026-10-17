jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import { Platform } from 'react-native';
import {
  dictationModeConfig,
  getInferenceModes,
  localModeDefault,
  localModeUpgradeConfig,
  workflowSaveConfig,
} from '../inferenceModes';
import type { UserConfig } from '@/types';

const groqCleanup = {
  mode: 'providers' as const,
  providerId: 'groq',
  modelId: 'llama-3.3-70b-versatile',
  credentialRef: 'provider.groq',
};
const groqDictation = {
  mode: 'providers' as const,
  providerId: 'groq',
  modelId: 'whisper-large-v3-turbo',
  credentialRef: 'provider.groq',
};

it('releases only the automatic pins when dictation leaves Bring Your Own Key', () => {
  const pinned: UserConfig = {
    defaultMode: 'providers',
    inference: {
      dictation: groqDictation,
      upload: { mode: 'local' },
      notes: { mode: 'local' },
      cleanup: { mode: 'local' },
    },
    pinnedInference: ['upload', 'notes'],
  };
  const next = dictationModeConfig(pinned, 'cloud');
  expect(next.inference).toEqual({ dictation: { mode: 'openwhispr' }, cleanup: { mode: 'local' } });
  expect(next.pinnedInference).toBeUndefined();
});

// Local Mode cleans On-Device whatever is saved for cleanup other than a provider, so switching
// keeps the user's cleanup choice for when Local Mode is off again.
it.each([
  ['On-Device', { mode: 'local' as const }],
  ['OpenWhispr Cloud', { mode: 'openwhispr' as const }],
  ['provider', groqCleanup],
])('keeps a saved %s cleanup when switching modes', (_label, cleanup) => {
  for (const mode of ['cloud', 'private'] as const) {
    const saved: UserConfig = {
      defaultMode: mode === 'cloud' ? 'private' : 'cloud',
      inference: { cleanup },
    };
    expect(dictationModeConfig(saved, mode).inference?.cleanup).toEqual(cleanup);
  }
});

// Picking another on-device model, or replaying Local Mode in onboarding, is not a mode change.
it('keeps the automatic pins when dictation is saved to the mode it is already in', () => {
  const held: UserConfig = {
    defaultMode: 'private',
    inference: { dictation: { mode: 'local' }, upload: { mode: 'local' } },
    pinnedInference: ['upload'],
  };
  const next = dictationModeConfig(held, 'private');
  expect(next.inference?.upload).toEqual({ mode: 'local' });
  expect(next).not.toHaveProperty('pinnedInference');
});

it('keeps an explicit On-Device upload choice when dictation leaves Bring Your Own Key', () => {
  const explicit: UserConfig = {
    defaultMode: 'providers',
    inference: { dictation: groqDictation, upload: { mode: 'local' } },
  };
  expect(dictationModeConfig(explicit, 'cloud').inference?.upload).toEqual({ mode: 'local' });
});

it('keeps an explicit upload choice when toggling between Cloud and On-Device', () => {
  const explicit = {
    defaultMode: 'cloud' as const,
    inference: { upload: { mode: 'local' as const } },
  };
  expect(dictationModeConfig(explicit, 'private').inference?.upload).toEqual({ mode: 'local' });
});

it('keeps the dictation selection in step with Local Mode', () => {
  const config = {
    defaultMode: 'private' as const,
    inference: {
      dictation: { mode: 'local' as const },
      upload: { mode: 'providers' as const, providerId: 'groq' },
    },
  };
  expect(dictationModeConfig(config, 'cloud')).toEqual({
    defaultMode: 'cloud',
    inference: { dictation: { mode: 'openwhispr' }, upload: config.inference.upload },
  });
  expect(dictationModeConfig(null, 'private')).toEqual({
    defaultMode: 'private',
    inference: { dictation: { mode: 'local' } },
  });
});

describe('workflowSaveConfig', () => {
  it('keeps unsaved workflows on this phone when dictation moves from On-Device to a provider', () => {
    const config: UserConfig = {
      defaultMode: 'private',
      inference: { dictation: { mode: 'local' } },
    };
    const next = workflowSaveConfig(config, 'dictation', groqDictation, 'private');
    expect(next.defaultMode).toBe('providers');
    expect(next.inference).toEqual({
      dictation: groqDictation,
      upload: { mode: 'local' },
      notes: { mode: 'local' },
      agent: { mode: 'local' },
    });
    expect(next.pinnedInference).toEqual(['upload', 'notes', 'agent']);
  });

  it('keeps uploads and notes on Cloud when dictation moves from Cloud to a provider', () => {
    const next = workflowSaveConfig({ defaultMode: 'cloud' }, 'dictation', groqDictation, 'cloud');
    expect(next.inference).toMatchObject({
      upload: { mode: 'openwhispr' },
      notes: { mode: 'openwhispr' },
    });
    expect(next.pinnedInference).toEqual(['upload', 'notes']);
  });

  it('leaves the voice assistant unset when leaving Cloud, so it is skipped, not sent to Cloud', () => {
    const next = workflowSaveConfig({ defaultMode: 'cloud' }, 'dictation', groqDictation, 'cloud');
    expect(next.inference?.agent).toBeUndefined();
  });

  it('never pins cleanup or a workflow the user already chose', () => {
    const config: UserConfig = {
      defaultMode: 'private',
      inference: { notes: { mode: 'openwhispr' } },
    };
    const next = workflowSaveConfig(config, 'dictation', groqDictation, 'private');
    expect(next.inference?.cleanup).toBeUndefined();
    expect(next.inference?.notes).toEqual({ mode: 'openwhispr' });
    expect(next.pinnedInference).toEqual(['upload', 'agent']);
  });

  it('adds no pins when a Bring Your Own Key user re-saves dictation', () => {
    const config: UserConfig = {
      defaultMode: 'providers',
      inference: { dictation: groqDictation, upload: { mode: 'local' } },
      pinnedInference: ['upload'],
    };
    const next = workflowSaveConfig(
      config,
      'dictation',
      { ...groqDictation, providerId: 'openai', modelId: 'whisper-1' },
      'providers',
    );
    expect(next.inference?.notes).toBeUndefined();
    expect(next.inference?.agent).toBeUndefined();
    expect(next.pinnedInference).toEqual(['upload']);
  });

  it('makes a pinned workflow explicit once the user saves it', () => {
    const config: UserConfig = {
      defaultMode: 'providers',
      inference: { dictation: groqDictation, upload: { mode: 'local' } },
      pinnedInference: ['upload', 'notes'],
    };
    const next = workflowSaveConfig(config, 'upload', { mode: 'local' }, 'providers');
    expect(next.pinnedInference).toEqual(['notes']);
    expect(next.defaultMode).toBeUndefined();
    expect(dictationModeConfig({ ...config, ...next }, 'cloud').inference?.upload).toEqual({
      mode: 'local',
    });
  });

  it('remembers the provider saved last so switching back restores it', () => {
    const config: UserConfig = {
      defaultMode: 'cloud',
      rememberedInference: {
        cleanup: {
          groq: { mode: 'providers', providerId: 'groq', modelId: 'old-model' },
          openai: { mode: 'providers', providerId: 'openai', modelId: 'gpt-4o-mini' },
        },
      },
    };
    const openai = { mode: 'providers' as const, providerId: 'openai', modelId: 'gpt-4.1' };
    const next = workflowSaveConfig(config, 'cleanup', openai, 'cloud');
    expect(Object.keys(next.rememberedInference?.cleanup ?? {})).toEqual(['openai', 'groq']);
    expect(next.rememberedInference?.cleanup?.openai).toEqual(openai);
  });

  it('switches dictation back to Cloud and releases the pins', () => {
    const config: UserConfig = {
      defaultMode: 'providers',
      inference: { dictation: groqDictation, upload: { mode: 'local' } },
      pinnedInference: ['upload'],
    };
    const next = workflowSaveConfig(config, 'dictation', { mode: 'openwhispr' }, 'providers');
    expect(next).toEqual({
      defaultMode: 'cloud',
      inference: { dictation: { mode: 'openwhispr' } },
    });
  });

  describe('where Local Mode returns to', () => {
    const fromProviders: UserConfig = {
      defaultMode: 'private',
      privateModeReturn: { pinned: { upload: { mode: 'openwhispr' } } },
      inference: { dictation: { mode: 'local' } },
    };

    it('is Bring Your Own Key, with what it held, when Local Mode is turned on from it', () => {
      const config: UserConfig = {
        defaultMode: 'providers',
        inference: {
          dictation: groqDictation,
          upload: { mode: 'openwhispr' },
          notes: { mode: 'local' },
        },
        pinnedInference: ['upload'],
      };
      const next = workflowSaveConfig(config, 'dictation', { mode: 'local' }, 'providers');
      // Notes is the user's own choice, so only the held upload is recorded.
      expect(next.privateModeReturn).toEqual({ pinned: { upload: { mode: 'openwhispr' } } });
      expect(next.inference).toEqual({ dictation: { mode: 'local' }, notes: { mode: 'local' } });
    });

    it.each([
      ['On-Device', { mode: 'local' as const }],
      ['OpenWhispr Cloud', { mode: 'openwhispr' as const }],
    ])(
      'keeps a %s cleanup when Local Mode is turned on from Bring Your Own Key and off again',
      (_label, cleanup) => {
        const providers: UserConfig = {
          defaultMode: 'providers',
          inference: { dictation: groqDictation, cleanup },
          rememberedInference: { dictation: { groq: groqDictation } },
        };
        const on = {
          ...providers,
          ...workflowSaveConfig(providers, 'dictation', { mode: 'local' }, 'providers'),
        };
        const off = { ...on, ...workflowSaveConfig(on, 'dictation', groqDictation, 'private') };
        expect(off.defaultMode).toBe('providers');
        expect(off.inference?.cleanup).toEqual(cleanup);
      },
    );

    it('is not set when Local Mode is turned on from Cloud', () => {
      const config: UserConfig = { defaultMode: 'cloud' };
      expect(
        workflowSaveConfig(config, 'dictation', { mode: 'local' }, 'cloud'),
      ).not.toHaveProperty('privateModeReturn');
    });

    it('survives picking another on-device model', () => {
      const next = workflowSaveConfig(
        fromProviders,
        'dictation',
        { mode: 'local', modelId: 'whisper-base' },
        'private',
      );
      expect(next.privateModeReturn).toEqual(fromProviders.privateModeReturn);
    });

    it.each([
      ['Cloud', { mode: 'openwhispr' as const }],
      ['Bring Your Own Key', groqDictation],
    ])('is cleared when dictation leaves Local Mode for %s', (_label, selection) => {
      const next = workflowSaveConfig(fromProviders, 'dictation', selection, 'private');
      expect(next).toHaveProperty('privateModeReturn', undefined);
    });

    it('holds what Bring Your Own Key held when dictation goes back to it', () => {
      const next = workflowSaveConfig(fromProviders, 'dictation', groqDictation, 'private');
      expect(next.inference).toEqual({ dictation: groqDictation, upload: { mode: 'openwhispr' } });
      expect(next.pinnedInference).toEqual(['upload']);
    });

    it('keeps a choice made in Local Mode over what Bring Your Own Key held', () => {
      const config: UserConfig = {
        ...fromProviders,
        inference: {
          dictation: { mode: 'local' },
          upload: { mode: 'local', modelId: 'whisper-base' },
        },
      };
      const next = workflowSaveConfig(config, 'dictation', groqDictation, 'private');
      expect(next.inference?.upload).toEqual({ mode: 'local', modelId: 'whisper-base' });
      expect(next).not.toHaveProperty('pinnedInference');
    });

    // Local Mode uploaded to OpenWhispr Cloud with nothing saved and a session, so that is held.
    it.each([
      ['session', 'openwhispr'],
      ['account', 'openwhispr'],
      ['none', 'local'],
    ] as const)('holds uploads where Local Mode ran them with %s access', (cloudAccess, mode) => {
      const config: UserConfig = {
        defaultMode: 'private',
        inference: { dictation: { mode: 'local' } },
      };
      const next = workflowSaveConfig(config, 'dictation', groqDictation, 'private', cloudAccess);
      expect(next.inference?.upload).toEqual({ mode });
      expect(next.inference?.notes).toEqual({ mode: 'local' });
    });

    it('holds what Bring Your Own Key held over a workflow Local Mode held automatically', () => {
      const config: UserConfig = {
        ...fromProviders,
        inference: { dictation: { mode: 'local' }, upload: { mode: 'local' } },
        pinnedInference: ['upload'],
      };
      const next = workflowSaveConfig(config, 'dictation', groqDictation, 'private');
      expect(next.inference?.upload).toEqual({ mode: 'openwhispr' });
      expect(next.pinnedInference).toEqual(['upload']);
    });

    it('holds workflows on this phone when Local Mode was not turned on from it', () => {
      const config: UserConfig = {
        defaultMode: 'private',
        inference: { dictation: { mode: 'local' } },
      };
      const next = workflowSaveConfig(config, 'dictation', groqDictation, 'private');
      expect(next.pinnedInference).toEqual(['upload', 'notes', 'agent']);
    });

    // Replaying onboarding writes the mode directly, and must not leave a stale return behind.
    it.each(['cloud', 'private'] as const)('is cleared by choosing %s outright', (mode) => {
      expect(dictationModeConfig(fromProviders, mode)).toHaveProperty(
        'privateModeReturn',
        undefined,
      );
    });
  });
});

// Before Local Mode's Cloud defaults, it kept uploads and cleanup on this phone and ignored a Cloud
// choice saved for them.
describe('localModeUpgradeConfig', () => {
  it('holds uploads and cleanup on this phone for a config in Local Mode', () => {
    const config: UserConfig = {
      defaultMode: 'private',
      inference: { dictation: { mode: 'local' }, cleanup: { mode: 'openwhispr' } },
      rememberedInference: { upload: { local: { mode: 'local', modelId: 'whisper-base' } } },
    };
    expect(localModeUpgradeConfig(config)).toEqual({
      localModeUpgraded: true,
      inference: {
        dictation: { mode: 'local' },
        upload: { mode: 'local', modelId: 'whisper-base' },
        cleanup: { mode: 'local' },
      },
      pinnedInference: ['upload', 'cleanup'],
    });
  });

  it('keeps an On-Device or provider choice the user saved', () => {
    const config: UserConfig = {
      defaultMode: 'private',
      inference: { upload: { mode: 'local', modelId: 'whisper-base' }, cleanup: groqCleanup },
    };
    expect(localModeUpgradeConfig(config)).toEqual({
      localModeUpgraded: true,
      inference: config.inference,
      pinnedInference: [],
    });
  });

  it.each(['cloud', 'providers'] as const)('only marks a config in %s mode', (defaultMode) => {
    expect(localModeUpgradeConfig({ defaultMode })).toEqual({ localModeUpgraded: true });
  });

  it('is released when dictation leaves Local Mode, so Cloud runs them again', () => {
    const config: UserConfig = {
      defaultMode: 'private',
      inference: { dictation: { mode: 'local' } },
    };
    const upgraded = { ...config, ...localModeUpgradeConfig(config) };
    const next = dictationModeConfig(upgraded, 'cloud');
    expect(next.inference).toEqual({ dictation: { mode: 'openwhispr' } });
    expect(next.pinnedInference).toBeUndefined();
  });
});

describe('getInferenceModes', () => {
  afterEach(() => {
    Platform.OS = 'ios';
  });

  it('offers Bring Your Own Key on iOS', () => {
    expect(getInferenceModes('text').map((mode) => mode.mode)).toContain('providers');
  });

  it('offers Bring Your Own Key on Android with its native transport', () => {
    Platform.OS = 'android';
    expect(getInferenceModes('speech').map((mode) => mode.mode)).toEqual([
      'openwhispr',
      'local',
      'providers',
    ]);
  });
});

it('switches dictation back to On-Device with the model the user picked', () => {
  const config = {
    defaultMode: 'cloud' as const,
    inference: { dictation: { mode: 'openwhispr' as const } },
    rememberedInference: {
      dictation: { local: { mode: 'local' as const, modelId: 'parakeet-v3' } },
    },
  };
  expect(dictationModeConfig(config, 'private').inference?.dictation).toEqual({
    mode: 'local',
    modelId: 'parakeet-v3',
  });
});

describe('Android retains local workflow defaults', () => {
  const originalOS = Platform.OS;
  beforeEach(() => {
    Platform.OS = 'android';
  });
  afterEach(() => {
    Platform.OS = originalOS;
  });
  it.each(['none', 'session', 'account'] as const)(
    'keeps uploads and cleanup on device with %s access',
    (access) => {
      expect(localModeDefault('upload', access)).toBe('local');
      expect(localModeDefault('cleanup', access)).toBe('local');
    },
  );
  it('does not migrate Android settings to the new iOS cleanup defaults', () => {
    expect(
      localModeUpgradeConfig({
        defaultMode: 'private',
        inference: { cleanup: { mode: 'openwhispr' } },
      }),
    ).toEqual({ localModeUpgraded: true });
  });
});
