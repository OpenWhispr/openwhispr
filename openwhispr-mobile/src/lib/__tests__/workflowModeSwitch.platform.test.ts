import { Alert, Platform } from 'react-native';
import * as defaultSwitch from '../workflowModeSwitch';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

const mockUpdateConfig = jest.fn().mockResolvedValue(undefined);
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'fixture', isAnonymous: false } }) },
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({ config: { defaultMode: 'cloud' }, updateConfig: mockUpdateConfig }),
  },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: 'cloud', setActiveMode: jest.fn() }) },
}));
jest.mock('@/lib/privateMode', () => ({
  getPrivateModeReadiness: async () => ({ status: 'ready' }),
}));
jest.mock('@/lib/localReasoning', () => ({
  getLocalReasoningReadiness: async () => ({ status: 'ready' }),
}));

it('keeps the upstream default workflow-switch API', () => {
  expect(Object.keys(defaultSwitch).sort()).toEqual(['pickLocalModel', 'switchWorkflowMode']);
});

it('retains the upstream default note-formatting offer on web', async () => {
  const originalOS = Platform.OS;
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  Platform.OS = 'web';
  try {
    await defaultSwitch.switchWorkflowMode('dictation', 'local');
    await Promise.resolve();
    expect(alert).toHaveBeenCalledWith(
      'Format notes on this iPhone too?',
      expect.any(String),
      expect.any(Array),
    );
  } finally {
    Platform.OS = originalOS;
    alert.mockRestore();
  }
});
