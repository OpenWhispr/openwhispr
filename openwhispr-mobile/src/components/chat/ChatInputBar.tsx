import { useRef } from 'react';
import { View, type TextInput } from 'react-native';
import type { ChatVoiceInput } from '@/hooks/useChatVoiceInput';
import { useKeyboardHeight } from '@/hooks/useKeyboardHeight';
import { NO_SPEECH_ERROR_MESSAGE } from '@/lib/permissions';
import { safeHaptics } from '@/lib/utils';
import { ChatComposer } from './ChatComposer';
import { ChatComposerNotice } from './ChatComposerNotice';

const COMPOSER_KEYBOARD_GAP = 10;
// The listening mic and Stop share a spot, so a double tap on the mic would stop the question it
// just sent.
const STOP_AFTER_SEND_GRACE_MS = 500;

export type StartVoice = (allowCloudFallback: boolean) => void;

interface ChatInputBarProps {
  voice: ChatVoiceInput;
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  /** Names the input when the placeholder is only an example question. */
  inputLabel?: string;
  /** Two lines tall at rest, for a screen built around the composer. */
  tall?: boolean;
  busy: boolean;
  /** Whether the busy turn or transcription is this screen's own, so Stop can end it. */
  canStop: boolean;
  disabled: boolean;
  onSend: () => void;
  /** Runs the screen's checks, then calls `startVoice` to open the mic. */
  onMicPress: (startVoice: StartVoice) => void;
  /** Stops the turn that's working; a transcribing question is stopped here. */
  onCancelTurn: () => void;
  /** Space below the bar while the keyboard is hidden. */
  restingBottomPadding: number;
  /** Shown above the composer and kept above the keyboard with it, e.g. suggestions. */
  accessory?: React.ReactNode;
  /** A line above the composer, e.g. naming the chat that's working. */
  notice?: React.ReactNode;
  inputRef?: React.Ref<TextInput>;
}

/** The composer, which also listens to a spoken question, kept above the keyboard. */
export function ChatInputBar({
  voice,
  value,
  onChangeText,
  placeholder,
  inputLabel,
  tall,
  busy,
  canStop,
  disabled,
  onSend,
  onMicPress,
  onCancelTurn,
  restingBottomPadding,
  accessory,
  notice,
  inputRef,
}: ChatInputBarProps): React.JSX.Element {
  const keyboardHeight = useKeyboardHeight();
  const finishedAtRef = useRef(0);

  const startVoice: StartVoice = (allowCloudFallback) => {
    voice.start(allowCloudFallback).then((started) => {
      if (!started) safeHaptics('light');
    });
  };

  const handleFinish = (): void => {
    finishedAtRef.current = Date.now();
    voice.finish().catch(() => undefined);
  };

  const handleStop = (): void => {
    // A quick transcription can already be working when the second tap lands.
    if (Date.now() - finishedAtRef.current < STOP_AFTER_SEND_GRACE_MS) return;
    if (voice.state === 'transcribing') voice.cancel().catch(() => undefined);
    else onCancelTurn();
  };

  return (
    <View
      className="px-4 pt-2"
      style={{
        paddingBottom:
          keyboardHeight > 0 ? keyboardHeight + COMPOSER_KEYBOARD_GAP : restingBottomPadding,
      }}
    >
      {accessory}
      {notice ??
        (voice.noSpeechHeard ? <ChatComposerNotice label={NO_SPEECH_ERROR_MESSAGE} /> : null)}
      <ChatComposer
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        inputLabel={inputLabel}
        tall={tall}
        busy={busy}
        disabled={disabled}
        onSend={onSend}
        onMicPress={() => onMicPress(startVoice)}
        micDisabled={voice.isSettling}
        onStop={canStop ? handleStop : undefined}
        listening={
          voice.state === 'listening'
            ? {
                audioRecorder: voice.audioRecorder,
                onCancel: () => voice.cancel().catch(() => undefined),
                onFinish: handleFinish,
              }
            : null
        }
        transcribing={voice.state === 'transcribing'}
        inputRef={inputRef}
      />
    </View>
  );
}
