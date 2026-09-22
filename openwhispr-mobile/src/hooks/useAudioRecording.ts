import { useState } from 'react';
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { createTranscriptId, useTranscriptStore } from '../store/useTranscriptStore';
import { useProcessingModeStore } from '../store/useProcessingModeStore';
import { transcribeAndCleanup } from '../lib/transcribeAndCleanup';
import { isLocalModelMissingError } from '../services/transcription/TranscriptionService';
import { analyzeSpeechActivity, createNoSpeechError } from '../lib/speechActivity';
import {
  isMicPermissionError,
  isNoSpeechError,
  MicPermissionError,
  NO_SPEECH_ERROR_MESSAGE,
} from '../lib/permissions';
import { getPreferredTranscriptionLanguage } from '../lib/transcriptionLanguage';
import { toFriendlyTranscriptionErrorMessage } from '../lib/transcriptionErrors';
import { deleteManagedTranscriptAudio, retainTranscriptAudio } from '../lib/transcriptAudio';
import { isUsageLimitError, type UsageLimitError } from '../lib/usageLimitError';
import { randomUUID } from '../lib/uuid';
import type { TranscriptionProvider } from '../types';
import {
  getExpoAudioModule,
  isExpoAudioAvailable,
  getDefaultRecorderOptions,
} from '../utils/expoAudio';
import { useAudioRecorder } from 'expo-audio';

export interface UseAudioRecordingOptions {
  onComplete?: (text: string) => void;
  onError?: (error: Error) => void;
  allowsBackgroundRecording?: boolean;
  // Private mode but the on-device model is unavailable. We never fall back to
  // the cloud silently — the caller prompts, and may invoke retryWithCloud to
  // transcribe the recording we already captured.
  onLocalModelMissing?: (retryWithCloud: () => void) => void;
  // Cloud quota is exhausted. The caller can present billing, refresh backend
  // usage, then invoke retryWithCloud only if quota/subscription now permits it.
  onUsageLimitReached?: (
    error: UsageLimitError,
    retryWithCloud: () => Promise<void>,
  ) => void | Promise<void>;
}

type RetainedRecordingAudio = {
  id: string;
  audioUrl: string;
  audioFileName?: string;
  audioMimeType?: string;
};

const fileNameFromUri = (uri: string): string | undefined => uri.split('/').pop() || undefined;

const mimeTypeFromFileName = (fileName?: string): string | undefined => {
  const extension = fileName?.split('.').pop()?.toLowerCase();
  if (extension === 'wav' || extension === 'wave') return 'audio/wav';
  if (extension === 'm4a') return 'audio/m4a';
  if (extension === 'mp3') return 'audio/mpeg';
  return undefined;
};

