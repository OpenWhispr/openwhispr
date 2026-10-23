import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Alert } from 'react-native';
import type { AudioRecorder } from 'expo-audio';
import { useAudioRecording } from '@/hooks/useAudioRecording';
import { useUsageLimitRecovery } from '@/hooks/useUsageLimitRecovery';
import { isChatEnabled } from '@/lib/dictationAgent';
import {
  isMicPermissionError,
  isNoSpeechError,
  NO_SPEECH_ERROR_MESSAGE,
  showMicPermissionAlert,
} from '@/lib/permissions';
import { promptLocalModelFallback } from '@/lib/privateMode';
import { safeHaptics } from '@/lib/utils';
import { useChatStore, type ChatPending } from '@/store/useChatStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { useUsageStore } from '@/store/useUsageStore';
import type { UsageLimitError } from '@/lib/usageLimitError';

export interface ChatVoiceInput {
  state: 'idle' | 'listening' | 'transcribing';
  elapsedSeconds: number;
  // A cancelled question is still being transcribed in the background, so the mic refuses.
  isSettling: boolean;
  // Briefly true after a question in which no speech was heard, so the screen can say so.
  noSpeechHeard: boolean;
  audioRecorder: AudioRecorder;
  // Resolves false when it refused (a turn is pending, or a cancelled transcription is still
  // settling) or the recorder failed to start.
  start: (allowCloudFallback: boolean) => Promise<boolean>;
  finish: () => Promise<void>;
  cancel: () => Promise<void>;
}

interface UseChatVoiceInputOptions {
  conversationId: string | null;
  onSent?: (conversationId: string) => void;
  /**
   * Gets a transcript to keep in the composer instead of sending it: the chat route changed since
   * the mic opened, or a failed chat wipe refused the send.
   */
  onNotSent: (text: string) => void;
  /** Whether the screen is still showing; a mic that opens after it isn't is closed again. */
  isFocused: () => boolean;
}

// Long enough to read the notice, short enough that it's gone before the next question.
const NO_SPEECH_NOTICE_MS = 3_000;

interface TranscribingSlot {
  generation: number;
  pending: ChatPending | null;
}

// The send gate's checks (account, paywall, Local Mode consent) depend on the route and the mode,
// so a question is sent only on the route they were run for, and only while Chat is still on.
const currentGateRoute = (): string => {
  const { config } = useConfigStore.getState();
  return `${isChatEnabled(config)}:${config?.inference?.noteChat?.mode ?? ''}:${
    useProcessingModeStore.getState().activeMode
  }`;
};

