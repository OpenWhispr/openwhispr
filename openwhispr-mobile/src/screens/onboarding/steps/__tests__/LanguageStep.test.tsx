import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { LanguageStep } from '../LanguageStep';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: require('react-native').View,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/lib/deviceLanguages', () => ({ detectPreferredLanguages: () => ['en'] }));
const mockNext = jest.fn();
const mockBack = jest.fn();
const mockSave = jest.fn();
jest.mock('@/hooks/useOnboardingStep', () => ({
  useOnboardingStep: () => ({ goNext: mockNext, goBack: mockBack }),
}));
jest.mock('@/lib/onboardingMode', () => ({
  saveOnboardingConfig: (updates: unknown) => mockSave(updates),
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) =>
    selector({ config: { languages: ['es', 'fr'] } }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockNext.mockResolvedValue(undefined);
  mockBack.mockResolvedValue(undefined);
  mockSave.mockResolvedValue(undefined);
});

it('restores confirmed languages and goes back without saving edits', async () => {
  const screen = render(<LanguageStep />);
  expect(screen.getByLabelText('Remove Spanish')).toBeTruthy();
  expect(screen.queryByLabelText('Remove English')).toBeNull();
  fireEvent.press(screen.getByLabelText('Remove French'));
  fireEvent.press(screen.getByText('Back'));
  await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  expect(mockSave).not.toHaveBeenCalled();
});

it('stays on languages after a failed save and retries the selected values', async () => {
  mockSave.mockRejectedValueOnce(new Error('Storage unavailable'));
  const screen = render(<LanguageStep />);
  fireEvent.press(screen.getByLabelText('Remove French'));
  fireEvent.press(screen.getByText('Continue'));
  expect(await screen.findByText('Storage unavailable')).toBeTruthy();
  expect(mockNext).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('Retry'));
  await waitFor(() => expect(mockNext).toHaveBeenCalledTimes(1));
  expect(mockSave).toHaveBeenLastCalledWith({ languages: ['es'] });
});
