import { renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { SUPERWALL_PLACEMENTS } from '@/lib/superwall';

type MockConfig = { inference?: { noteChat?: { mode?: string } }; noteChatEnabled?: boolean };
type MockUser = { id: string; isAnonymous: boolean } | null;

let mockConfig: MockConfig | null = null;
let mockUser: MockUser = null;
let mockSessionCookie = 'session-a';
let mockActiveMode = 'local';

jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: Object.assign(
    (selector: (state: { config: MockConfig | null }) => unknown) =>
      selector({ config: mockConfig }),
    { getState: () => ({ config: mockConfig }) },
  ),
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: Object.assign(
    (selector: (state: { user: MockUser }) => unknown) => selector({ user: mockUser }),
    { getState: () => ({ user: mockUser, sessionCookie: mockSessionCookie }) },
  ),
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: mockActiveMode }) },
}));

const mockRegister = jest.fn();
jest.mock('@/hooks/useSuperwallGate', () => ({
  useSuperwallGate: () => ({ register: mockRegister }),
}));

const mockShowAccountRequiredAlert = jest.fn();
jest.mock('@/lib/accountAccess', () => ({
  requiresRealAccount: (user: MockUser) => !user || Boolean(user.isAnonymous),
  showAccountRequiredAlert: (...args: unknown[]) => mockShowAccountRequiredAlert(...args),
}));

const mockConfirmCloudOnce = jest.fn();
jest.mock('@/lib/alerts', () => ({
  confirmCloudOnce: (...args: unknown[]) => mockConfirmCloudOnce(...args),
}));

import { useChatSendGate } from '../useChatSendGate';

beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'ios';
  mockSessionCookie = 'session-a';
  mockActiveMode = 'local';
  mockConfig = { inference: { noteChat: { mode: 'openwhispr' } } };
  mockUser = { id: 'u', isAnonymous: false };
  // Mirrors the real provider: the feature runs once the paywall lets the user through.
  mockRegister.mockImplementation(async ({ feature }: { feature?: () => void }) => {
    feature?.();
    return true;
  });
  mockConfirmCloudOnce.mockImplementation((_message: string, onConfirm: () => void) => onConfirm());
});

describe('useChatSendGate', () => {
  it('asks a guest to sign in before cloud chat', () => {
    mockUser = null;
    const run = jest.fn();
    const { result } = renderHook(() => useChatSendGate());

    result.current.gate(run, { consentMessage: null, source: 'note_chat' });

    expect(mockShowAccountRequiredAlert).toHaveBeenCalledWith('AI chat', { cloudOnly: true });
    expect(mockRegister).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('skips the paywall and the account check on a local route', () => {
    mockUser = null;
    mockConfig = { inference: { noteChat: { mode: 'local' } } };
    const run = jest.fn();
    const { result } = renderHook(() => useChatSendGate());

    result.current.gate(run, { consentMessage: 'Send this?', source: 'chat_tab' });

    expect(mockShowAccountRequiredAlert).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
    expect(mockConfirmCloudOnce).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(false);
  });

  it('asks for consent once, then runs with allowCloudFallback true', () => {
    const run = jest.fn();
    const { result } = renderHook(() => useChatSendGate());

    result.current.gate(run, { consentMessage: 'Send this?', source: 'note_chat' });

    expect(mockConfirmCloudOnce).toHaveBeenCalledTimes(1);
    expect(mockConfirmCloudOnce).toHaveBeenCalledWith('Send this?', expect.any(Function));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(true);
  });

  it('runs with allowCloudFallback false when no consent is needed', () => {
    const run = jest.fn();
    const { result } = renderHook(() => useChatSendGate());

    result.current.gate(run, { consentMessage: null, source: 'note_chat' });

    expect(mockConfirmCloudOnce).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(false);
  });

  it('passes the source through to the paywall params', () => {
    const { result } = renderHook(() => useChatSendGate());

    result.current.gate(jest.fn(), { consentMessage: null, source: 'chat_tab' });

    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: SUPERWALL_PLACEMENTS.noteChatStart,
        params: { source: 'chat_tab' },
        requiresAccount: false,
      }),
    );
  });

  it('reports chat as enabled unless the config turns it off', () => {
    mockConfig = null;
    const { result, rerender } = renderHook(() => useChatSendGate());
    expect(result.current.chatEnabled).toBe(true);

    mockConfig = { noteChatEnabled: false };
    rerender({});
    expect(result.current.chatEnabled).toBe(false);
  });

  it.each(['account', 'session', 'mode', 'route', 'disabled'])(
    'drops Android consent after the %s changes',
    (change) => {
      Platform.OS = 'android';
      mockConfirmCloudOnce.mockImplementation(() => {});
      const run = jest.fn();
      const { result } = renderHook(() => useChatSendGate());
      result.current.gate(run, { consentMessage: 'Send this?', source: 'chat_tab' });
      if (change === 'account') mockUser = { id: 'b', isAnonymous: false };
      if (change === 'session') mockSessionCookie = 'session-b';
      if (change === 'mode') mockActiveMode = 'cloud';
      if (change === 'route') mockConfig = { inference: { noteChat: { mode: 'providers' } } };
      if (change === 'disabled') mockConfig = { ...mockConfig, noteChatEnabled: false };
      mockConfirmCloudOnce.mock.calls[0][1]();
      expect(mockRegister).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    },
  );

  it('drops a delayed Android paywall callback after the account changes', () => {
    Platform.OS = 'android';
    mockRegister.mockResolvedValue(true);
    const run = jest.fn();
    const { result } = renderHook(() => useChatSendGate());
    result.current.gate(run, { consentMessage: null, source: 'chat_tab' });
    mockUser = { id: 'b', isAnonymous: false };
    mockRegister.mock.calls[0][0].feature();
    expect(run).not.toHaveBeenCalled();
  });
});
