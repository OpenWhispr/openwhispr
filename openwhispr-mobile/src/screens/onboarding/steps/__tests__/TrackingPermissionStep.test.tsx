import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { TrackingAuthorizationStatus } from '@/lib/trackingTransparency';

const mockGoNext = jest.fn();
const mockMarkRequestAttempted = jest.fn();
const mockGetTrackingAuthorizationStatus = jest.fn();
const mockRequestTrackingAuthorization = jest.fn();
const mockSetAppsFlyerTrackingAuthorizationStatus = jest.fn();
const mockCaptureException = jest.fn();

let mockTrackingAuthorizationRequestAttempted = false;

// NativeWind's runtime helpers are not transformed by this Jest setup. Keep
// this suite focused on the step contract with lightweight native stand-ins.
jest.mock('@/components/onboarding/OnboardingShell', () => {
  const { Pressable, Text, View } = require('react-native');
  return {
    OnboardingShell: ({
      title,
      subtitle,
      ctaLabel,
      ctaDisabled,
      onCta,
      children,
    }: {
      title: string;
      subtitle?: string;
      ctaLabel: string;
      ctaDisabled?: boolean;
      onCta: () => void;
      children?: React.ReactNode;
    }) => (
      <View>
        <Text accessibilityRole="header">{title}</Text>
        {subtitle ? <Text>{subtitle}</Text> : null}
        {children}
        <Pressable accessibilityRole="button" disabled={ctaDisabled} onPress={onCta}>
          <Text>{ctaLabel}</Text>
        </Pressable>
      </View>
    ),
  };
});
jest.mock('@/components/ui/Text', () => {
  const { Text } = require('react-native');
  return { Text };
});
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/OpenWhisprMark', () => ({ OpenWhisprMark: () => null }));

jest.mock('@/store/useOnboardingStore', () => ({
  getStepProgress: () => undefined,
  useOnboardingStore: (
    selector: (state: {
      goNext: () => Promise<void>;
      markTrackingAuthorizationRequestAttempted: () => Promise<void>;
      trackingAuthorizationRequestAttempted: boolean;
    }) => unknown,
  ) =>
    selector({
      goNext: mockGoNext,
      markTrackingAuthorizationRequestAttempted: mockMarkRequestAttempted,
      trackingAuthorizationRequestAttempted: mockTrackingAuthorizationRequestAttempted,
    }),
}));

jest.mock('@/lib/trackingTransparency', () => ({
  getTrackingAuthorizationStatus: (): Promise<TrackingAuthorizationStatus> =>
    mockGetTrackingAuthorizationStatus(),
  requestTrackingAuthorization: (): Promise<TrackingAuthorizationStatus> =>
    mockRequestTrackingAuthorization(),
}));

jest.mock('@/lib/appsflyer', () => ({
  setAppsFlyerTrackingAuthorizationStatus: (status: TrackingAuthorizationStatus): void =>
    mockSetAppsFlyerTrackingAuthorizationStatus(status),
}));

jest.mock('@/lib/sentry', () => ({
  Sentry: { captureException: (...args: unknown[]) => mockCaptureException(...args) },
}));

import { TrackingPermissionStep } from '../TrackingPermissionStep';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTrackingAuthorizationRequestAttempted = false;
  mockGoNext.mockResolvedValue(undefined);
  mockMarkRequestAttempted.mockResolvedValue(undefined);
  mockGetTrackingAuthorizationStatus.mockResolvedValue('notDetermined');
  mockRequestTrackingAuthorization.mockResolvedValue('authorized');
});

