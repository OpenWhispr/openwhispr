jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import { noteChatSplitConfig } from '../inferenceModes';
import { noteChatSplitConfig as androidNoteChatSplitConfig } from '../inferenceModes.android';
import type { UserConfig } from '@/types';

it.each([
  ['cloud', { mode: 'openwhispr' as const }],
  ['local', { mode: 'local' as const, modelId: 'fixture-local' }],
  [
    'provider',
    { mode: 'providers' as const, providerId: 'fixture-provider', modelId: 'fixture-model' },
  ],
])(
  'leaves Android return-state metadata alone in the default %s note-chat upgrade',
  (_name, agent) => {
    const privateModeReturn: UserConfig['privateModeReturn'] = { pinned: { agent } };
    const saved: UserConfig = { defaultMode: 'private', privateModeReturn };
    const update = noteChatSplitConfig(saved);
    expect(update).not.toHaveProperty('privateModeReturn');
    expect({ ...saved, ...update }.privateModeReturn).toBe(privateModeReturn);
    expect(saved.privateModeReturn?.pinned).not.toHaveProperty('noteChat');
  },
);

it('retains the Android return selection when upgrading note-chat settings', () => {
  const agent = { mode: 'providers' as const, providerId: 'fixture-provider' };
  const saved: UserConfig = { defaultMode: 'private', privateModeReturn: { pinned: { agent } } };
  const update = androidNoteChatSplitConfig(saved);
  expect(update.privateModeReturn?.pinned).toEqual({ agent, noteChat: agent });
  expect(saved.privateModeReturn?.pinned).not.toHaveProperty('noteChat');
});
