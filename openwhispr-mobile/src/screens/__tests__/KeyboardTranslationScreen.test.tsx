import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

const mockSetTarget = jest.fn();
const mockDictationRoute = jest.fn();
const mockRequiresRealAccount = jest.fn();
const mockReadSupport = jest.fn();
let mockConfig: { keyboardTranslationTarget?: string | null } | null = null;

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) => selector({ config: mockConfig }),
}));
let mockUser: { id: string; isAnonymous: boolean } | null = null;
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({ user: mockUser }),
}));
jest.mock('@/lib/accountAccess', () => ({
  requiresRealAccount: (...args: unknown[]) => mockRequiresRealAccount(...args),
}));
jest.mock('@/lib/keyboardDirectInputs', () => ({
  dictationRoute: () => mockDictationRoute(),
}));
jest.mock('@/lib/keyboardTranslationSync', () => ({
  setKeyboardTranslationTarget: (code: string | null) => mockSetTarget(code),
  readOnDeviceTranslationSupport: () => mockReadSupport(),
}));
jest.mock('@/lib/localReasoning', () => ({
  getLocalReasoningUnavailableMessage: (readiness: { status: string }) =>
    `Unavailable: ${readiness.status}`,
}));

import KeyboardTranslationScreen from '../KeyboardTranslationScreen';

const cloudRoute = { provider: 'openwhispr', cleanupMode: 'openwhispr', cleanupUnavailable: false };
const localRoute = { ...cloudRoute, cleanupMode: 'local' };
const READY = { status: 'ready', tokenCounting: true };

describe('KeyboardTranslationScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig = null;
    mockUser = null;
    mockDictationRoute.mockReturnValue(cloudRoute);
    mockRequiresRealAccount.mockReturnValue(false);
    mockReadSupport.mockResolvedValue({ codes: null, readiness: READY });
  });

  it('selects a language and Off', () => {
    render(<KeyboardTranslationScreen />);
    fireEvent.press(screen.getByText('Spanish'));
    expect(mockSetTarget).toHaveBeenCalledWith('es');
    fireEvent.press(screen.getByText('Off'));
    expect(mockSetTarget).toHaveBeenCalledWith(null);
  });

  it('disables the languages for a guest on Cloud', () => {
    mockRequiresRealAccount.mockReturnValue(true);
    render(<KeyboardTranslationScreen />);
    expect(screen.getByText('Sign in to translate dictation.')).toBeTruthy();
    fireEvent.press(screen.getByText('Spanish'));
    expect(mockSetTarget).not.toHaveBeenCalled();
  });

  it('keeps Off pressable for a guest on Cloud with a stored target, and shows it selected', () => {
    mockRequiresRealAccount.mockReturnValue(true);
    mockConfig = { keyboardTranslationTarget: 'es' };
    render(<KeyboardTranslationScreen />);
    expect(screen.getByRole('button', { name: 'Spanish', selected: true })).toBeTruthy();
    fireEvent.press(screen.getByText('French'));
    expect(mockSetTarget).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText('Off'));
    expect(mockSetTarget).toHaveBeenCalledWith(null);
  });

  it('asks an anonymous session to create an account', () => {
    mockRequiresRealAccount.mockReturnValue(true);
    mockUser = { id: 'anon', isAnonymous: true };
    render(<KeyboardTranslationScreen />);
    expect(screen.getByText('Create an account to translate dictation.')).toBeTruthy();
  });

  it('points to AI Models and locks the rows when there is no text model route', () => {
    mockDictationRoute.mockReturnValue(null);
    render(<KeyboardTranslationScreen />);
    expect(
      screen.getByText(
        'Translation runs on your cleanup model. Finish setting it up in AI Models.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Sign in to translate dictation.')).toBeNull();
    fireEvent.press(screen.getByText('Spanish'));
    expect(mockSetTarget).not.toHaveBeenCalled();
  });

  it('points to AI Models when the cleanup route is unavailable', () => {
    mockDictationRoute.mockReturnValue({ ...cloudRoute, cleanupUnavailable: true });
    render(<KeyboardTranslationScreen />);
    expect(
      screen.getByText(
        'Translation runs on your cleanup model. Finish setting it up in AI Models.',
      ),
    ).toBeTruthy();
  });

  it('limits On-Device languages to the ones the model supports', async () => {
    mockDictationRoute.mockReturnValue(localRoute);
    mockReadSupport.mockResolvedValue({ codes: ['es-es'], readiness: READY });
    render(<KeyboardTranslationScreen />);
    await act(async () => {});
    expect(screen.getByText('Spanish')).toBeTruthy();
    expect(screen.queryByText('French')).toBeNull();
  });

  it('says why On-Device can not translate and keeps only Off pressable', async () => {
    mockDictationRoute.mockReturnValue(localRoute);
    mockConfig = { keyboardTranslationTarget: 'es' };
    mockReadSupport.mockResolvedValue({
      codes: null,
      readiness: { status: 'appleIntelligenceOff', tokenCounting: false },
    });
    render(<KeyboardTranslationScreen />);
    await act(async () => {});
    expect(screen.getByText('Unavailable: appleIntelligenceOff')).toBeTruthy();
    fireEvent.press(screen.getByText('French'));
    expect(mockSetTarget).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText('Off'));
    expect(mockSetTarget).toHaveBeenCalledWith(null);
  });

  it('explains a saved language the On-Device model can not translate into', async () => {
    mockDictationRoute.mockReturnValue(localRoute);
    mockConfig = { keyboardTranslationTarget: 'ru' };
    mockReadSupport.mockResolvedValue({ codes: ['es', 'fr'], readiness: READY });
    render(<KeyboardTranslationScreen />);
    await act(async () => {});
    expect(
      screen.getByText(
        "Apple Intelligence can't translate into Russian, so dictation isn't translated while cleanup runs On-Device. Your choice is saved.",
      ),
    ).toBeTruthy();
    expect(mockSetTarget).not.toHaveBeenCalled();
  });
});
