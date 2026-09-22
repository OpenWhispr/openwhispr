import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { SlowDownloadSheet } from '../SlowDownloadSheet';
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));

it('shows a Cloud failure without losing the ability to keep downloading locally', async () => {
  const onContinueCloud = jest.fn().mockRejectedValue(new Error('Cloud needs a connection'));
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
