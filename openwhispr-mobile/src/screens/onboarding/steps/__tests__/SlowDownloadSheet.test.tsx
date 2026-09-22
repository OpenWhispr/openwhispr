import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { OnboardingError } from '@/lib/onboardingErrors';
import { SlowDownloadSheet } from '../SlowDownloadSheet';
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));

it('shows a Cloud failure without losing the ability to keep downloading locally', async () => {
  const onContinueCloud = jest
    .fn()
    .mockRejectedValue(new OnboardingError('Cloud needs a connection'));
  const onKeepWaiting = jest.fn();
  const screen = render(
    <SlowDownloadSheet visible onContinueCloud={onContinueCloud} onKeepWaiting={onKeepWaiting} />,
  );
  fireEvent.press(screen.getByText('Continue with Cloud for now'));
  expect(await screen.findByText('Cloud needs a connection')).toBeTruthy();
  fireEvent.press(screen.getByText('Keep waiting'));
  expect(onKeepWaiting).toHaveBeenCalledTimes(1);
});
it('does not start two Cloud transitions on repeated taps', async () => {
  const onContinueCloud = jest.fn().mockReturnValue(new Promise<void>(() => undefined));
  const screen = render(
    <SlowDownloadSheet visible onContinueCloud={onContinueCloud} onKeepWaiting={jest.fn()} />,
  );
  const button = screen.getByText('Continue with Cloud for now');
  fireEvent.press(button);
  fireEvent.press(button);
  await waitFor(() => expect(onContinueCloud).toHaveBeenCalledTimes(1));
});
it('does not show the text of an unexpected Cloud failure', async () => {
  const onContinueCloud = jest
    .fn()
    .mockRejectedValue(new Error("Calling the 'setValueWithKeyAsync' function has failed"));
  const screen = render(
    <SlowDownloadSheet visible onContinueCloud={onContinueCloud} onKeepWaiting={jest.fn()} />,
  );
  fireEvent.press(screen.getByText('Continue with Cloud for now'));
  expect(await screen.findByText('Cloud is unavailable. Try again.')).toBeTruthy();
  expect(screen.queryByText(/setValueWithKeyAsync/)).toBeNull();
});
