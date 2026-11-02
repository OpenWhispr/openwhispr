import { renderHook } from '@testing-library/react-native';
import { SUPERWALL_PLACEMENTS } from '@/lib/superwall';

type MockConfig = { inference?: { noteChat?: { mode?: string } }; noteChatEnabled?: boolean };
type MockUser = { id: string; isAnonymous: boolean } | null;

let mockConfig: MockConfig | null = null;
let mockUser: MockUser = null;

jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: { config: MockConfig | null }) => unknown) =>
    selector({ config: mockConfig }),
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: MockUser }) => unknown) => selector({ user: mockUser }),
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
});
