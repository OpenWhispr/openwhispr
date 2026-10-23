import { act, fireEvent, render } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import type { ChatStep } from '@/lib/chat/types';
import { ChatSteps } from '../ChatSteps';

jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  Easing: { inOut: jest.fn(), ease: jest.fn(), linear: jest.fn() },
  cancelAnimation: jest.fn(),
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => false,
  useSharedValue: (initial: number) => ({ value: initial }),
  withRepeat: jest.fn(),
  withTiming: jest.fn(),
}));
jest.mock('../ChatSpinner', () => ({
  ChatSpinner: () => {
    const { View } = require('react-native');
    return <View testID="chat-spinner" />;
  },
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));

const steps: ChatStep[] = [
  { id: 'search', status: 'done', label: 'Searched your notes', detail: '2 notes match' },
  { id: 'read', status: 'active', label: 'Reading “Pricing call”…' },
];

describe('ChatSteps', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows only the active step until opened', () => {
    const { getByText, queryByText, queryByTestId, getByRole } = render(
      <ChatSteps steps={steps} variant="working" />,
    );
    expect(getByText('Reading “Pricing call”…')).toBeTruthy();
    expect(queryByText('Searched your notes')).toBeNull();
    expect(getByRole('button').props.accessibilityState).toEqual({ expanded: false });

    fireEvent.press(getByRole('button'));

    expect(getByText('Searched your notes')).toBeTruthy();
    expect(getByText('2 notes match')).toBeTruthy();
    expect(queryByTestId('chat-spinner')).not.toBeNull();
    expect(getByRole('button').props.accessibilityState).toEqual({ expanded: true });
  });

  it('shows only reported steps when opened', () => {
    const { getAllByTestId, getByRole, queryByText } = render(
      <ChatSteps
        steps={[{ id: 'search', status: 'active', label: 'Searching your notes…' }]}
        variant="working"
      />,
    );
    fireEvent.press(getByRole('button'));
    expect(getAllByTestId('chat-step-row')).toHaveLength(1);
    expect(queryByText('Writing your answer')).toBeNull();
    expect(queryByText('Checking your calendar')).toBeNull();
  });

  it('shows a saved step that was left active as done', () => {
    const { getByRole, getAllByTestId, queryByTestId } = render(
      <ChatSteps
        steps={[{ id: 'read', status: 'active', label: 'Reading “Pricing call”…' }]}
        variant="done"
        sourceCount={1}
      />,
    );
    fireEvent.press(getByRole('button'));
    expect(getAllByTestId('chat-step-row')).toHaveLength(1);
    expect(queryByTestId('chat-spinner')).toBeNull();
  });

  it('says Thinking… before the first step', () => {
    const { getByText } = render(<ChatSteps steps={[]} variant="working" />);
    expect(getByText('Thinking…')).toBeTruthy();
  });

  it('shows the source count when done', () => {
    const { getByText } = render(<ChatSteps steps={steps} variant="done" sourceCount={2} />);
    expect(getByText('Searched your notes · 2 sources')).toBeTruthy();
  });

  it('words one source and no matches', () => {
    const one = render(<ChatSteps steps={steps} variant="done" sourceCount={1} />);
    expect(one.getByText('Searched your notes · 1 source')).toBeTruthy();
    const none = render(<ChatSteps steps={steps} variant="done" sourceCount={0} />);
    expect(none.getByText('Searched your notes · no matches')).toBeTruthy();
  });

  it('switches to Still working after 15 seconds', () => {
    jest.useFakeTimers();
    const { getByText, queryByText } = render(
      <ChatSteps steps={steps} variant="working" startedAt={Date.now()} />,
    );
    expect(queryByText('Still working')).toBeNull();

    act(() => {
      jest.advanceTimersByTime(15_000);
    });

    expect(getByText('Still working')).toBeTruthy();
    expect(getByText('0:15')).toBeTruthy();
    expect(getByText('Questions that span many notes can take up to a minute.')).toBeTruthy();
    // One heading: the step line gives way to "Still working" rather than sitting above it.
    expect(queryByText('Reading “Pricing call”…')).toBeNull();
  });

  it('announces Still working once to screen readers', () => {
    jest.useFakeTimers();
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => undefined);
    render(<ChatSteps steps={steps} variant="working" startedAt={Date.now()} />);
    announce.mockClear();

    act(() => {
      jest.advanceTimersByTime(20_000);
    });

    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Still working on your answer.');
    announce.mockRestore();
  });

  it('leaves step changes to the explicit announcement, with no live region', () => {
    const { getByText } = render(<ChatSteps steps={steps} variant="working" />);
    expect(getByText('Reading “Pricing call”…').props.accessibilityLiveRegion).toBeUndefined();
  });

  it('announces nothing while its screen is covered', () => {
    jest.useFakeTimers();
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => undefined);
    const isFocused = (): boolean => false;
    render(
      <ChatSteps steps={steps} variant="working" startedAt={Date.now()} isFocused={isFocused} />,
    );

    act(() => {
      jest.advanceTimersByTime(20_000);
    });

    expect(announce).not.toHaveBeenCalled();
    announce.mockRestore();
  });

  it('clears its one-second timer on unmount', () => {
    jest.useFakeTimers();
    const { unmount } = render(
      <ChatSteps steps={steps} variant="working" startedAt={Date.now()} />,
    );
    expect(jest.getTimerCount()).toBe(1);
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('never shows Still working without a start time', () => {
    jest.useFakeTimers();
    const { queryByText } = render(<ChatSteps steps={steps} variant="working" />);
    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(queryByText('Still working')).toBeNull();
  });
});
