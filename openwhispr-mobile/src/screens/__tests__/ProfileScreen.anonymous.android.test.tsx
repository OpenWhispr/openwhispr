import { fireEvent, render } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { confirmAccountDeletion } from '@/lib/alerts';

const mockRouterPush = jest.fn();
const mockDeleteAccount = jest.fn();
type MockAuthState = {
  user: { id: string; email: string; name?: string; isAnonymous: boolean } | null;
  deleteAccount: jest.Mock;
};
const mockAuthState: MockAuthState = { user: null, deleteAccount: mockDeleteAccount };

jest.mock('@/android/navigationBar', () => ({
  useNavigationBar: () => ({ buttons: true, inset: 0 }),
  useNavigationBarCanvas: () => undefined,
}));
jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockRouterPush(...args), canGoBack: () => true },
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@/android/strings', () => ({
  __esModule: true,
  default: { addResourceBundle: jest.fn(), t: (key: string) => key },
}));
jest.mock('@/store/useAuthStore', () => ({ useAuthStore: () => mockAuthState }));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: (selector: (state: { usage: null; load: jest.Mock }) => unknown) =>
    selector({ usage: null, load: jest.fn() }),
}));
jest.mock('@/lib/alerts', () => ({ confirmAccountDeletion: jest.fn() }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));

import ProfileScreen from '../ProfileScreen.android';

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockReturnValue(new Promise(() => {}));
});

it('opens sign-in when nobody is signed in', () => {
  mockAuthState.user = null;
  const { getByText } = render(<ProfileScreen />);
  fireEvent.press(getByText('signIn'));
  expect(mockRouterPush).toHaveBeenCalledWith('/auth?reason=sync');
});

it('offers account creation to an anonymous session, never deletion', () => {
  mockAuthState.user = { id: 'anon', email: 'temp-1@anon.openwhispr.invalid', isAnonymous: true };
  const { getByText, queryByText } = render(<ProfileScreen />);
  fireEvent.press(getByText('createAccount'));
  expect(mockRouterPush).toHaveBeenCalledWith('/auth?reason=sync');
  expect(queryByText('deleteAccount')).toBeNull();
});

it('shows the account and confirms before deleting it', () => {
  mockAuthState.user = { id: 'real', email: 'real@example.com', isAnonymous: false };
  const { getByText } = render(<ProfileScreen />);
  expect(getByText('real@example.com')).toBeTruthy();
  fireEvent.press(getByText('deleteAccount'));
  expect(confirmAccountDeletion).toHaveBeenCalledWith(mockDeleteAccount);
});
