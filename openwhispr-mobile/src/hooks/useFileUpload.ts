import { useState } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import { AudioTools } from '../../modules/audio-tools/src';
import {
  isOggOpus,
  isLocalModelMissingError,
} from '../services/transcription/TranscriptionService';
import { createTranscriptId, useTranscriptStore } from '../store/useTranscriptStore';
import { useProcessingModeStore } from '../store/useProcessingModeStore';
import { transcribeAndCleanup } from '../lib/transcribeAndCleanup';
import { getPreferredTranscriptionLanguage } from '../lib/transcriptionLanguage';
import { toFriendlyTranscriptionErrorMessage } from '../lib/transcriptionErrors';
import { isNoSpeechError } from '../lib/permissions';
import { deleteManagedTranscriptAudio, retainTranscriptAudio } from '../lib/transcriptAudio';
import { isUsageLimitError, type UsageLimitError } from '../lib/usageLimitError';
import { randomUUID } from '../lib/uuid';
import { MAX_FILE_SIZE } from '../config/constants';
import type { TranscriptionProvider } from '../types';

export interface UseFileUploadOptions {
  onComplete?: (text: string) => void;
  onError?: (error: Error) => void;
  // Private mode but the on-device model is unavailable. We never upload
  // silently — the caller prompts, and may invoke retryWithCloud to transcribe
  // the picked file in the cloud instead.
  onLocalModelMissing?: (retryWithCloud: () => void) => void;
  // Cloud quota is exhausted. The caller can present billing, refresh backend
  // usage, then invoke retryWithCloud only if quota/subscription now permits it.
  onUsageLimitReached?: (
    error: UsageLimitError,
    retryWithCloud: () => Promise<void>,
  ) => void | Promise<void>;
}

const MAX_FILE_SIZE_MB = Math.round(MAX_FILE_SIZE / (1024 * 1024));

// The native module rejects unreadable/unsupported audio with these codes;
// surface a clear instruction instead of the raw AVFoundation error.
const toFriendlyUploadError = (error: unknown): Error => {
  const code = (error as { code?: string })?.code;
  if (code === 'AUDIO_TRANSCODE_ERROR' || code === 'AUDIO_CHUNK_ERROR') {
    return new Error("Couldn't read this audio file. Please try a WAV, MP3, or M4A file.");
  }
  return error instanceof Error ? error : new Error(String(error));
};