describe('TrackingPermissionStep', () => {
  it('shows the education screen while iOS authorization is not determined', async () => {
    const { findByRole, getByText } = render(<TrackingPermissionStep />);

    expect(await findByRole('header')).toBeTruthy();
    expect(getByText('Continue')).toBeTruthy();
    expect(mockGoNext).not.toHaveBeenCalled();
  });

  it('omits the decorative OpenWhispr logo from the education content', async () => {
    const { findByRole, queryByLabelText } = render(<TrackingPermissionStep />);

    expect(await findByRole('header')).toBeTruthy();
    expect(queryByLabelText('OpenWhispr advertising measurement')).toBeNull();
  });

  it.each(['authorized', 'denied'] as const)(
    'skips the education screen when authorization is already %s',
    async (status) => {
      mockGetTrackingAuthorizationStatus.mockResolvedValue(status);

      const { queryByText } = render(<TrackingPermissionStep />);

      await waitFor(() => expect(mockGoNext).toHaveBeenCalledWith('tracking-permission'));
      expect(mockGoNext).toHaveBeenCalledTimes(1);
      expect(queryByText('Continue')).toBeNull();
      expect(mockRequestTrackingAuthorization).not.toHaveBeenCalled();
    },
  );

  it('skips the education screen on Android and unsupported iOS', async () => {
    mockGetTrackingAuthorizationStatus.mockResolvedValue('notSupported');

    render(<TrackingPermissionStep />);

    await waitFor(() => expect(mockGoNext).toHaveBeenCalledWith('tracking-permission'));
    expect(mockGoNext).toHaveBeenCalledTimes(1);
    expect(mockRequestTrackingAuthorization).not.toHaveBeenCalled();
  });

  it('skips a not-determined status after an earlier request attempt', async () => {
    mockTrackingAuthorizationRequestAttempted = true;

    render(<TrackingPermissionStep />);

    await waitFor(() => expect(mockGoNext).toHaveBeenCalledWith('tracking-permission'));
    expect(mockGoNext).toHaveBeenCalledTimes(1);
    expect(mockRequestTrackingAuthorization).not.toHaveBeenCalled();
  });

  it('allows only one native request while the first request is in flight', async () => {
    const authorization = deferred<TrackingAuthorizationStatus>();
    mockRequestTrackingAuthorization.mockReturnValue(authorization.promise);
    const { findByText } = render(<TrackingPermissionStep />);
    const continueButton = await findByText('Continue');

    fireEvent.press(continueButton);
    fireEvent.press(continueButton);

    await waitFor(() => expect(mockRequestTrackingAuthorization).toHaveBeenCalledTimes(1));
    expect(mockMarkRequestAttempted).toHaveBeenCalledTimes(1);

    authorization.resolve('authorized');
    await waitFor(() => expect(mockGoNext).toHaveBeenCalledWith('tracking-permission'));
    expect(mockGoNext).toHaveBeenCalledTimes(1);
  });

  it.each(['authorized', 'denied', 'notDetermined', 'notSupported'] as const)(
    'advances to completion after the native request returns %s',
    async (status) => {
      mockRequestTrackingAuthorization.mockResolvedValue(status);
      const { findByText } = render(<TrackingPermissionStep />);

      fireEvent.press(await findByText('Continue'));

      await waitFor(() => expect(mockGoNext).toHaveBeenCalledWith('tracking-permission'));
      expect(mockGoNext).toHaveBeenCalledTimes(1);
      expect(mockSetAppsFlyerTrackingAuthorizationStatus).toHaveBeenCalledWith(status);
    },
  );

  it('fails open and advances to completion when the native request errors', async () => {
    const error = new Error('native ATT request failed');
    mockRequestTrackingAuthorization.mockRejectedValue(error);
    const { findByText } = render(<TrackingPermissionStep />);

    fireEvent.press(await findByText('Continue'));

    await waitFor(() => expect(mockGoNext).toHaveBeenCalledWith('tracking-permission'));
    expect(mockGoNext).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(error);
  });

  it('does not risk a repeat prompt when persisting the attempt fails', async () => {
    mockMarkRequestAttempted.mockRejectedValue(new Error('secure storage unavailable'));
    const { findByText } = render(<TrackingPermissionStep />);

    fireEvent.press(await findByText('Continue'));

    await waitFor(() => expect(mockGoNext).toHaveBeenCalledWith('tracking-permission'));
    expect(mockGoNext).toHaveBeenCalledTimes(1);
    expect(mockRequestTrackingAuthorization).not.toHaveBeenCalled();
  });

  it('fails open and advances to completion when checking authorization errors', async () => {
    const error = new Error('ATT status unavailable');
    mockGetTrackingAuthorizationStatus.mockRejectedValue(error);

    render(<TrackingPermissionStep />);

    await waitFor(() => expect(mockGoNext).toHaveBeenCalledWith('tracking-permission'));
    expect(mockGoNext).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(error);
  });
});

it('offers continuation retry when auto-skipping ATT fails to save progress', async () => {
  mockGetTrackingAuthorizationStatus.mockResolvedValue('authorized');
  mockGoNext.mockRejectedValueOnce(
    new Error("Calling the 'setValueWithKeyAsync' function has failed"),
  );
  const screen = render(<TrackingPermissionStep />);
  expect(await screen.findByText('Could not save progress.')).toBeTruthy();
  fireEvent.press(screen.getByText('Retry'));
  expect(mockCaptureException).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(mockGoNext).toHaveBeenCalledTimes(2));
  expect(mockRequestTrackingAuthorization).not.toHaveBeenCalled();
});
