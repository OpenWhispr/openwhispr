import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

const mockSetTarget = jest.fn();
const mockDictationRoute = jest.fn();
const mockRequiresRealAccount = jest.fn();
const mockGetSupportedLanguages = jest.fn();
let mockConfig: { keyboardTranslationTarget?: string | null } | null = null;

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) => selector({ config: mockConfig }),
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({ user: null }),
}));
jest.mock('@/lib/accountAccess', () => ({
  requiresRealAccount: (...args: unknown[]) => mockRequiresRealAccount(...args),
}));
jest.mock('@/lib/keyboardDirectInputs', () => ({
  dictationRoute: () => mockDictationRoute(),
}));
jest.mock('@/lib/keyboardTranslationSync', () => ({
  setKeyboardTranslationTarget: (code: string | null) => mockSetTarget(code),
}));
jest.mock('@/lib/appleLLM', () => ({
  AppleLLM: { getSupportedLanguages: () => mockGetSupportedLanguages() },
}));

import KeyboardTranslationScreen from '../KeyboardTranslationScreen';

const cloudRoute = { provider: 'openwhispr', cleanupMode: 'openwhispr', cleanupUnavailable: false };

describe('KeyboardTranslationScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig = null;
    mockDictationRoute.mockReturnValue(cloudRoute);
    mockRequiresRealAccount.mockReturnValue(false);
    mockGetSupportedLanguages.mockResolvedValue([]);
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

  it('disables rows without the sign-in note when there is no text model route', () => {
    mockDictationRoute.mockReturnValue(null);
    render(<KeyboardTranslationScreen />);
    expect(screen.queryByText('Sign in to translate dictation.')).toBeNull();
    fireEvent.press(screen.getByText('Spanish'));
    expect(mockSetTarget).not.toHaveBeenCalled();
  });

  it('limits On-Device languages to the ones the model supports', async () => {
    mockDictationRoute.mockReturnValue({ ...cloudRoute, cleanupMode: 'local' });
    mockGetSupportedLanguages.mockResolvedValue(['es-ES']);
    render(<KeyboardTranslationScreen />);
    await act(async () => {});
    expect(screen.getByText('Spanish')).toBeTruthy();
    expect(screen.queryByText('French')).toBeNull();
  });
});
