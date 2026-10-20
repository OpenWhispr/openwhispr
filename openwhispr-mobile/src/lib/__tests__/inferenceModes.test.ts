jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import { Platform } from 'react-native';
import {
  dictationModeConfig,
  getInferenceModes,
  holdOnDeviceConfig,
  localModeUpgradeConfig,
  noteChatSplitConfig,
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

it('releases only the automatic pins when onboarding picks another mode', () => {
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

// A Dictation change in AI Models may have held workflows in the mode onboarding picks again.
it('releases the automatic pins when onboarding replays the mode it is in', () => {
  const held: UserConfig = {
    defaultMode: 'cloud',
    inference: { dictation: { mode: 'openwhispr' }, upload: { mode: 'local' } },
    pinnedInference: ['upload'],
  };
  const next = dictationModeConfig(held, 'cloud');
  expect(next.inference).toEqual({ dictation: { mode: 'openwhispr' } });
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
  const local: UserConfig = { defaultMode: 'private', inference: { dictation: { mode: 'local' } } };
  const allSaved: UserConfig['inference'] = {
    upload: { mode: 'local' },
    cleanup: groqCleanup,
    notes: { mode: 'openwhispr' },
    noteChat: { mode: 'local' },
    agent: { mode: 'local' },
  };

  // Changing Dictation changes only dictation, from and to every mode.
  it.each([
    ['cloud', 'private', { mode: 'local' as const }],
    ['cloud', 'providers', groqDictation],
    ['private', 'cloud', { mode: 'openwhispr' as const }],
    ['private', 'providers', groqDictation],
    ['providers', 'cloud', { mode: 'openwhispr' as const }],
    ['providers', 'private', { mode: 'local' as const }],
  ] as const)(
    'leaves saved workflows alone when dictation moves from %s to %s',
    (from, to, dictation) => {
      const config: UserConfig = {
        defaultMode: from,
        inference: { dictation: { mode: 'openwhispr' }, ...allSaved },
        pinnedInference: ['upload', 'agent'],
      };
      const next = workflowSaveConfig(config, 'dictation', dictation, from, 'account');
      expect(next.defaultMode).toBe(to);
      expect(next.inference).toEqual({ ...allSaved, dictation });
      expect(next.pinnedInference).toEqual(['upload', 'agent']);
    },
  );

  it('holds unsaved workflows on Cloud when dictation leaves Cloud', () => {
    const next = workflowSaveConfig({ defaultMode: 'cloud' }, 'dictation', groqDictation, 'cloud');
    expect(next.inference).toEqual({
      dictation: groqDictation,
      upload: { mode: 'openwhispr' },
      cleanup: { mode: 'openwhispr' },
      notes: { mode: 'openwhispr' },
      noteChat: { mode: 'openwhispr' },
      agent: { mode: 'openwhispr' },
    });
    expect(next.pinnedInference).toEqual(['upload', 'cleanup', 'notes', 'noteChat', 'agent']);
  });

  // Unsaved cleanup and voice assistant were skipped under Bring Your Own Key, so there is nothing
  // to hold; uploads, notes and note chat ran on Cloud.
  it('holds only what ran when dictation leaves Bring Your Own Key', () => {
    const config: UserConfig = {
      defaultMode: 'providers',
      inference: { dictation: groqDictation },
    };
    const next = workflowSaveConfig(config, 'dictation', { mode: 'openwhispr' }, 'providers');
    expect(next).toEqual({
      defaultMode: 'cloud',
      inference: {
        dictation: { mode: 'openwhispr' },
        upload: { mode: 'openwhispr' },
        notes: { mode: 'openwhispr' },
        noteChat: { mode: 'openwhispr' },
      },
      pinnedInference: ['upload', 'notes', 'noteChat'],
    });
  });

  describe('leaving Local Mode', () => {
    it.each(['cloud', 'providers'] as const)(
      'holds what ran in Local Mode without a session when going to %s',
      (to) => {
        const dictation = to === 'cloud' ? { mode: 'openwhispr' as const } : groqDictation;
        const next = workflowSaveConfig(local, 'dictation', dictation, 'private', 'none');
        expect(next.inference).toEqual({
          dictation,
          upload: { mode: 'local' },
          cleanup: { mode: 'local' },
          notes: { mode: 'openwhispr' },
          noteChat: { mode: 'local' },
          agent: { mode: 'openwhispr' },
        });
        expect(next.pinnedInference).toEqual(['upload', 'cleanup', 'notes', 'noteChat', 'agent']);
      },
    );

    // Local Mode used OpenWhispr Cloud for uploads with a session, and for cleanup with an account.
    it.each([
      ['session', 'openwhispr', 'local'],
      ['account', 'openwhispr', 'openwhispr'],
    ] as const)(
      'holds uploads and cleanup where they ran with %s access',
      (access, upload, cleanup) => {
        const next = workflowSaveConfig(
          local,
          'dictation',
          { mode: 'openwhispr' },
          'private',
          access,
        );
        expect(next.inference?.upload).toEqual({ mode: upload });
        expect(next.inference?.cleanup).toEqual({ mode: cleanup });
      },
    );

    // Local Mode ran note formatting and the voice assistant on their own choices: Cloud unset.
    it('holds note formatting and the voice assistant on Cloud', () => {
      const next = workflowSaveConfig(local, 'dictation', { mode: 'openwhispr' }, 'private');
      expect(next.inference?.notes).toEqual({ mode: 'openwhispr' });
      expect(next.inference?.agent).toEqual({ mode: 'openwhispr' });
    });

    it('holds the on-device model picked for a workflow', () => {
      const whisper = { mode: 'local' as const, modelId: 'whisper-base' };
      const config: UserConfig = { ...local, rememberedInference: { upload: { local: whisper } } };
      const next = workflowSaveConfig(config, 'dictation', { mode: 'openwhispr' }, 'private');
      expect(next.inference?.upload).toEqual(whisper);
    });
  });

  it('turns Local Mode on with the model picked on the Dictation page', () => {
    const whisper = { mode: 'local' as const, modelId: 'whisper-base' };
    const config: UserConfig = {
      defaultMode: 'cloud',
      rememberedInference: { dictation: { local: whisper } },
    };
    const next = workflowSaveConfig(config, 'dictation', { mode: 'local' }, 'cloud');
    expect(next.inference?.dictation).toEqual(whisper);
  });

  it('holds nothing when dictation is saved to the mode it is already in', () => {
    const config: UserConfig = {
      defaultMode: 'providers',
      inference: { dictation: groqDictation, upload: { mode: 'local' } },
      pinnedInference: ['upload'],
    };
    const openai = { ...groqDictation, providerId: 'openai', modelId: 'whisper-1' };
    const next = workflowSaveConfig(config, 'dictation', openai, 'providers');
    expect(next.inference).toEqual({ dictation: openai, upload: { mode: 'local' } });
    expect(next).not.toHaveProperty('pinnedInference');
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

  // Bring Your Own Key skipped the voice assistant, so nothing was held for it; Local Mode then ran
  // it on Cloud, which leaving Local Mode holds.
  it('holds what Local Mode ran after a round trip from Bring Your Own Key', () => {
    const providers: UserConfig = {
      defaultMode: 'providers',
      inference: { dictation: groqDictation },
    };
    const on = {
      ...providers,
      ...workflowSaveConfig(providers, 'dictation', { mode: 'local' }, 'providers'),
    };
    const off = { ...on, ...workflowSaveConfig(on, 'dictation', groqDictation, 'private') };
    expect(off.defaultMode).toBe('providers');
    // Skipped cleanup has no selection to hold, so it keeps the on-device cleanup Local Mode ran.
    expect(off.inference).toEqual({
      dictation: groqDictation,
      upload: { mode: 'openwhispr' },
      cleanup: { mode: 'local' },
      notes: { mode: 'openwhispr' },
      noteChat: { mode: 'openwhispr' },
      agent: { mode: 'openwhispr' },
    });
  });

  // Local Mode cleaned on Cloud for an account, so that is what leaving it holds, even for a
  // cleanup Bring Your Own Key skipped before Local Mode was turned on.
  it('holds cleanup on Cloud when an account leaves Local Mode for Bring Your Own Key', () => {
    const providers: UserConfig = {
      defaultMode: 'providers',
      inference: { dictation: groqDictation },
    };
    const on = {
      ...providers,
      ...workflowSaveConfig(providers, 'dictation', { mode: 'local' }, 'providers', 'account'),
    };
    const off = {
      ...on,
      ...workflowSaveConfig(on, 'dictation', groqDictation, 'private', 'account'),
    };
    expect(off.inference?.cleanup).toEqual({ mode: 'openwhispr' });
    expect(off.inference?.agent).toEqual({ mode: 'openwhispr' });
  });

  // Setup in Local Mode holds only uploads and cleanup; a later switch to Bring Your Own Key holds
  // the rest where Local Mode ran them.
  it('holds what Local setup ran when it is followed by Bring Your Own Key', () => {
    const setup = dictationModeConfig({ defaultMode: 'cloud' }, 'private');
    const localSetup: UserConfig = { ...setup, ...holdOnDeviceConfig(setup) };
    const next = workflowSaveConfig(localSetup, 'dictation', groqDictation, 'private', 'session');
    expect(next.inference).toEqual({
      dictation: groqDictation,
      upload: { mode: 'local' },
      cleanup: { mode: 'local' },
      notes: { mode: 'openwhispr' },
      noteChat: { mode: 'local' },
      agent: { mode: 'openwhispr' },
    });
    expect(next.pinnedInference).toEqual(['upload', 'cleanup', 'notes', 'noteChat', 'agent']);
  });

  // Cloud cleanup held for an anonymous session can't run in Local Mode, which cleans on this
  // phone instead (workflowSelection); returning to Cloud finds it on Cloud again.
  it('ends a Cloud round trip through Local Mode on Cloud for an anonymous session', () => {
    const cloud: UserConfig = {
      defaultMode: 'cloud',
      inference: { dictation: { mode: 'openwhispr' } },
    };
    const on = {
      ...cloud,
      ...workflowSaveConfig(cloud, 'dictation', { mode: 'local' }, 'cloud', 'session'),
    };
    expect(on.inference?.cleanup).toEqual({ mode: 'openwhispr' });
    expect(on.pinnedInference).toContain('cleanup');
    const off = {
      ...on,
      ...workflowSaveConfig(on, 'dictation', { mode: 'openwhispr' }, 'private', 'session'),
    };
    expect(off.inference).toEqual({
      dictation: { mode: 'openwhispr' },
      upload: { mode: 'openwhispr' },
      cleanup: { mode: 'openwhispr' },
      notes: { mode: 'openwhispr' },
      noteChat: { mode: 'openwhispr' },
      agent: { mode: 'openwhispr' },
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

  it('is kept when dictation leaves Local Mode', () => {
    const config: UserConfig = {
      defaultMode: 'private',
      inference: { dictation: { mode: 'local' } },
    };
    const upgraded = { ...config, ...localModeUpgradeConfig(config) };
    const next = workflowSaveConfig(
      upgraded,
      'dictation',
      { mode: 'openwhispr' },
      'private',
      'account',
    );
    expect(next.inference?.upload).toEqual({ mode: 'local' });
    expect(next.inference?.cleanup).toEqual({ mode: 'local' });
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

// Note chat once shared the voice assistant's setting, so an existing config gives it the same one.
describe('noteChatSplitConfig', () => {
  const groqChat = {
    mode: 'providers' as const,
    providerId: 'groq',
    modelId: 'llama-3.3-70b-versatile',
    credentialRef: 'provider.groq',
  };

  it('copies a provider selection and its remembered providers', () => {
    expect(
      noteChatSplitConfig({
        defaultMode: 'cloud',
        noteChatEnabled: true,
        inference: { agent: groqChat },
        rememberedInference: { agent: { groq: groqChat } },
      }),
    ).toEqual({
      noteChatSplit: true,
      inference: { agent: groqChat, noteChat: groqChat },
      rememberedInference: { agent: { groq: groqChat }, noteChat: { groq: groqChat } },
    });
  });

  it('holds note chat where the voice assistant was held', () => {
    const next = noteChatSplitConfig({
      defaultMode: 'private',
      inference: { agent: { mode: 'openwhispr' } },
      pinnedInference: ['upload', 'agent'],
    });
    expect(next.pinnedInference).toEqual(['upload', 'agent', 'noteChat']);
  });

  it("saves note chat's switch as it stood, following the voice assistant's", () => {
    expect(noteChatSplitConfig({ defaultMode: 'cloud' }).noteChatEnabled).toBe(true);
    expect(
      noteChatSplitConfig({ defaultMode: 'cloud', dictationAgentEnabled: false }).noteChatEnabled,
    ).toBe(false);
    expect(noteChatSplitConfig({ defaultMode: 'cloud', noteChatEnabled: true })).not.toHaveProperty(
      'noteChatEnabled',
    );
  });

  it('never overwrites a saved note chat', () => {
    const next = noteChatSplitConfig({
      defaultMode: 'cloud',
      inference: { agent: groqChat, noteChat: { mode: 'local' } },
      rememberedInference: { agent: { groq: groqChat }, noteChat: {} },
      pinnedInference: ['agent'],
      noteChatEnabled: true,
    });
    expect(next).toEqual({ noteChatSplit: true });
  });

  it('only marks a config with nothing saved for the voice assistant', () => {
    expect(noteChatSplitConfig({ defaultMode: 'cloud', noteChatEnabled: true })).toEqual({
      noteChatSplit: true,
    });
  });
});

// Note chat followed the voice assistant's hold before it had a setting of its own: leaving Local
// Mode for Bring Your Own Key kept it on this iPhone, so it still does.
it('holds note chat on this iPhone when dictation leaves Local Mode for Bring Your Own Key', () => {
  const groq = {
    mode: 'providers' as const,
    providerId: 'groq',
    modelId: 'whisper-large-v3-turbo',
    credentialRef: 'provider.groq',
  };
  const next = workflowSaveConfig(
    { defaultMode: 'private', inference: { dictation: { mode: 'local' } } },
    'dictation',
    groq,
    'private',
  );
  expect(next.inference?.noteChat).toEqual({ mode: 'local' });
  expect(next.inference?.agent).toEqual({ mode: 'openwhispr' });
  expect(next.pinnedInference).toContain('noteChat');
});
