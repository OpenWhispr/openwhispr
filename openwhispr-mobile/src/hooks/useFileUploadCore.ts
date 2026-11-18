import { useState } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { AudioTools } from '../../modules/audio-tools/src';
import {
  isOggOpus,
  isLocalModelMissingError,
} from '../services/transcription/TranscriptionService';
import { createTranscriptId, useTranscriptStore } from '../store/useTranscriptStore';
import {
  snapshotTextInference,
  snapshotTranscriptionJob,
  type TranscriptionJobRoute,
} from '../lib/inferenceRouting';
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

// OpenAI-compatible transcription endpoints pick the decoder from the file
// extension. A file the provider rejects would become a failed row whose retry
// (pinned to the same provider) can never succeed, so it is refused up front.
const PROVIDER_AUDIO_EXTENSIONS = new Set([
  'flac',
  'mp3',
  'mp4',
  'mpeg',
  'mpga',
  'm4a',
  'ogg',
  'wav',
  'webm',
]);

async function assertProviderAcceptsFile(
  file: DocumentPicker.DocumentPickerAsset,
  extension: string | undefined,
): Promise<void> {
  if (!extension || !PROVIDER_AUDIO_EXTENSIONS.has(extension)) {
    throw new Error(
      'Your provider accepts FLAC, MP3, MP4, M4A, OGG, WAV, or WEBM audio. Choose a file in one of those formats.',
    );
  }
  // The picker does not always report a size; the provider's limit is hard.
  const size =
    file.size ??
    (await FileSystem.getInfoAsync(file.uri)
      .then((info) => (info.exists ? info.size : undefined))
      .catch(() => undefined));
  if (size !== undefined && size > MAX_FILE_SIZE) {
    throw new Error(
      `Your provider accepts audio files up to ${MAX_FILE_SIZE_MB} MB. Choose a smaller file.`,
    );
  }
}

// The native module rejects unreadable/unsupported audio with these codes;
// surface a clear instruction instead of the raw AVFoundation error.
const toFriendlyUploadError = (error: unknown): Error => {
  const code = (error as { code?: string })?.code;
  if (code === 'AUDIO_TRANSCODE_ERROR' || code === 'AUDIO_CHUNK_ERROR') {
    return new Error("Couldn't read this audio file. Please try a WAV, MP3, or M4A file.");
  }
  return error instanceof Error ? error : new Error(String(error));
};

export interface FileUploadRequest {
  options: NonNullable<Parameters<typeof transcribeAndCleanup>[1]>;
  check: () => void;
  markError: (error: unknown) => void;
  finish: () => void;
}
export interface FileUploadAttempt {
  snapshotRoute: (route?: TranscriptionJobRoute) => TranscriptionJobRoute;
  picked: (result: DocumentPicker.DocumentPickerResult) => void;
  check: () => void;
  isCurrent: () => boolean;
  resetStage: () => void;
  discardFailure: (error: unknown) => boolean;
  saveToHistory: () => boolean;
  beginRequest: (provider: TranscriptionProvider) => FileUploadRequest;
  beginRetry: () => boolean;
  finishRetry: () => void;
  isAbort: (error: unknown) => boolean;
  ignoreError: (error: unknown) => boolean;
  finish: () => Promise<void>;
}
export interface FileUploadLifecycle {
  stage: 'transcribing' | 'cleaning';
  cancel: () => void;
  allowsLocalOpus: boolean;
  begin: () => FileUploadAttempt | null;
  failedIdentity: (clientTranscriptionId: string) => { clientTranscriptionId: string };
  toFriendlyError: (error: unknown) => Error;
}
export interface FileUploadState {
  setIsProcessing: (processing: boolean) => void;
  setCurrentText: (text: string) => void;
}
export type CommonFileUploadOptions = Omit<UseFileUploadOptions, 'onComplete'>;

export function useFileUploadCore<
  Options extends CommonFileUploadOptions,
  Lifecycle extends FileUploadLifecycle | undefined,