export function useFileUpload(options: UseFileUploadOptions = {}) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentText, setCurrentText] = useState('');
  const addTranscript = useTranscriptStore((state) => state.addTranscript);
  const addFailedTranscript = useTranscriptStore((state) => state.addFailedTranscript);
  const activeMode = useProcessingModeStore((state) => state.activeMode);
  const transcriptionProvider = activeMode === 'private' ? 'local' : 'cloud';

  const pickAndTranscribeFile = async () => {
    try {
      const allowedMimeTypes = new Set([
        'audio/wav',
        'audio/x-wav',
        'audio/wave',
        'audio/mpeg',
        'audio/mp3',
        'audio/mp4',
        'audio/m4a',
        'audio/aac',
        'audio/ogg',
        'audio/opus',
        'audio/webm',
      ]);
      const allowedExtensions = new Set(['wav', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'webm']);

      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });

      if (result.canceled) {
        return;
      }

      const file = result.assets[0];

      const extension = file.name?.includes('.')
        ? file.name.split('.').pop()?.toLowerCase()
        : undefined;
      const isMimeAllowed = file.mimeType ? allowedMimeTypes.has(file.mimeType) : false;
      const isExtensionAllowed = extension ? allowedExtensions.has(extension) : false;

      if (!isMimeAllowed && !isExtensionAllowed) {
        throw new Error(
          'Unsupported file type. Please select a WAV, MP3, M4A, AAC, OGG/Opus, or WEBM audio file.',
        );
      }

      if (!file.uri) {
        throw new Error('No file selected');
      }

      if (file.size && file.size > MAX_FILE_SIZE) {
        throw new Error(
          `File is too large. Please select an audio file under ${MAX_FILE_SIZE_MB}MB.`,
        );
      }

      // On-device Opus decoding isn't supported yet; the cloud transcriber
      // decodes Opus, so route private-mode Opus uploads there instead.
      if (transcriptionProvider === 'local' && isOggOpus(file.name, file.mimeType, file.uri)) {
        throw new Error(
          'Opus audio can only be transcribed in Cloud mode right now. Switch to Cloud mode and try again.',
        );
      }

      setCurrentText('');
      const transcriptId = createTranscriptId();
      const clientTranscriptionId = `file-${randomUUID()}`;
      const retainedAudioUrl = await retainTranscriptAudio(file.uri, {
        transcriptId,
        audioFileName: file.name,
        audioMimeType: file.mimeType,
      });

      const addFailedUpload = async (provider: TranscriptionProvider, error: unknown) => {
        if (isNoSpeechError(error)) {
          await deleteManagedTranscriptAudio(retainedAudioUrl);
          return;
        }
        try {
          await addFailedTranscript({
            id: transcriptId,
            audioUrl: retainedAudioUrl,
            audioFileName: file.name,
            audioMimeType: file.mimeType,
            provider,
            requestContext: 'file',
            errorMessage: toFriendlyTranscriptionErrorMessage(error),
          });
        } catch (failedRowError) {
          if (__DEV__) {
            console.warn('[upload] Failed to save retryable failed transcript:', failedRowError);
          }
        }
      };

      // whisper.rn only reads 16kHz mono WAV, so compressed uploads must be
      // transcoded before local transcription. Cloud sends the original file.
      const runTranscription = async (provider: TranscriptionProvider) => {
        let audioUri = retainedAudioUrl;
        const tempUris: string[] = [];
        try {
          if (provider === 'local' && AudioTools.isAvailable()) {
            const transcoded = await AudioTools.transcodeToWav(retainedAudioUrl);
            audioUri = transcoded.uri;
            tempUris.push(transcoded.uri);
          }

          const processedResult = await transcribeAndCleanup(
            {
              audioUri,
              provider,
              fileName: file.name,
              mimeType: file.mimeType,
              language: getPreferredTranscriptionLanguage(),
              requestContext: 'file',
              clientTranscriptionId,
            },
            {
              onRawTranscript: (text) => setCurrentText(text),
            },
          );
          const finalText = processedResult.text;

          await addTranscript({
            id: transcriptId,
            text: finalText,
            originalText: processedResult.originalText,
            audioUrl: retainedAudioUrl,
            audioFileName: file.name,
            audioMimeType: file.mimeType,
            duration: processedResult.transcription.duration,
            provider: processedResult.transcription.provider,
            requestContext: 'file',
          });

          setCurrentText(finalText);
          options.onComplete?.(finalText);
        } finally {
          await AudioTools.cleanup(tempUris);
        }
      };

      const retryWithCloud = async () => {
        setIsProcessing(true);
        try {
          await runTranscription('cloud');
        } catch (retryError) {
          if (isUsageLimitError(retryError) && options.onUsageLimitReached) {
            await options.onUsageLimitReached(retryError, retryWithCloud);
            return;
          }
          addFailedUpload('cloud', retryError).catch(() => undefined);
          options.onError?.(toFriendlyUploadError(retryError));
        } finally {
          setIsProcessing(false);
        }
      };

      setIsProcessing(true);
      try {
        await runTranscription(transcriptionProvider);
      } catch (error) {
        // Private mode with no on-device model. Don't upload silently — let the
        // caller prompt, then transcribe the picked file in the cloud if approved.
        if (
          transcriptionProvider === 'local' &&
          isLocalModelMissingError(error) &&
          options.onLocalModelMissing
        ) {
          await addFailedUpload(transcriptionProvider, error);
          options.onLocalModelMissing(retryWithCloud);
          return;
        }
        // Cloud quota exhausted. Persist the retryable upload, then let the
        // caller present billing and re-run the cloud transcription if approved.
        if (isUsageLimitError(error) && options.onUsageLimitReached) {
          await addFailedUpload(transcriptionProvider, error);
          await options.onUsageLimitReached(error, retryWithCloud);
          return;
        }
        await addFailedUpload(transcriptionProvider, error);
        throw error;
      }
    } catch (error) {
      const friendly = toFriendlyUploadError(error);
      options.onError?.(friendly);
      throw friendly;
    } finally {
      setIsProcessing(false);
    }
  };

  return {
    isProcessing,
    currentText,
    pickAndTranscribeFile,
  };
}
