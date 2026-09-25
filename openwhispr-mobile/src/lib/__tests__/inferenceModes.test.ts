jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import { Platform } from 'react-native';
import { dictationModeConfig, getInferenceModes, workflowSaveConfig } from '../inferenceModes';
import type { UserConfig } from '@/types';

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

it('keeps the dictation selection in step with the Cloud toggle', () => {
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
});

describe('getInferenceModes', () => {
  afterEach(() => {
    Platform.OS = 'ios';
  });

  it('offers Bring Your Own Key on iOS', () => {
    expect(getInferenceModes('text').map((mode) => mode.mode)).toContain('providers');
  });

  it('never offers Bring Your Own Key on Android', () => {
    Platform.OS = 'android';
    expect(getInferenceModes('speech').map((mode) => mode.mode)).toEqual(['openwhispr', 'local']);
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
