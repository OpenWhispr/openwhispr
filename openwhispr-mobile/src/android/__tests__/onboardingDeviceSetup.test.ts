jest.mock('../models', () => ({
  cancelAndroidDownload: jest.fn(),
  downloadAndroidModel: jest.fn(),
  modelReady: jest.fn(),
  modelSupported: () => true,
}));
jest.mock('../settings/bubbleAppearance', () => ({ setHoldAction: jest.fn() }));
jest.mock('@/store/useConfigStore', () => ({ useConfigStore: { getState: () => ({}) } }));

import { modelFor, modelsToDownload } from '../onboarding/deviceSetup';

const none = { cleanup: false, assistant: false, speakers: false };

describe('Set up your device', () => {
  it('downloads only Speech until something is added', () => {
    expect(modelsToDownload(none)).toEqual(['parakeet-v3']);
  });

  it('downloads the shared text model once for Cleanup and the Assistant', () => {
    expect(modelsToDownload({ ...none, cleanup: true, assistant: true })).toEqual([
      'parakeet-v3',
      'qwen-small',
    ]);
    expect(modelFor('cleanup')).toBe(modelFor('assistant'));
  });

  it('queues Meeting speakers after the rest, Speech always first', () => {
    expect(modelsToDownload({ cleanup: false, assistant: true, speakers: true })).toEqual([
      'parakeet-v3',
      'qwen-small',
      'meeting-speakers',
    ]);
  });
});
