import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { SpeakerCountPrompt } from '../SpeakerCountPrompt';

jest.mock('@react-navigation/elements', () => ({
  useHeaderHeight: () => 0,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/GradientGlassSurface', () => ({ GradientGlassSurface: () => null }));

describe('SpeakerCountPrompt', () => {
  it('no event: steps the count and submits it', () => {
    const onSubmit = jest.fn();
    const { getByText, getByTestId } = render(<SpeakerCountPrompt onSubmit={onSubmit} />);

    expect(getByText('2')).toBeTruthy();
    fireEvent.press(getByTestId('speaker-count-increment'));
    expect(getByText('3')).toBeTruthy();

    fireEvent.press(getByTestId('speaker-count-confirm'));
    expect(onSubmit).toHaveBeenCalledWith(3);
  });

  it('no event: auto-detect toggle hides the stepper and submits undefined, then reverts', () => {
    const onSubmit = jest.fn();
    const { getByTestId, queryByTestId } = render(<SpeakerCountPrompt onSubmit={onSubmit} />);

    fireEvent.press(getByTestId('speaker-count-autodetect'));
    expect(queryByTestId('speaker-count-increment')).toBeNull();

    fireEvent.press(getByTestId('speaker-count-confirm'));
    expect(onSubmit).toHaveBeenCalledWith(undefined);

    fireEvent.press(getByTestId('speaker-count-setcount'));
    expect(getByTestId('speaker-count-increment')).toBeTruthy();
  });

  it('meeting selected without a derivable count: still offers manual count and auto-detect', () => {
    const onSubmit = jest.fn();
    const props = { onSubmit, eventSlot: <></>, selectedEventTitle: 'Test meeting' };
    const { getByText, getByTestId, queryByText } = render(
      <SpeakerCountPrompt {...props} countHintKey="event-1" />,
    );

    // No suggestedSpeakerCount → no read-only summary; we ask directly.
    expect(queryByText('From Test meeting')).toBeNull();
    expect(getByText('2')).toBeTruthy();

    fireEvent.press(getByTestId('speaker-count-autodetect'));
    fireEvent.press(getByTestId('speaker-count-confirm'));
    expect(onSubmit).toHaveBeenCalledWith(undefined);
  });

  it('meeting selected: derives the count, adjusts it, then resets to the derived value', async () => {
    const onSubmit = jest.fn();
    const props = { onSubmit, eventSlot: <></>, selectedEventTitle: 'Test meeting' };
    const { getByText, getByTestId, queryByTestId } = render(
      <SpeakerCountPrompt {...props} countHint={2} countHintKey="event-1" />,
    );

    await waitFor(() => expect(getByText('2 people')).toBeTruthy());
    expect(queryByTestId('speaker-count-increment')).toBeNull();

    fireEvent.press(getByTestId('speaker-count-adjust'));
    fireEvent.press(getByTestId('speaker-count-increment'));
    expect(getByText('3')).toBeTruthy();

    fireEvent.press(getByTestId('speaker-count-confirm'));
    expect(onSubmit).toHaveBeenCalledWith(3);

    fireEvent.press(getByTestId('speaker-count-reset'));
    await waitFor(() => expect(getByText('2 people')).toBeTruthy());
  });

  it('applies count hints once per selection and preserves a manual override', async () => {
    const onSubmit = jest.fn();
    const props = { onSubmit, eventSlot: <></>, selectedEventTitle: 'Test meeting' };
    const { getByText, getByTestId, rerender } = render(
      <SpeakerCountPrompt {...props} countHint={4} countHintKey="event-1" />,
    );

    await waitFor(() => expect(getByText('4 people')).toBeTruthy());

    fireEvent.press(getByTestId('speaker-count-adjust'));
    fireEvent.press(getByTestId('speaker-count-decrement'));
    expect(getByText('3')).toBeTruthy();

    // Same selection re-rendering must not re-apply the hint or collapse the override.
    rerender(<SpeakerCountPrompt {...props} countHint={4} countHintKey="event-1" />);
    expect(getByText('3')).toBeTruthy();
    fireEvent.press(getByTestId('speaker-count-confirm'));
    expect(onSubmit).toHaveBeenCalledWith(3);

    // A new selection reseeds the count and collapses back to the derived summary.
    rerender(
      <SpeakerCountPrompt
        {...props}
        selectedEventTitle="Standup"
        countHint={5}
        countHintKey="event-2"
      />,
    );
    await waitFor(() => expect(getByText('5 people')).toBeTruthy());
  });
});
