jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import { dictationModeConfig } from '../inferenceModes';

it('releases the upload pin when dictation leaves Providers', () => {
  const pinned = {
    defaultMode: 'providers' as const,
    inference: { upload: { mode: 'local' as const } },
  };
  expect(dictationModeConfig(pinned, 'cloud').inference?.upload).toBeUndefined();
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
