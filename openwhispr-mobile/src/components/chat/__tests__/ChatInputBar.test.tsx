import { act, fireEvent, render } from '@testing-library/react-native';
import { Text } from 'react-native';
import type { ChatVoiceInput } from '@/hooks/useChatVoiceInput';
import { safeHaptics } from '@/lib/utils';
import { ChatInputBar, type StartVoice } from '../ChatInputBar';

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/features/WaveformVisualizer', () => ({ RecordingBars: () => null }));
jest.mock('@/hooks/useAudioWaveform', () => ({
  useAudioWaveform: () => ({ waveformData: [], currentAmplitude: 0 }),
}));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));

const makeVoice = (overrides: Partial<ChatVoiceInput> = {}): ChatVoiceInput => ({
  state: 'idle',
  elapsedSeconds: 0,
  isSettling: false,
  noSpeechHeard: false,
  audioRecorder: {} as ChatVoiceInput['audioRecorder'],
  start: jest.fn(async () => true),
  finish: jest.fn(async () => undefined),
  cancel: jest.fn(async () => undefined),
  ...overrides,
});

type Props = React.ComponentProps<typeof ChatInputBar>;

const baseProps = (voice: ChatVoiceInput, overrides: Partial<Props> = {}): Props => ({
  voice,
  value: '',
  onChangeText: jest.fn(),
  placeholder: 'Reply',
  busy: false,
  canStop: true,
  disabled: false,
  onSend: jest.fn(),
  onMicPress: (startVoice: StartVoice) => startVoice(false),
  onCancelTurn: jest.fn(),
  restingBottomPadding: 14,
  ...overrides,
});

beforeEach(() => jest.clearAllMocks());

describe('ChatInputBar', () => {
  it('says when no speech was heard, unless something else holds the composer', () => {
    const voice = makeVoice({ noSpeechHeard: true });
    const screen = render(<ChatInputBar {...baseProps(voice)} />);
    expect(screen.getByText('No speech detected')).toBeTruthy();

    screen.rerender(
      <ChatInputBar {...baseProps(voice, { notice: <Text>Chat is turned off</Text> })} />,
    );
    expect(screen.queryByText('No speech detected')).toBeNull();
    expect(screen.getByText('Chat is turned off')).toBeTruthy();
  });

  it('listens in the composer: the mic finishes and × cancels', () => {
    const voice = makeVoice({ state: 'listening' });
    const screen = render(<ChatInputBar {...baseProps(voice)} />);
    expect(screen.getByLabelText('Recording')).toBeTruthy();
    expect(screen.queryByText('Listening…')).toBeNull();
    expect(screen.queryByPlaceholderText('Reply')).toBeNull();
    expect(screen.queryByLabelText('Speak your question')).toBeNull();

    fireEvent.press(screen.getByLabelText('Send question'));
    fireEvent.press(screen.getByLabelText('Cancel recording'));
    expect(voice.finish).toHaveBeenCalledTimes(1);
    expect(voice.cancel).toHaveBeenCalledTimes(1);
  });

  it('says it is transcribing in place of the input', () => {
    const screen = render(
      <ChatInputBar {...baseProps(makeVoice({ state: 'transcribing' }), { busy: true })} />,
    );
    expect(screen.getByText('Transcribing…')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Reply')).toBeNull();
    expect(screen.getByLabelText('Stop')).toBeTruthy();
  });

  it('stops a transcribing question, or else the working turn', () => {
    const transcribing = makeVoice({ state: 'transcribing' });
    const first = render(<ChatInputBar {...baseProps(transcribing, { busy: true })} />);
    fireEvent.press(first.getByLabelText('Stop'));
    expect(transcribing.cancel).toHaveBeenCalledTimes(1);

    const idle = makeVoice();
    const onCancelTurn = jest.fn();
    const second = render(<ChatInputBar {...baseProps(idle, { busy: true, onCancelTurn })} />);
    fireEvent.press(second.getByLabelText('Stop'));
    expect(onCancelTurn).toHaveBeenCalledTimes(1);
    expect(idle.cancel).not.toHaveBeenCalled();
  });

  it('ignores a Stop that lands right after the listening mic’s tap', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(10_000);
    const voice = makeVoice({ state: 'listening' });
    const screen = render(<ChatInputBar {...baseProps(voice, { busy: true })} />);
    fireEvent.press(screen.getByLabelText('Send question'));

    screen.rerender(
      <ChatInputBar {...baseProps({ ...voice, state: 'transcribing' }, { busy: true })} />,
    );
    now.mockReturnValue(10_300);
    fireEvent.press(screen.getByLabelText('Stop'));
    expect(voice.cancel).not.toHaveBeenCalled();

    now.mockReturnValue(10_600);
    fireEvent.press(screen.getByLabelText('Stop'));
    expect(voice.cancel).toHaveBeenCalledTimes(1);
    now.mockRestore();
  });

  it('ignores a Stop right after Send even once the question is working', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(10_000);
    const onCancelTurn = jest.fn();
    const voice = makeVoice({ state: 'listening' });
    const screen = render(<ChatInputBar {...baseProps(voice, { busy: true, onCancelTurn })} />);
    fireEvent.press(screen.getByLabelText('Send question'));

    screen.rerender(
      <ChatInputBar {...baseProps({ ...voice, state: 'idle' }, { busy: true, onCancelTurn })} />,
    );
    now.mockReturnValue(10_300);
    fireEvent.press(screen.getByLabelText('Stop'));
    expect(onCancelTurn).not.toHaveBeenCalled();

    now.mockReturnValue(10_600);
    fireEvent.press(screen.getByLabelText('Stop'));
    expect(onCancelTurn).toHaveBeenCalledTimes(1);
    now.mockRestore();
  });

  it('disables the mic while a cancelled question is still settling', () => {
    const screen = render(<ChatInputBar {...baseProps(makeVoice({ isSettling: true }))} />);

    expect(screen.getByLabelText('Speak your question').props.accessibilityState).toEqual({
      disabled: true,
    });
    expect(screen.getByPlaceholderText('Reply').props.editable).toBe(true);
  });

  it('offers no Stop for a turn the screen does not own, and shows its notice', () => {
    const onCancelTurn = jest.fn();
    const screen = render(
      <ChatInputBar
        {...baseProps(makeVoice(), {
          busy: true,
          canStop: false,
          onCancelTurn,
          notice: <Text>Working on “Pricing”…</Text>,
        })}
      />,
    );
    expect(screen.queryByLabelText('Stop')).toBeNull();
    expect(screen.getByText('Working on “Pricing”…')).toBeTruthy();
    expect(screen.getByPlaceholderText('Reply').props.editable).toBe(false);
  });

  it('starts voice through onMicPress, with a light haptic when it is refused', async () => {
    const voice = makeVoice({ start: jest.fn(async () => false) });
    const onMicPress = jest.fn((startVoice: StartVoice) => startVoice(true));
    const screen = render(<ChatInputBar {...baseProps(voice, { onMicPress })} />);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Speak your question'));
    });
    expect(onMicPress).toHaveBeenCalledTimes(1);
    expect(voice.start).toHaveBeenCalledWith(true);
    expect(safeHaptics).toHaveBeenCalledWith('light');
  });
});
