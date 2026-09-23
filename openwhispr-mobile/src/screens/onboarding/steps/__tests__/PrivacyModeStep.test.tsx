import { Alert } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

// accountAccess pulls in the router for its sign-in alert; stub it here.
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: require('react-native').View,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/OpenWhisprMark', () => ({ OpenWhisprMark: () => null }));

const mockGoNext = jest.fn().mockResolvedValue(undefined);
jest.mock('@/store/useOnboardingStore', () => ({
  useOnboardingStore: (selector: (s: { goNext: () => Promise<void> }) => unknown) =>
    selector({ goNext: mockGoNext }),
  getStepProgress: () => ({ current: 1, total: 1 }),
}));
const mockUpdateConfig = jest.fn().mockResolvedValue(undefined);
let mockConfig: Record<string, unknown> = { defaultMode: 'private' };
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: Object.assign(
    (
      selector: (s: {
        config: Record<string, unknown>;
        loadConfig: () => void;
        updateConfig: () => Promise<void>;
      }) => unknown,
    ) => selector({ config: mockConfig, loadConfig: jest.fn(), updateConfig: mockUpdateConfig }),
    { getState: () => ({ config: mockConfig }) },
  ),
}));

const mockEnsureAnonymousSession = jest.fn().mockResolvedValue(undefined);
type MockAuthState = {
  user: { id: string; isAnonymous: boolean } | null;
  isGuest: boolean;
  ensureAnonymousSession: jest.Mock;
};
let mockAuthState: MockAuthState = {
  user: null,
  isGuest: false,
  ensureAnonymousSession: mockEnsureAnonymousSession,
};
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: MockAuthState) => unknown) => selector(mockAuthState),
    { getState: () => mockAuthState },
  ),
}));

import { PrivacyModeStep } from '../PrivacyModeStep';

const alertSpy = jest.spyOn(Alert, 'alert');

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig = { defaultMode: 'private' };
  mockAuthState = {
    user: null,
    isGuest: false,
    ensureAnonymousSession: mockEnsureAnonymousSession,
  };
});

describe('PrivacyModeStep cloud card without a session', () => {
  it('explains a missing connection when the anonymous session never opened', async () => {
    const { getByLabelText } = render(<PrivacyModeStep />);

    fireEvent.press(getByLabelText('OpenWhispr Cloud'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(alertSpy.mock.calls[0][0]).toBe('Cloud is unavailable');
  });

  // A guest chose to continue without an account on an earlier build; they
  // have a connection and no session is going to be minted for them, so
  // blaming the network would be wrong.
  it('tells a guest that Cloud needs an account, not a connection', async () => {
    mockAuthState = {
      user: null,
      isGuest: true,
      ensureAnonymousSession: mockEnsureAnonymousSession,
    };
    const { getByLabelText } = render(<PrivacyModeStep />);

    fireEvent.press(getByLabelText('OpenWhispr Cloud'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(alertSpy.mock.calls[0][0]).toBe('Cloud needs an account');
    expect(mockEnsureAnonymousSession).not.toHaveBeenCalled();
  });
});

describe('PrivacyModeStep continue', () => {
  // Reset onboarding keeps the saved config, so a stale dictation selection must
  // follow the mode picked here or routing disagrees with the Home toggle.
  it('writes the dictation selection alongside the picked mode', async () => {
    mockConfig = { defaultMode: 'cloud', inference: { dictation: { mode: 'openwhispr' } } };
    const { getByText } = render(<PrivacyModeStep />);

    fireEvent.press(getByText('Continue'));

    await waitFor(() =>
      expect(mockUpdateConfig).toHaveBeenCalledWith({
        defaultMode: 'private',
        inference: { dictation: { mode: 'local' } },
      }),
    );
  });

  it('keeps a Providers setup when neither mode card is picked', async () => {
    const dictation = { mode: 'providers', providerId: 'groq', modelId: 'whisper-large-v3' };
    mockConfig = { defaultMode: 'providers', inference: { dictation } };
    const { getByText } = render(<PrivacyModeStep />);

    fireEvent.press(getByText('Continue'));

    await waitFor(() => expect(mockGoNext).toHaveBeenCalled());
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });
});