export function useChatVoiceInput({
  conversationId,
  onSent,
  onNotSent,
  isFocused,
}: UseChatVoiceInputOptions): ChatVoiceInput {
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [noSpeechHeard, setNoSpeechHeard] = useState(false);
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  const onSentRef = useRef(onSent);
  onSentRef.current = onSent;
  const onNotSentRef = useRef(onNotSent);
  onNotSentRef.current = onNotSent;
  const isFocusedRef = useRef(isFocused);
  isFocusedRef.current = isFocused;
  const allowCloudFallbackRef = useRef(false);
  const gateRouteRef = useRef('');
  // A second tap while the recorder is still starting would open a second recording.
  const startingRef = useRef(false);
  // Bumped by cancel, so a transcript that lands afterwards is ignored.
  const generationRef = useRef(0);
  // The generation of the question being transcribed. It no longer matches once that question is
  // stopped, and whatever its transcription reports afterwards (a prompt, a paywall, an error) is
  // dropped unseen.
  const questionGenerationRef = useRef(0);
  const slotRef = useRef<TranscribingSlot | null>(null);
  const { handleUsageLimitReached } = useUsageLimitRecovery();

  // The slot is ours only while it is the exact pending entry we created: a cancel, delete,
  // sign-out or another turn replaces or clears it.
  const ownsSlot = (): boolean => {
    const slot = slotRef.current;
    return (
      !!slot &&
      slot.generation === generationRef.current &&
      useChatStore.getState().pending === slot.pending
    );
  };

  const takeSlot = (): boolean => {
    if (!useChatStore.getState().beginTranscribing(conversationIdRef.current)) return false;
    generationRef.current += 1;
    questionGenerationRef.current = generationRef.current;
    slotRef.current = {
      generation: generationRef.current,
      pending: useChatStore.getState().pending,
    };
    setIsTranscribing(true);
    return true;
  };

  const releaseSlot = (): void => {
    if (ownsSlot()) useChatStore.getState().endTranscribing();
    slotRef.current = null;
    setIsTranscribing(false);
  };

  const isStopped = (): boolean => questionGenerationRef.current !== generationRef.current;

  const sendTranscript = (text: string): void => {
    if (!ownsSlot()) {
      // A delete or sign-out cleared the store's entry, so this screen stops showing it too.
      if (slotRef.current?.generation === generationRef.current) releaseSlot();
      return;
    }
    const targetId = conversationIdRef.current;
    // The screen moved to another conversation while this question was transcribing.
    const movedAway = useChatStore.getState().pending?.conversationId !== targetId;
    releaseSlot();
    if (movedAway) return;
    if (currentGateRoute() !== gateRouteRef.current) {
      onNotSentRef.current(text);
      return;
    }
    const result = useChatStore.getState().send(text, {
      conversationId: targetId,
      allowCloudFallback: allowCloudFallbackRef.current,
    });
    if (result) onSentRef.current?.(result.conversationId);
    else if (useChatStore.getState().sendBlockedByWipe) onNotSentRef.current(text);
  };

  const recording = useAudioRecording({
    saveToHistory: false,
    onComplete: (text) => {
      // The words were spent even if the transcript is dropped below.
      if (useProcessingModeStore.getState().activeMode === 'cloud') {
        useUsageStore.getState().load(true);
      }
      sendTranscript(text);
    },
    onError: (error) => {
      if (isStopped()) return;
      releaseSlot();
      if (isMicPermissionError(error)) {
        // iOS already showed its own prompt; only point to Settings when it couldn't.
        if (!error.nativePromptShown) showMicPermissionAlert();
        return;
      }
      if (isNoSpeechError(error)) {
        setNoSpeechHeard(true);
        if (isFocusedRef.current()) {
          AccessibilityInfo.announceForAccessibility(NO_SPEECH_ERROR_MESSAGE);
        }
        return;
      }
      Alert.alert('Couldn’t hear that', error.message);
    },
    // The slot is released while the prompt is up (finish releases it) and taken again only if
    // the user picks the cloud; any other answer drops the question and its recording.
    onLocalModelMissing: (retryWithCloud, discard) => {
      const drop = (): void => {
        discard().catch(() => undefined);
      };
      if (isStopped()) {
        drop();
        return;
      }
      promptLocalModelFallback(() => {
        if (takeSlot()) retryWithCloud();
        else drop();
      }, drop);
    },
    onUsageLimitReached: async (
      error: UsageLimitError,
      retryWithCloud: () => Promise<void>,
    ): Promise<void> => {
      // The recording is discarded once this returns without a retry.
      if (isStopped()) return;
      await handleUsageLimitReached(error, retryWithCloud);
      releaseSlot();
    },
  });

  // The slot is taken before the recorder finishes stopping, so transcribing wins.
  const state: ChatVoiceInput['state'] = isTranscribing
    ? 'transcribing'
    : recording.isRecording
      ? 'listening'
      : 'idle';

  useEffect(() => {
    if (!noSpeechHeard) return undefined;
    const timer = setTimeout(() => setNoSpeechHeard(false), NO_SPEECH_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [noSpeechHeard]);

  useEffect(() => {
    if (state !== 'listening') return undefined;
    setElapsedSeconds(0);
    const timer = setInterval(() => setElapsedSeconds((seconds) => seconds + 1), 1000);
    return () => clearInterval(timer);
  }, [state]);

  const start = async (allowCloudFallback: boolean): Promise<boolean> => {
    // A cancelled transcription still delivers its text later, which must not land in a new slot.
    if (
      startingRef.current ||
      useChatStore.getState().pending ||
      recording.isRecording ||
      recording.isProcessing
    ) {
      return false;
    }
    startingRef.current = true;
    // A new question: whatever stopped one left behind has settled, since start refuses until then.
    questionGenerationRef.current = generationRef.current;
    setNoSpeechHeard(false);
    allowCloudFallbackRef.current = allowCloudFallback;
    gateRouteRef.current = currentGateRoute();
    try {
      await recording.startRecording();
    } catch {
      // Failures already reached onError.
      return false;
    } finally {
      startingRef.current = false;
    }
    // The screen was left while the recorder started, so nobody would see it listening.
    if (!isFocusedRef.current()) {
      // start promises a boolean, and a mic that won't close has nothing left to report.
      await recording.cancelRecording().catch(() => undefined);
      return false;
    }
    return true;
  };

  const finish = async (): Promise<void> => {
    // A slot means a finish is already stopping the recorder.
    if (slotRef.current || state !== 'listening') return;
    if (!takeSlot()) {
      // Another turn took the slot while this question was spoken, so it's dropped; the tap says so.
      safeHaptics('light');
      await recording.cancelRecording();
      return;
    }
    const slot = slotRef.current;
    try {
      await recording.stopRecording();
    } catch {
      // Failures already reached onError.
    } finally {
      // Covers every exit that sent nothing; a slot taken since (a cloud retry) isn't ours to end.
      if (slotRef.current === slot) releaseSlot();
    }
  };

  const cancel = async (): Promise<void> => {
    if (slotRef.current) {
      // Covers the native stop window too, when the recorder still reports recording.
      releaseSlot();
      generationRef.current += 1;
    }
    if (recording.isRecording) await recording.cancelRecording();
  };

  return {
    state,
    elapsedSeconds,
    isSettling: recording.isProcessing && state === 'idle',
    noSpeechHeard,
    audioRecorder: recording.audioRecorder,
    start,
    finish,
    cancel,
  };
}