export function useAudioRecording(options: UseAudioRecordingOptions = {}) {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentText, setCurrentText] = useState('');

  // Import expo-audio module
  const expoAudio = getExpoAudioModule();
  const addTranscript = useTranscriptStore((state) => state.addTranscript);
  const addFailedTranscript = useTranscriptStore((state) => state.addFailedTranscript);
  const activeMode = useProcessingModeStore((state) => state.activeMode);
  const transcriptionProvider = activeMode === 'private' ? 'local' : 'cloud';

  const recorderOptions = getDefaultRecorderOptions();
  const audioRecorder = useAudioRecorder(recorderOptions);
  const isSupported = isExpoAudioAvailable() && !!audioRecorder;
  const allowsBackgroundRecording = options.allowsBackgroundRecording === true;

  const ensureAudioSupport = () => {
    if (!isSupported || !expoAudio || !audioRecorder) {
      const error = new Error(
        'Audio recording is unavailable in Expo Go. Build and run a development client (e.g. `expo run:ios`) to test recording features.',
      );
      if (__DEV__) {
        console.warn('[audio] Attempted to use recording without native module support.');
      }
      throw error;
    }
    return { expoAudio, audioRecorder };
  };

  const startRecording = async () => {
    try {
      const { expoAudio: audioModule, audioRecorder: recorder } = ensureAudioSupport();

      // Check status before requesting: iOS shows its system dialog only on
      // the very first-ever request for this install. If canAskAgain is
      // already false here, the upcoming request call is guaranteed to
      // return silently with no native UI.
      const priorStatus = await audioModule.AudioModule.getRecordingPermissionsAsync();
      const nativePromptShown = !priorStatus.granted && priorStatus.canAskAgain;

      const { granted, canAskAgain } =
        await audioModule.AudioModule.requestRecordingPermissionsAsync();
      if (!granted) {
        throw new MicPermissionError('Microphone permission not granted', {
          canAskAgain,
          nativePromptShown,
        });
      }

      if (Platform.OS === 'android' && allowsBackgroundRecording) {
        const notificationPermission =
          await audioModule.AudioModule.requestNotificationPermissionsAsync();
        if (!notificationPermission.granted) {
          throw new Error(
            'Notification permission is required to keep recording in the background.',
          );
        }
      }

      try {
        await audioModule.AudioModule.setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
          interruptionMode: 'mixWithOthers',
          shouldPlayInBackground: allowsBackgroundRecording,
          shouldRouteThroughEarpiece: false,
          allowsBackgroundRecording,
        });
      } catch (audioModeError) {
        console.warn('[audio] Failed to set audio mode:', audioModeError);
      }

      // Release any stale state from a previous recording attempt.
      if (recorder.isRecording) {
        try {
          await recorder.stop();
        } catch {}
      }

      await recorder.prepareToRecordAsync(recorderOptions);
      await recorder.record();

      setIsRecording(true);
      setCurrentText('');
    } catch (error) {
      // Permission denial is a normal user state — surfaced by onError as a
      // friendly alert. Skip console.error so dev LogBox doesn't show a red toast.
      if (!isMicPermissionError(error)) {
        console.error('[audio] Start recording error:', error);
      }
      if (error instanceof Error) {
        options.onError?.(error);
      }
      throw error;
    }
  };

  const stopRecording = async () => {
    try {
      const { audioRecorder: recorder } = ensureAudioSupport();

      if (!isRecording) {
        return;
      }

      await recorder.stop();

      const uri = recorder.uri;

      setIsRecording(false);
      setIsProcessing(true);

      if (!uri) {
        throw new Error('No recording URI - recorder may not have started properly');
      }

      const fileInfo = await FileSystem.getInfoAsync(uri).catch((error) => {
        console.warn('[audio] Could not verify recording file:', error);
        return null;
      });

      if (fileInfo) {
        if (!fileInfo.exists) {
          throw new Error(
            'Recording file was not created. Audio recording may not work in the iOS Simulator. Please try on a physical device.',
          );
        }
        if (fileInfo.size === 0) {
          throw new Error(
            'Recording file is empty. No audio was captured. This may be a simulator limitation.',
          );
        }
      }

      const speechAnalysis = await analyzeSpeechActivity(uri, 'recording');
      if (speechAnalysis?.noSpeechLikely) {
        throw createNoSpeechError();
      }
      const clientTranscriptionId = `recording-${randomUUID()}`;

      const retained = await retainRecording(uri);
      try {
        await finalizeRecording(retained, transcriptionProvider, clientTranscriptionId);
      } catch (transcribeError) {
        if (isNoSpeechError(transcribeError)) {
          await deleteManagedTranscriptAudio(retained.audioUrl);
          throw new Error(NO_SPEECH_ERROR_MESSAGE);
        }
        // Private mode with no on-device model. Never upload silently — hand the
        // choice to the caller. The recording is kept so an approved cloud retry
        // can reuse it without re-recording.
        if (
          transcriptionProvider === 'local' &&
          isLocalModelMissingError(transcribeError) &&
          options.onLocalModelMissing
        ) {
          await addFailedRecording(retained, transcriptionProvider, transcribeError);
          options.onLocalModelMissing(() => {
            retryWithCloud(retained, clientTranscriptionId);
          });
          return;
        }
        // Cloud quota exhausted. Keep the recording so an approved retry can
        // reuse it, then hand the billing/retry decision to the caller.
        if (isUsageLimitError(transcribeError) && options.onUsageLimitReached) {
          await addFailedRecording(retained, transcriptionProvider, transcribeError);
          await options.onUsageLimitReached(transcribeError, () =>
            retryWithCloud(retained, clientTranscriptionId),
          );
          return;
        }
        await addFailedRecording(retained, transcriptionProvider, transcribeError);
        throw transcribeError;
      }
    } catch (error) {
      options.onError?.(error as Error);
      throw error;
    } finally {
      setIsProcessing(false);
    }
  };

  const retainRecording = async (uri: string): Promise<RetainedRecordingAudio> => {
    const id = createTranscriptId();
    const audioFileName = fileNameFromUri(uri);
    const audioMimeType = mimeTypeFromFileName(audioFileName);
    const audioUrl = await retainTranscriptAudio(uri, {
      transcriptId: id,
      audioFileName,
      audioMimeType,
    });
    return { id, audioUrl, audioFileName, audioMimeType };
  };

  const addFailedRecording = async (
    retained: RetainedRecordingAudio,
    provider: TranscriptionProvider,
    error: unknown,
  ) => {
    try {
      await addFailedTranscript({
        id: retained.id,
        audioUrl: retained.audioUrl,
        audioFileName: retained.audioFileName,
        audioMimeType: retained.audioMimeType,
        provider,
        requestContext: 'recording',
        errorMessage: toFriendlyTranscriptionErrorMessage(error),
      });
    } catch (failedRowError) {
      if (__DEV__) {
        console.warn('[audio] Failed to save retryable failed transcript:', failedRowError);
      }
    }
  };

  const finalizeRecording = async (
    retained: RetainedRecordingAudio,
    provider: TranscriptionProvider,
    clientTranscriptionId: string,
  ) => {
    const processedResult = await transcribeAndCleanup(
      {
        audioUri: retained.audioUrl,
        provider,
        language: getPreferredTranscriptionLanguage(),
        fileName: retained.audioFileName,
        mimeType: retained.audioMimeType,
        requestContext: 'recording',
        clientTranscriptionId,
      },
      {
        onRawTranscript: (text) => setCurrentText(text),
      },
    );

    if (!processedResult.text.trim()) {
      throw new Error(NO_SPEECH_ERROR_MESSAGE);
    }

    const finalText = processedResult.text;

    await addTranscript({
      id: retained.id,
      text: finalText,
      originalText: processedResult.originalText,
      audioUrl: retained.audioUrl,
      audioFileName: retained.audioFileName,
      audioMimeType: retained.audioMimeType,
      duration: processedResult.transcription.duration,
      provider: processedResult.transcription.provider,
      requestContext: 'recording',
    });

    setCurrentText(finalText);
    options.onComplete?.(finalText);
  };

  // Consented cloud transcription of an already-captured private-mode recording.
  const retryWithCloud = async (
    retained: RetainedRecordingAudio,
    clientTranscriptionId: string,
  ) => {
    setIsProcessing(true);
    try {
      await finalizeRecording(retained, 'cloud', clientTranscriptionId);
    } catch (error) {
      if (isUsageLimitError(error) && options.onUsageLimitReached) {
        await options.onUsageLimitReached(error, () =>
          retryWithCloud(retained, clientTranscriptionId),
        );
        return;
      }
      if (!isNoSpeechError(error)) {
        await addFailedRecording(retained, 'cloud', error);
      }
      options.onError?.(
        isNoSpeechError(error) ? new Error(NO_SPEECH_ERROR_MESSAGE) : (error as Error),
      );
    } finally {
      setIsProcessing(false);
    }
  };

  const cancelRecording = async () => {
    if (audioRecorder?.isRecording) {
      await audioRecorder.stop();
    }
    setIsRecording(false);
    setIsProcessing(false);
    setCurrentText('');
  };

  // Meeting-specific: stops recording and returns the raw URI without running the dictation finalize path.
  const stopRecordingRaw = async (): Promise<string | null> => {
    if (!audioRecorder.isRecording) return null;
    await audioRecorder.stop();
    setIsRecording(false);
    setIsProcessing(false);
    return audioRecorder.uri ?? null;
  };

  return {
    isRecording,
    isProcessing,
    currentText,
    isSupported,
    startRecording,
    stopRecording,
    stopRecordingRaw,
    cancelRecording,
    audioRecorder,
  };
}
