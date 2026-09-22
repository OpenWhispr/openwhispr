import { fireEvent, render } from '@testing-library/react-native';
import { ConflictBanner } from '../ConflictBanner';

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));

describe('ConflictBanner', () => {
  it('renders the conflict message and both actions when a server copy is available', () => {
    const { getByText, getByTestId } = render(
      <ConflictBanner canUseServerCopy onKeepMine={jest.fn()} onUseServer={jest.fn()} />,
    );

    expect(getByText('This note was edited on another device.')).toBeTruthy();
    expect(getByTestId('conflict-banner-keep-mine')).toBeTruthy();
    expect(getByTestId('conflict-banner-use-server')).toBeTruthy();
  });

  it('hides "Use server copy" when the parked payload failed to parse', () => {
    const { queryByTestId, getByTestId } = render(
      <ConflictBanner canUseServerCopy={false} onKeepMine={jest.fn()} onUseServer={jest.fn()} />,
    );

    expect(getByTestId('conflict-banner-keep-mine')).toBeTruthy();
    expect(queryByTestId('conflict-banner-use-server')).toBeNull();
  });

  it('calls onKeepMine when Keep mine is tapped', () => {
    const onKeepMine = jest.fn();
    const { getByTestId } = render(
      <ConflictBanner canUseServerCopy onKeepMine={onKeepMine} onUseServer={jest.fn()} />,
    );

    fireEvent.press(getByTestId('conflict-banner-keep-mine'));

    expect(onKeepMine).toHaveBeenCalledTimes(1);
  });

  it('calls onUseServer when Use server copy is tapped', () => {
    const onUseServer = jest.fn();
    const { getByTestId } = render(
      <ConflictBanner canUseServerCopy onKeepMine={jest.fn()} onUseServer={onUseServer} />,
    );

    fireEvent.press(getByTestId('conflict-banner-use-server'));

    expect(onUseServer).toHaveBeenCalledTimes(1);
  });
});
