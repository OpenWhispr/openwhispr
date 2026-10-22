import { act, fireEvent, render } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { VoiceSetupBanner } from '../VoiceSetupBanner';
import { ThatsMeSheet } from '../ThatsMeSheet';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/GlassIconButton', () => ({
  GlassIconButton: ({ onPress, accessibilityLabel }: any) =>
    require('react').createElement(require('react-native').Pressable, {
      onPress,
      accessibilityLabel,
    }),
}));

const candidates = [
  { speakerId: 11, name: 'Speaker 2', speechMs: 65000, sampleLine: 'Let us ship on Friday.' },
  { speakerId: 10, name: 'Speaker 1', speechMs: 12000, sampleLine: 'Sounds good.' },
];

describe('VoiceSetupBanner', () => {
  it('explains the benefit and offers set up and dismiss', () => {
    const onSetUp = jest.fn();
    const onDismiss = jest.fn();
    const { getByText, getByTestId } = render(
      <VoiceSetupBanner onSetUp={onSetUp} onDismiss={onDismiss} />,
    );

    expect(getByText('Teach OpenWhispr your voice')).toBeTruthy();
    expect(getByText('Your next on-device meetings will label you as Me.')).toBeTruthy();
    expect(getByTestId('voice-setup-banner-dismiss').props.accessibilityLabel).toBe(
      'Dismiss voice setup',
    );
    fireEvent.press(getByTestId('voice-setup-banner-set-up'));
    fireEvent.press(getByTestId('voice-setup-banner-dismiss'));

    expect(onSetUp).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('ThatsMeSheet', () => {
  const baseProps = {
    visible: true,
    candidates,
    onClaim: jest.fn(() => true),
    onReadScript: jest.fn(),
    onClose: jest.fn(),
  };

  beforeEach(() => jest.clearAllMocks());

  it('lists each speaker with how long they spoke and what they said', () => {
    const { getByText } = render(<ThatsMeSheet {...baseProps} />);

    expect(getByText('Which speaker is you?')).toBeTruthy();
    expect(getByText('Speaker 2')).toBeTruthy();
    expect(getByText('Spoke for 1 min')).toBeTruthy();
    expect(getByText('Spoke for 12 sec')).toBeTruthy();
    expect(getByText('“Let us ship on Friday.”')).toBeTruthy();
  });

  it('claims the tapped speaker and confirms, out loud too', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const { getByTestId, getByText } = render(<ThatsMeSheet {...baseProps} />);

    fireEvent.press(getByTestId('thats-me-11'));

    expect(baseProps.onClaim).toHaveBeenCalledWith(11);
    expect(getByText('Got it')).toBeTruthy();
    expect(announce).toHaveBeenCalledWith(expect.stringContaining('Got it'));
    fireEvent.press(getByTestId('thats-me-done'));
    expect(baseProps.onClose).toHaveBeenCalled();
  });

  it("keeps the first claim when That's me is tapped twice before it re-renders", () => {
    // The second call would fail: the first one already saved the owner profile.
    const onClaim = jest.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const { getByTestId, getByText } = render(<ThatsMeSheet {...baseProps} onClaim={onClaim} />);
    const button = getByTestId('thats-me-11');

    act(() => {
      fireEvent.press(button);
      fireEvent.press(button);
    });

    expect(onClaim).toHaveBeenCalledTimes(1);
    expect(getByText('Got it')).toBeTruthy();
  });

  it('stays on the list when the claim fails', () => {
    const onClaim = jest.fn(() => false);
    const { getByTestId, queryByText } = render(<ThatsMeSheet {...baseProps} onClaim={onClaim} />);

    fireEvent.press(getByTestId('thats-me-11'));

    expect(queryByText('Got it')).toBeNull();
    expect(getByTestId('thats-me-read-script')).toBeTruthy();
  });

  it('offers only the script when no speaker has a sample', () => {
    const { getByTestId, queryByTestId, getByText } = render(
      <ThatsMeSheet {...baseProps} candidates={[]} />,
    );

    expect(queryByTestId('thats-me-11')).toBeNull();
    expect(
      getByText(
        "There's no voice sample from this meeting to use. Read a short script instead; it takes about 20 seconds.",
      ),
    ).toBeTruthy();
    fireEvent.press(getByTestId('thats-me-read-script'));
    expect(baseProps.onReadScript).toHaveBeenCalled();
  });

  it('shows the privacy note that the tap agrees to above the speakers', () => {
    const { getByText, toJSON } = render(<ThatsMeSheet {...baseProps} />);
    const note =
      "We'll use your voice from this meeting to make a voice profile. It stays on this device and is only used to recognize you in meetings you record. You can delete it in Voice Profiles.";
    expect(getByText(note)).toBeTruthy();
    // Visible before any speaker, so it's on screen when you tap That's me.
    const rendered = JSON.stringify(toJSON());
    expect(rendered.indexOf(note)).toBeLessThan(rendered.indexOf('Speaker 2'));
  });

  it('tells the screen once the sheet has finished closing', () => {
    const onDismissed = jest.fn();
    const { UNSAFE_getByType } = render(<ThatsMeSheet {...baseProps} onDismissed={onDismissed} />);

    UNSAFE_getByType(require('react-native').Modal).props.onDismiss();

    expect(onDismissed).toHaveBeenCalledTimes(1);
  });
});
