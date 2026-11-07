import { createRef } from 'react';
import type { TextInput } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { ChatComposer } from '../ChatComposer';

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
const mockRecordingBars = jest.fn((_props: { numBars?: number }) => null);
jest.mock('@/components/features/WaveformVisualizer', () => ({
  RecordingBars: (props: { numBars?: number }) => mockRecordingBars(props),
}));
const mockUseAudioWaveform = jest.fn((..._args: unknown[]) => ({
  waveformData: [],
  currentAmplitude: 0,
}));
jest.mock('@/hooks/useAudioWaveform', () => ({
  useAudioWaveform: (...args: unknown[]) => mockUseAudioWaveform(...args),
}));

const renderComposer = (
  overrides: Partial<React.ComponentProps<typeof ChatComposer>> = {},
): ReturnType<typeof render> & { props: React.ComponentProps<typeof ChatComposer> } => {
  const props: React.ComponentProps<typeof ChatComposer> = {
    value: '',
    onChangeText: jest.fn(),
    placeholder: 'Ask anything',
    busy: false,
    disabled: false,
    onSend: jest.fn(),
    onMicPress: jest.fn(),
    onStop: jest.fn(),
    ...overrides,
  };
  return { ...render(<ChatComposer {...props} />), props };
};

describe('ChatComposer', () => {
  it('fills the field with the waveform while listening', () => {
    const { getByLabelText } = renderComposer({
      listening: { audioRecorder: null, onCancel: jest.fn(), onFinish: jest.fn() },
    });
    expect(mockRecordingBars).not.toHaveBeenCalled();

    fireEvent(getByLabelText('Recording'), 'layout', {
      nativeEvent: { layout: { width: 240, height: 18, x: 0, y: 0 } },
    });

    // 3 px bars, 3 px apart: 40 bars span 237 px.
    expect(mockRecordingBars).toHaveBeenLastCalledWith(expect.objectContaining({ numBars: 40 }));
    const historyLength = mockUseAudioWaveform.mock.calls.at(-1)?.[2];
    expect(historyLength).toBeGreaterThanOrEqual(40);
  });

  it('hands the screen its input, so Edit question can focus it', () => {
    const inputRef = createRef<TextInput>();
    renderComposer({ inputRef });
    expect(typeof inputRef.current?.focus).toBe('function');
  });

  it('swaps mic, send and stop', () => {
    const empty = renderComposer();
    expect(empty.getByLabelText('Speak your question')).toBeTruthy();
    expect(empty.queryByLabelText('Send')).toBeNull();
    expect(empty.queryByLabelText('Stop')).toBeNull();
    fireEvent.press(empty.getByLabelText('Speak your question'));
    expect(empty.props.onMicPress).toHaveBeenCalledTimes(1);

    const typed = renderComposer({ value: 'hello' });
    expect(typed.getByLabelText('Send')).toBeTruthy();
    expect(typed.queryByLabelText('Speak your question')).toBeNull();
    fireEvent.press(typed.getByLabelText('Send'));
    expect(typed.props.onSend).toHaveBeenCalledTimes(1);

    const busy = renderComposer({ value: 'hello', busy: true });
    expect(busy.getByLabelText('Stop')).toBeTruthy();
    expect(busy.queryByLabelText('Send')).toBeNull();
    fireEvent.press(busy.getByLabelText('Stop'));
    expect(busy.props.onStop).toHaveBeenCalledTimes(1);
  });

  it('shows no Stop while a turn it cannot stop is running', () => {
    const empty = renderComposer({ busy: true, onStop: undefined });
    expect(empty.queryByLabelText('Stop')).toBeNull();
    expect(empty.getByLabelText('Speak your question').props.accessibilityState).toEqual({
      disabled: true,
    });
    fireEvent.press(empty.getByLabelText('Speak your question'));
    expect(empty.props.onMicPress).not.toHaveBeenCalled();

    const typed = renderComposer({ value: 'hello', busy: true, onStop: undefined });
    expect(typed.queryByLabelText('Stop')).toBeNull();
    fireEvent.press(typed.getByLabelText('Send'));
    expect(typed.props.onSend).not.toHaveBeenCalled();
  });

  it('keeps the input editable while busy, locking only sending, and locks it when disabled', () => {
    expect(renderComposer().getByPlaceholderText('Ask anything').props.editable).toBe(true);
    expect(renderComposer({ busy: true }).getByPlaceholderText('Ask anything').props.editable).toBe(
      true,
    );
    expect(
      renderComposer({ busy: true, value: 'Next question', onStop: undefined }).getByLabelText(
        'Send',
      ).props.accessibilityState,
    ).toEqual({ disabled: true });
    expect(
      renderComposer({ disabled: true }).getByPlaceholderText('Ask anything').props.editable,
    ).toBe(false);
  });

  it('names the input apart from an example placeholder', () => {
    const screen = renderComposer({
      placeholder: 'Summarize my meetings this week',
      inputLabel: 'Ask anything',
    });
    expect(screen.getByLabelText('Ask anything').props.placeholder).toBe(
      'Summarize my meetings this week',
    );
  });
});
