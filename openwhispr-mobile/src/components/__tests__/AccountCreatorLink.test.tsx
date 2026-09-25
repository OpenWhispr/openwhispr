import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { AccountCreatorLink } from '../AccountCreatorLink';
import { useAffiliateStore } from '@/store/useAffiliateStore';
import { getAffiliateClientConfig } from '@/lib/affiliateLink';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/apiClient', () => ({ ApiError: class ApiError extends Error {} }));
let mockFocusAccount: () => void;
let mockBlurAccount: () => void;
const mockAuth = { user: { id: 'user-a' }, sessionCookie: 'cookie-a' };
jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => () => void) =>
    require('react').useEffect(() => {
      mockFocusAccount = effect;
      mockBlurAccount = effect();
      return mockBlurAccount;
    }, [effect]),
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/lib/affiliateLink', () => ({ getAffiliateClientConfig: jest.fn(() => ({})) }));
jest.mock('@/lib/affiliateAttribution', () => ({ checkAndClaimAffiliate: jest.fn() }));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => mockAuth },
}));
jest.mock('@/store/useConfigStore', () => ({ useConfigStore: { getState: jest.fn() } }));
jest.mock('../../../modules/creator-link-input/src', () => ({
  CreatorLinkInput: (props: object) => {
    const { View } = require('react-native');
    return <View {...props} testID="creator-input" />;
  },
}));

const link = 'https://sandbox.dub.link/creator';
beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.user = { id: 'user-a' };
  mockAuth.sessionCookie = 'cookie-a';
  jest
    .mocked(getAffiliateClientConfig)
    .mockReturnValue({ domain: 'sandbox.dub.link', publishableKey: 'test' });
  useAffiliateStore.setState({
    link: '',
    saved: false,
    error: null,
    checking: false,
    hydrated: true,
    ownerId: 'user-a',
    clickId: null,
    autoSubmit: false,
  });
});

it('expands the menu and auto-checks the exact pasted link once without a billing tap', async () => {
  let finish!: (result: 'shown') => void;
  const check = jest.fn(
    () =>
      new Promise<'shown'>((resolve) => {
        finish = resolve;
      }),
  );
  const viewPlans = jest.fn();
  const screen = render(<AccountCreatorLink onCheckOffer={check} onViewPlans={viewPlans} />);
  expect(screen.queryByTestId('creator-input')).toBeNull();
  fireEvent.press(screen.getByText('Have a creator code?'));
  fireEvent(screen.getByTestId('creator-input'), 'paste', link);
  fireEvent(screen.getByTestId('creator-input'), 'paste', link);
  await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
  expect(useAffiliateStore.getState().link).toBe(link);
  expect(screen.getByText('Checking your offer…')).toBeTruthy();
  expect(viewPlans).not.toHaveBeenCalled();
  await act(async () => {
    useAffiliateStore.setState({ saved: true });
    finish('shown');
  });
  expect(screen.getByText('Creator saved')).toBeTruthy();
  expect(screen.getByText('Check offer')).toBeTruthy();
  expect(screen.queryByText(/couldn’t verify/)).toBeNull();
  expect(viewPlans).not.toHaveBeenCalled();
});

it('does not claim during typing and uses the complete native value on Go', async () => {
  const check = jest.fn().mockResolvedValue('invalid');
  const screen = render(<AccountCreatorLink onCheckOffer={check} onViewPlans={jest.fn()} />);
  fireEvent.press(screen.getByText('Have a creator code?'));
  fireEvent(screen.getByTestId('creator-input'), 'changeText', link);
  await act(async () => {});
  expect(check).not.toHaveBeenCalled();
  fireEvent(screen.getByTestId('creator-input'), 'submit', `${link}-full`);
  await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
  expect(useAffiliateStore.getState().link).toBe(`${link}-full`);
});

