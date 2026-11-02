import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Alert } from 'react-native';
import type { AudioRecorder } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
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
  // A cancelled question's transcription request is still under way, so the mic refuses.
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

// A released recorder throws on any read.
const readRecorder = <T>(read: () => T, fallback: T): T => {
  try {
    return read();
  } catch {
    return fallback;
  }
};

const refreshCloudUsage = (): void => {
  if (useProcessingModeStore.getState().activeMode === 'cloud') {
    useUsageStore.getState().load(true);
  }
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
  const fallbackSlotRef = useRef<TranscribingSlot | null>(null);
  // The file a question is being spoken into, until it is cancelled or handed off to be
  // transcribed. A screen that unmounts mid-question releases the recorder before its own cleanup
  // can cancel it, and a released recorder can't be asked for its file, so it is kept here.
  const listeningUriRef = useRef<string | null>(null);
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

  // The slot is let go before the store hears of it, so the subscription below never takes our own
  // release for a delete or sign-out.
  const releaseSlot = (): void => {
    const owned = ownsSlot();
    fallbackSlotRef.current = null;
    slotRef.current = null;
    if (owned) useChatStore.getState().endTranscribing();
    setIsTranscribing(false);
  };

  // A delete, a sign-out or a Stop clears the store's entry under a question still transcribing. It
  // is stopped then too, so no retry, alert or Cloud prompt follows for a chat that has gone.
  useEffect(
    () =>
      useChatStore.subscribe((state) => {
        const slot = slotRef.current;
        if (!slot || slot.generation !== generationRef.current || state.pending === slot.pending) {
          return;
        }
        generationRef.current += 1;
        slotRef.current = null;
        setIsTranscribing(false);
      }),
    [],
  );

  useEffect(
    () => () => {
      const uri = listeningUriRef.current;
      if (uri) FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
    },
    [],
  );

  // Unmounted screens no longer subscribe, but their in-flight work still checks ownership.
  const isStopped = (): boolean =>
    questionGenerationRef.current !== generationRef.current ||
    (slotRef.current !== null && !ownsSlot());

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
    else if (useChatStore.getState().sendBlocked) onNotSentRef.current(text);
  };

  const recording = useAudioRecording({
    saveToHistory: false,
    // A spoken question goes to the chat as it was said: dictation cleanup would rewrite it, and in
    // Local Mode its Cloud default would take it off this iPhone on a route the chat never offered.
    cleanup: false,
    // A stopped question gets no transcription retries, so the mic is back once the request
    // already under way ends, and nothing more is spent on it.
    shouldCancel: isStopped,
    onComplete: (text) => {
      // The words were spent even if the transcript is dropped below.
      refreshCloudUsage();
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
    // Keep the same slot through consent: a late approval cannot revive a cancelled question.
    onLocalModelMissing: (retryWithCloud, discard) => {
      const slot = slotRef.current;
      const drop = (): void => {
        if (slotRef.current === slot) releaseSlot();
        discard().catch(() => undefined);
      };
      if (isStopped() || !ownsSlot()) {
        drop();
        return;
      }
      fallbackSlotRef.current = slot;
      promptLocalModelFallback(() => {
        if (slotRef.current !== slot || isStopped() || !ownsSlot()) {
          drop();
          return;
        }
        fallbackSlotRef.current = null;
        retryWithCloud();
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
    // The send gate awaits paywalls first, so a second tap can arrive here after the first opened
    // the mic, and a tap from a screen left meanwhile would open the mic, or ask for it, unseen. The
    // recorder itself is asked, since this render's copy of its state may be stale.
    if (
      startingRef.current ||
      listeningUriRef.current !== null ||
      !isFocusedRef.current() ||
      useChatStore.getState().pending ||
      readRecorder(() => recording.audioRecorder.isRecording, false) ||
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
    listeningUriRef.current = readRecorder(() => recording.audioRecorder.uri ?? null, null);
    // The screen was left while the recorder started, so nobody would see it listening.
    if (!isFocusedRef.current()) {
      listeningUriRef.current = null;
      // start promises a boolean, and a mic that won't close has nothing left to report.
      await recording.cancelRecording().catch(() => undefined);
      return false;
    }
    return true;
  };

  const finish = async (): Promise<void> => {
    // A slot means a finish is already stopping the recorder.
    if (slotRef.current || state !== 'listening') return;
    // The recording is the transcription's, or the cancel's below, to clean up from here.
    listeningUriRef.current = null;
    if (!takeSlot()) {
      // Another turn took the slot while this question was spoken, so it's dropped; the tap says so.
      safeHaptics('light');
      await recording.cancelRecording();
      return;
    }
    const slot = slotRef.current;
    try {
      await recording.stopRecording();
      // A question stopped after its transcription came back never reaches onComplete, but the
      // words were still spent.
      if (isStopped()) refreshCloudUsage();
    } catch {
      // Failures already reached onError.
    } finally {
      // A fallback dialog keeps this question's slot until it is declined or its retry finishes.
      if (slotRef.current === slot && fallbackSlotRef.current !== slot) releaseSlot();
    }
  };

  const cancel = async (): Promise<void> => {
    listeningUriRef.current = null;
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
