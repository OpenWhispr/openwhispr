import { fireEvent, render } from '@testing-library/react-native';
import { MeetingTabs } from '../MeetingTabs';

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));

describe('MeetingTabs', () => {
  it('reports the selected tab', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<MeetingTabs active="notes" onChange={onChange} />);

    fireEvent.press(getByTestId('meeting-tab-transcript'));
    expect(onChange).toHaveBeenCalledWith('transcript');

    fireEvent.press(getByTestId('meeting-tab-notes'));
    expect(onChange).toHaveBeenCalledWith('notes');
  });

  it('marks the active tab for accessibility', () => {
    const { getByTestId } = render(<MeetingTabs active="transcript" onChange={jest.fn()} />);

    expect(getByTestId('meeting-tab-transcript').props.accessibilityState).toEqual({
      selected: true,
    });
    expect(getByTestId('meeting-tab-notes').props.accessibilityState).toEqual({ selected: false });
  });

  // Regression guard. `shadow-sm` (and any variable-setting Tailwind class)
  // added to a component after its first render trips NativeWind's "upgrade"
  // warning, whose message is built by JSON.stringify-ing the props — that walks
  // children._owner into React Navigation's context and throws
  // "Couldn't find a navigation context" from a getter. Selected state on these
  // tabs must live in `style`, never in a toggled className.
  it('keeps both tabs on a static className so switching cannot trip NativeWind', () => {
    const notesActive = render(<MeetingTabs active="notes" onChange={jest.fn()} />);
    expect(notesActive.getByTestId('meeting-tab-notes').props.className).toBe(
      notesActive.getByTestId('meeting-tab-transcript').props.className,
    );

    const transcriptActive = render(<MeetingTabs active="transcript" onChange={jest.fn()} />);
    expect(transcriptActive.getByTestId('meeting-tab-notes').props.className).toBe(
      transcriptActive.getByTestId('meeting-tab-transcript').props.className,
    );
  });
});