it('keeps an unavailable offer inline and opens ordinary plans only by choice', async () => {
  const check = jest.fn(async () => {
    useAffiliateStore.setState({ saved: true });
    return 'unavailable' as const;
  });
  const viewPlans = jest.fn();
  const screen = render(<AccountCreatorLink onCheckOffer={check} onViewPlans={viewPlans} />);
  fireEvent.press(screen.getByText('Have a creator code?'));
  fireEvent(screen.getByTestId('creator-input'), 'paste', link);
  await waitFor(() => expect(screen.getByText('View plans')).toBeTruthy());
  expect(viewPlans).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('Not now'));
  expect(screen.queryByText('View plans')).toBeNull();
  fireEvent.press(screen.getByText('Creator saved'));
  fireEvent.press(screen.getByText('Check offer'));
  await waitFor(() => expect(screen.getByText('View plans')).toBeTruthy());
  fireEvent.press(screen.getByText('View plans'));
  expect(viewPlans).toHaveBeenCalledTimes(1);
});

it.each([
  'This creator link is unavailable.',
  'Creator links are unavailable with your current tracking settings.',
  'We couldn’t check your link.',
])('retains failed input with retry and clearing: %s', async (error) => {
  const check = jest.fn(async () => {
    useAffiliateStore.setState({ error });
    return 'invalid' as const;
  });
  const screen = render(<AccountCreatorLink onCheckOffer={check} onViewPlans={jest.fn()} />);
  fireEvent.press(screen.getByText('Have a creator code?'));
  fireEvent(screen.getByTestId('creator-input'), 'paste', link);
  await waitFor(() => expect(screen.getByText('Try again')).toBeTruthy());
  expect(screen.queryByText('Clear link')).toBeNull();
  expect(screen.getByText(error)).toBeTruthy();
  expect(useAffiliateStore.getState().link).toBe(link);
  fireEvent.press(screen.getByText('Try again'));
  await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
  await act(async () => {
    fireEvent(screen.getByTestId('creator-input'), 'changeText', '');
  });
  expect(useAffiliateStore.getState().link).toBe('');
});

it('does not submit an empty paste or a paste that completes after leaving Account', async () => {
  const check = jest.fn();
  const screen = render(<AccountCreatorLink onCheckOffer={check} onViewPlans={jest.fn()} />);
  fireEvent.press(screen.getByText('Have a creator code?'));
  fireEvent(screen.getByTestId('creator-input'), 'paste', '');
  await act(async () => {});
  expect(check).not.toHaveBeenCalled();
  fireEvent(screen.getByTestId('creator-input'), 'paste', link);
  screen.unmount();
  await act(async () => {});
  expect(check).not.toHaveBeenCalled();
});

it('rejects late paste and typing callbacks after blur, even after returning', async () => {
  const check = jest.fn();
  const screen = render(<AccountCreatorLink onCheckOffer={check} onViewPlans={jest.fn()} />);
  fireEvent.press(screen.getByText('Have a creator code?'));
  const input = screen.getByTestId('creator-input');
  const paste = input.props.onPaste;
  const type = input.props.onChangeText;
  act(() => {
    mockBlurAccount();
  });
  expect(screen.queryByTestId('creator-input')).toBeNull();
  await act(async () => {
    paste(link);
    type(link);
  });
  expect(useAffiliateStore.getState().link).toBe('');
  act(() => {
    mockFocusAccount();
  });
  await act(async () => {
    paste(link);
  });
  expect(useAffiliateStore.getState().link).toBe('');
  expect(check).not.toHaveBeenCalled();
});

it('rejects a callback from the previous account before a React rerender', async () => {
  const check = jest.fn();
  const screen = render(<AccountCreatorLink onCheckOffer={check} onViewPlans={jest.fn()} />);
  fireEvent.press(screen.getByText('Have a creator code?'));
  const paste = screen.getByTestId('creator-input').props.onPaste;
  mockAuth.user = { id: 'user-b' };
  mockAuth.sessionCookie = 'cookie-b';
  await act(async () => {
    paste(link);
  });
  expect(useAffiliateStore.getState().link).toBe('');
  expect(check).not.toHaveBeenCalled();
});
