import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { RecordingBars } from '@/components/features/WaveformVisualizer';
import { BRAND_GRADIENT, CHAT_COLORS, iosColor } from '@/config/colors';
import { useAudioWaveform } from '@/hooks/useAudioWaveform';
import {
  ChatGradientButton,
  COMPOSER_BUTTON_RADIUS,
  COMPOSER_BUTTON_SIZE,
} from './ChatGradientButton';

export interface ChatComposerListening {
  audioRecorder: Parameters<typeof useAudioWaveform>[0];
  /** Drops what's been said. */
  onCancel: () => void;
  /** Stops listening, then transcribes and sends. */
  onFinish: () => void;
}

interface ChatComposerProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  /** Names the input when the placeholder is only an example question; defaults to it. */
  inputLabel?: string;
  /** Two lines tall at rest, for a screen built around the composer. */
  tall?: boolean;
  busy: boolean;
  disabled: boolean;
  onSend: () => void;
  onMicPress: () => void;
  /** Locks only the mic, e.g. while a cancelled question finishes transcribing. */
  micDisabled?: boolean;
  /** Stops the screen's own turn; without it a busy composer is simply locked. */
  onStop?: () => void;
  /** Set while a question is spoken: the input shows it listening and the mic finishes it. */
  listening?: ChatComposerListening | null;
  /** Set while a spoken question is transcribed, which the input says. */
  transcribing?: boolean;
}

const WAVEFORM_BARS = 14;

// Mounted only while listening, so the mic level is read only then.
function ListeningField({
  audioRecorder,
  onCancel,
}: Pick<ChatComposerListening, 'audioRecorder' | 'onCancel'>): React.JSX.Element {
  const { waveformData, currentAmplitude } = useAudioWaveform(audioRecorder, true);

  return (
    <View className="h-10 flex-row items-center gap-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel recording"
        onPress={onCancel}
        hitSlop={6}
        className="h-8 w-8 items-center justify-center rounded-[10px] bg-tertiarySystemFill active:opacity-70"
      >
        <SystemIcon name="xmark" mdName="X" size={13} color="secondaryLabel" />
      </Pressable>
      {/* The waveform alone shows it's listening, so a screen reader is told in words. */}
      <View accessible accessibilityLabel="Recording">
        <RecordingBars
          isRecording
          edgeToEdge
          color={BRAND_GRADIENT[1]}
          height={18}
          numBars={WAVEFORM_BARS}
          barWidth={3}
          barGap={3}
          amplitude={currentAmplitude}
          waveformData={waveformData}
        />
      </View>
    </View>
  );
}

export function ChatComposer({
  value,
  onChangeText,
  placeholder,
  inputLabel = placeholder,
  tall = false,
  busy,
  disabled,
  onSend,
  onMicPress,
  micDisabled = false,
  onStop,
  listening = null,
  transcribing = false,
}: ChatComposerProps): React.JSX.Element {
  const hasText = value.trim().length > 0;
  // A turn the screen doesn't own still locks it, since only one turn runs at a time.
  const locked = disabled || busy;
  // The voice states take the input's place at its resting height, so the composer doesn't jump.
  const fieldHeight = tall ? 'min-h-[60px]' : 'min-h-[40px]';

  const field = listening ? (
    <ListeningField audioRecorder={listening.audioRecorder} onCancel={listening.onCancel} />
  ) : transcribing ? (
    <View className="h-10 justify-center">
      <Text className="text-[16px] text-secondaryLabel">Transcribing…</Text>
    </View>
  ) : null;

  return (
    <View
      className={`flex-row items-end gap-2 bg-secondarySystemGroupedBackground py-2 pr-2 ${
        listening ? 'pl-2' : 'pl-4'
      }`}
      style={styles.container}
    >
      {field ? (
        <View className={`flex-1 justify-end ${fieldHeight}`}>{field}</View>
      ) : (
        <TextInput
          accessibilityLabel={inputLabel}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={iosColor('tertiaryLabel')}
          editable={!locked}
          multiline
          textAlignVertical="top"
          className={`max-h-[120px] flex-1 py-2 text-[16px] leading-[22px] text-label ${fieldHeight}`}
        />
      )}
      {listening ? (
        <ChatGradientButton
          label="Send question"
          disabled={false}
          onPress={listening.onFinish}
          active
        >
          <SystemIcon name="mic.fill" mdName="Mic" size={18} color={CHAT_COLORS.onGradient} />
        </ChatGradientButton>
      ) : busy && onStop ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Stop"
          onPress={onStop}
          hitSlop={2}
          className="items-center justify-center"
          style={styles.stop}
        >
          <View className="h-3.5 w-3.5 rounded-[4px] bg-white" />
        </Pressable>
      ) : hasText ? (
        <ChatGradientButton label="Send" disabled={locked} onPress={onSend}>
          <SystemIcon name="arrow.up" mdName="ArrowUp" size={18} color={CHAT_COLORS.onGradient} />
        </ChatGradientButton>
      ) : (
        <ChatGradientButton
          label="Speak your question"
          disabled={locked || micDisabled}
          onPress={onMicPress}
        >
          <SystemIcon name="mic.fill" mdName="Mic" size={18} color={CHAT_COLORS.onGradient} />
        </ChatGradientButton>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 18,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: CHAT_COLORS.hairline,
  },
  stop: {
    width: COMPOSER_BUTTON_SIZE,
    height: COMPOSER_BUTTON_SIZE,
    borderRadius: COMPOSER_BUTTON_RADIUS,
    borderCurve: 'continuous',
    backgroundColor: CHAT_COLORS.darkFill,
  },
});