>(
  options: Options,
  useLifecycle: (options: Options, state: FileUploadState) => Lifecycle,
  onComplete: (text: string, fileName: string) => void,
) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentText, setCurrentText] = useState('');
  const lifecycle = useLifecycle(options, { setIsProcessing, setCurrentText });
  const addTranscript = useTranscriptStore((state) => state.addTranscript);
  const addFailedTranscript = useTranscriptStore((state) => state.addFailedTranscript);

  const pickAndTranscribeFile = async (route?: TranscriptionJobRoute) => {
    const attempt = lifecycle?.begin();
    if (lifecycle && !attempt) return;
    try {
      const pickedRoute = attempt?.snapshotRoute(route);
      const pinnedProvider = pickedRoute?.provider;
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

      attempt?.picked(result);

      if (result.canceled) {
        return;
      }

      let jobRoute = pickedRoute ?? snapshotTranscriptionJob('upload');
      const transcriptionProvider = pinnedProvider ?? jobRoute.provider;
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

      if (transcriptionProvider === 'byok') {
        await assertProviderAcceptsFile(file, extension);
      }

      attempt?.check();

      // On-device Opus decoding isn't supported yet; the cloud transcriber
      // decodes Opus, so route private-mode Opus uploads there instead.
      if (
        !lifecycle?.allowsLocalOpus &&
        transcriptionProvider === 'local' &&
        isOggOpus(file.name, file.mimeType, file.uri)
      ) {
        throw new Error(
          "Opus audio can't be transcribed on this iPhone yet. Set Uploads to OpenWhispr Cloud in Account → AI Models, then try again.",
        );
      }

      setCurrentText('');
      attempt?.resetStage();
      const transcriptId = createTranscriptId();
      const clientTranscriptionId = `file-${randomUUID()}`;
      const retainedAudioUrl = await retainTranscriptAudio(file.uri, {
        transcriptId,
        audioFileName: file.name,
        audioMimeType: file.mimeType,
      });

      const addFailedUpload = async (provider: TranscriptionProvider, error: unknown) => {
        if (attempt ? attempt.discardFailure(error) : isNoSpeechError(error)) {
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
            inferenceRoute: provider === 'byok' ? jobRoute.inferenceRoute : undefined,
            cleanupRoute: jobRoute.cleanupRoute,
            cleanupUnavailable: jobRoute.cleanupUnavailable,
            requestContext: 'file',
            jobId: transcriptId,
            ...lifecycle?.failedIdentity(clientTranscriptionId),
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
        const request = attempt?.beginRequest(provider);
        let audioUri = retainedAudioUrl;
        const tempUris: string[] = [];
        try {
          attempt?.check();
          if (provider === 'local' && AudioTools.isAvailable()) {
            const transcoded = await AudioTools.transcodeToWav(retainedAudioUrl);
            audioUri = transcoded.uri;
            tempUris.push(transcoded.uri);
          }

          attempt?.check();
          const processedResult = await transcribeAndCleanup(
            {
              ...jobRoute,
              audioUri,
              provider,
              inferenceRoute: provider === 'byok' ? jobRoute.inferenceRoute : undefined,
              cleanupRoute: jobRoute.cleanupRoute,
              cleanupUnavailable: jobRoute.cleanupUnavailable,
              fileName: file.name,
              mimeType: file.mimeType,
              language: getPreferredTranscriptionLanguage(),
              requestContext: 'file',
              purpose: 'upload',
              jobId: transcriptId,
              clientTranscriptionId,
            },
            request?.options ?? {
              onRawTranscript: (text) => setCurrentText(text),
            },
          );
          request?.check();
          const finalText = processedResult.text;

          if (attempt?.saveToHistory() !== false)
            await addTranscript({
              id: transcriptId,
              text: finalText,
              originalText: processedResult.originalText,
              audioUrl: retainedAudioUrl,
              audioFileName: file.name,
              audioMimeType: file.mimeType,
              duration: processedResult.transcription.duration,
              provider: processedResult.transcription.provider,
              inferenceRoute: processedResult.transcription.inferenceRoute,
              cleanupRoute: processedResult.transcription.cleanupRoute,
              cleanupUnavailable: processedResult.transcription.cleanupUnavailable,
              cleanupWarning: processedResult.transcription.cleanupWarning,
              requestContext: 'file',
              jobId: transcriptId,
            });

          attempt?.check();
          setCurrentText(finalText);
          onComplete(finalText, file.name);
          if (attempt?.saveToHistory() === false)
            await deleteManagedTranscriptAudio(retainedAudioUrl);
        } catch (error) {
          request?.markError(error);
          throw error;
        } finally {
          request?.finish();
          await AudioTools.cleanup(tempUris);
        }
      };

      const retryWithCloud = async () => {
        if (attempt && !attempt.beginRetry()) return;
        setIsProcessing(true);
        try {
          jobRoute = { provider: 'cloud', ...snapshotTextInference('cloud') };
          await runTranscription('cloud');
        } catch (retryError) {
          if (attempt?.isAbort(retryError)) return;
          if (isUsageLimitError(retryError) && options.onUsageLimitReached) {
            await options.onUsageLimitReached(retryError, retryWithCloud);
            return;
          }
          addFailedUpload('cloud', retryError).catch(() => undefined);
          options.onError?.(
            lifecycle ? lifecycle.toFriendlyError(retryError) : toFriendlyUploadError(retryError),
          );
        } finally {
          if (attempt) attempt.finishRetry();
          else setIsProcessing(false);
        }
      };

      setIsProcessing(true);
      try {
        await runTranscription(transcriptionProvider);
      } catch (error) {
        if (attempt && !attempt.isCurrent()) {
          await deleteManagedTranscriptAudio(retainedAudioUrl);
          return;
        }
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
      if (attempt?.ignoreError(error)) return;
      const friendly = lifecycle ? lifecycle.toFriendlyError(error) : toFriendlyUploadError(error);
      options.onError?.(friendly);
      throw friendly;
    } finally {
      if (attempt) await attempt.finish();
      else setIsProcessing(false);
    }
  };

  return { upload: { isProcessing, currentText, pickAndTranscribeFile }, lifecycle };
}
