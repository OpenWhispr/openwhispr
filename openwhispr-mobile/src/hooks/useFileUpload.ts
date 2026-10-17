import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
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
  onComplete?: (text: string, fileName: string) => void;
  /** Notes imports save into their pinned destination instead of dictation history. */
  saveToHistory?: boolean;
  /** Rechecked after async work and before processing or writing any result. */
  isCurrent?: () => boolean;
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

export function useFileUpload(options: UseFileUploadOptions = {}) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentText, setCurrentText] = useState('');
  const [stage, setStage] = useState<'transcribing' | 'cleaning'>('transcribing');
  const active = useRef<{ controller: AbortController; provider: TranscriptionProvider } | null>(
    null,
  );
  const mounted = useRef(true);
  const generation = useRef(0);
  const busy = useRef(false);
  const cancel = useCallback(() => {
    generation.current += 1;
    const job = active.current;
    job?.controller.abort();
    if (job?.provider === 'local') {
      import('../services/transcription/LocalTranscriptionService')
        .then(({ LocalTranscriptionService }) => {
          if (active.current === job) return LocalTranscriptionService.cancelTranscription();
        })
        .catch(() => undefined);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel();
    };
  }, [cancel]);
  const addTranscript = useTranscriptStore((state) => state.addTranscript);
  const addFailedTranscript = useTranscriptStore((state) => state.addFailedTranscript);

  const pickAndTranscribeFile = async (route?: TranscriptionJobRoute) => {
    if (busy.current || !mounted.current || options.isCurrent?.() === false) return;
    busy.current = true;
    const jobGeneration = ++generation.current;
    const isCurrent = () =>
      mounted.current && generation.current === jobGeneration && options.isCurrent?.() !== false;
    const assertCurrent = () => {
      if (!isCurrent()) throw Object.assign(new Error('Upload cancelled'), { name: 'AbortError' });
    };
    setIsProcessing(true);
    let pickerCacheUri: string | undefined;
    try {
      // Freeze the choice before the system picker or any other async interaction.
      let jobRoute = route ?? snapshotTranscriptionJob('upload');
      const transcriptionProvider = jobRoute.provider;
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
      // A late picker result still owns an app-cache copy. Never delete the
      // external source document; the retained retry copy has its own lifecycle.
      const pickedUri = result.canceled ? undefined : result.assets[0]?.uri;
      if (
        pickedUri &&
        FileSystem.cacheDirectory &&
        pickedUri.startsWith(FileSystem.cacheDirectory)
      ) {
        pickerCacheUri = pickedUri;
      }
      assertCurrent();

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

      if (transcriptionProvider === 'byok') {
        await assertProviderAcceptsFile(file, extension);
      }
      assertCurrent();

      // iOS's decoder cannot read Opus. Android uses MediaCodec in its local
      // transcription adapter and must not inherit this iPhone-only restriction.
      if (
        Platform.OS !== 'android' &&
        transcriptionProvider === 'local' &&
        isOggOpus(file.name, file.mimeType, file.uri)
      ) {
        throw new Error(
          "Opus audio can't be transcribed on this iPhone yet. Set Uploads to OpenWhispr Cloud in Account → AI Models, then try again.",
        );
      }

      setCurrentText('');
      setStage('transcribing');
      const transcriptId = createTranscriptId();
      const clientTranscriptionId = `file-${randomUUID()}`;
      const retainedAudioUrl = await retainTranscriptAudio(file.uri, {
        transcriptId,
        audioFileName: file.name,
        audioMimeType: file.mimeType,
      });

      const addFailedUpload = async (provider: TranscriptionProvider, error: unknown) => {
        if (
          !isCurrent() ||
          options.saveToHistory === false ||
          isNoSpeechError(error) ||
          (error as Error)?.name === 'AbortError'
        ) {
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
            agentRoute: jobRoute.agentRoute,
            cleanupUnavailable: jobRoute.cleanupUnavailable,
            agentUnavailable: jobRoute.agentUnavailable,
            requestContext: 'file',
            jobId: transcriptId,
            errorMessage: toFriendlyTranscriptionErrorMessage(error),
          });
        } catch (failedRowError) {
          if (__DEV__) {
            console.warn('[upload] Failed to save retryable failed transcript:', failedRowError);
          }
        }
      };

      // iOS local engines need 16kHz mono WAV. Android converts at its local
      // transcription boundary; hosted routes send the original file.
      const runTranscription = async (provider: TranscriptionProvider) => {
        const controller = new AbortController();
        active.current = { controller, provider };
        let audioUri = retainedAudioUrl;
        const tempUris: string[] = [];
        try {
          assertCurrent();
          if (provider === 'local' && AudioTools.isAvailable()) {
            const transcoded = await AudioTools.transcodeToWav(retainedAudioUrl);
            audioUri = transcoded.uri;
            tempUris.push(transcoded.uri);
          }
          assertCurrent();

          const processedResult = await transcribeAndCleanup(
            {
              ...jobRoute,
              audioUri,
              provider,
              inferenceRoute: provider === 'byok' ? jobRoute.inferenceRoute : undefined,
              cleanupRoute: jobRoute.cleanupRoute,
              agentRoute: jobRoute.agentRoute,
              cleanupUnavailable: jobRoute.cleanupUnavailable,
              agentUnavailable: jobRoute.agentUnavailable,
              fileName: file.name,
              mimeType: file.mimeType,
              language: getPreferredTranscriptionLanguage(),
              requestContext: 'file',
              jobId: transcriptId,
              clientTranscriptionId,
            },
            {
              signal: controller.signal,
              shouldCancel: () => controller.signal.aborted || !isCurrent(),
              onRawTranscript: (text) => {
                if (isCurrent()) setCurrentText(text);
              },
              onStage: (next) => {
                if (isCurrent()) setStage(next);
              },
            },
          );
          assertCurrent();
          if (controller.signal.aborted) {
            const cancelled = new Error('Upload cancelled');
            cancelled.name = 'AbortError';
            throw cancelled;
          }
          const finalText = processedResult.text;

          if (options.saveToHistory !== false)
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
              agentRoute: processedResult.transcription.agentRoute,
              cleanupUnavailable: processedResult.transcription.cleanupUnavailable,
              agentUnavailable: processedResult.transcription.agentUnavailable,
              cleanupWarning: processedResult.transcription.cleanupWarning,
              requestContext: 'file',
              jobId: transcriptId,
            });

          assertCurrent();
          setCurrentText(finalText);
          options.onComplete?.(finalText, file.name);
          if (options.saveToHistory === false) await deleteManagedTranscriptAudio(retainedAudioUrl);
        } catch (error) {
          if (controller.signal.aborted && error instanceof Error) error.name = 'AbortError';
          throw error;
        } finally {
          if (active.current?.controller === controller) active.current = null;
          await AudioTools.cleanup(tempUris);
        }
      };

      const retryWithCloud = async () => {
        if (!isCurrent() || active.current) return;
        busy.current = true;
        setIsProcessing(true);
        try {
          jobRoute = { provider: 'cloud', ...snapshotTextInference('cloud') };
          await runTranscription('cloud');
        } catch (retryError) {
          if ((retryError as Error)?.name === 'AbortError') return;
          if (isUsageLimitError(retryError) && options.onUsageLimitReached) {
            await options.onUsageLimitReached(retryError, retryWithCloud);
            return;
          }
          addFailedUpload('cloud', retryError).catch(() => undefined);
          options.onError?.(toFriendlyUploadError(retryError));
        } finally {
          busy.current = false;
          if (mounted.current) setIsProcessing(false);
        }
      };

      setIsProcessing(true);
      try {
        await runTranscription(transcriptionProvider);
      } catch (error) {
        if (!isCurrent()) {
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
      if (!isCurrent() || (error as Error)?.name === 'AbortError') return;
      const friendly = toFriendlyUploadError(error);
      options.onError?.(friendly);
      throw friendly;
    } finally {
      if (pickerCacheUri)
        await FileSystem.deleteAsync(pickerCacheUri, { idempotent: true }).catch(() => undefined);
      busy.current = active.current !== null;
      if (mounted.current) setIsProcessing(busy.current);
    }
  };

  return {
    isProcessing,
    currentText,
    stage,
    cancel,
    pickAndTranscribeFile,
  };
}
