import * as FileSystem from 'expo-file-system/legacy';
import { TranscriptionRequest, TranscriptionResponse } from '../../types';
import {
  API_ENDPOINTS,
  CLOUD_CHUNK_CONCURRENCY,
  CLOUD_CHUNK_SECONDS,
  CLOUD_INLINE_LIMIT,
  CLOUD_INPROCESS_UPLOAD_LIMIT,
} from '../../config/constants';
import { LocalWhisperService } from './LocalWhisperService';
import { LocalTranscriptionService } from './LocalTranscriptionService';
import { useAuthStore } from '../../store/useAuthStore';
import { getClientVersionHeader } from '../../lib/apiClient';
import { buildDictationHints, isDictationContext } from '../../lib/dictationHints';
import { BackgroundUploader } from '../../../modules/background-uploader/src';
import { AudioTools } from '../../../modules/audio-tools/src';
import { AppGroupStorage, APP_GROUP_KEYS } from '../../../modules/app-group-storage/src';
import { CLEANUP_TIMEOUT_MS } from '../../lib/cleanupTranscript';
import { withRetry } from '../../lib/retry';
import { wordLimitErrorFromBody } from './wordLimit';
import { transcriptionPolicyErrorFromResponse } from './policyErrors';

const TRANSCRIBE_ENDPOINT = '/api/transcribe';
const TRANSCRIBE_AND_CLEAN_ENDPOINT =
  process.env.EXPO_PUBLIC_TRANSCRIBE_CLEAN_ENDPOINT || TRANSCRIBE_ENDPOINT;
const CLOUD_TRANSCRIPTION_TIMEOUT_SECONDS = 45;
const FUSED_CLEANUP_TIMEOUT_SECONDS = 60;
const TRANSCRIPTION_TIMEOUT_MS = CLOUD_TRANSCRIPTION_TIMEOUT_SECONDS * 1000;

let fusedCleanupEndpointUnavailable = false;

export class FusedCleanupUnavailableError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'FusedCleanupUnavailableError';
    this.status = status;
  }
}

export class TranscriptionApiError extends Error {
  readonly status: number;
  readonly body: string;
  readonly endpointLabel: string;

  constructor(endpointLabel: string, status: number, body: string) {
    super(`Transcription error: ${body}`);
    this.name = 'TranscriptionApiError';
    this.status = status;
    this.body = body;
    this.endpointLabel = endpointLabel;
  }
}

const MIME_TO_EXTENSION: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mpga': 'mp3',
  'audio/m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/oga': 'ogg',
  'audio/opus': 'ogg',
  'audio/webm': 'webm',
};

const EXTENSION_TO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  mp4: 'audio/mp4',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  wave: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  webm: 'audio/webm',
};

const sanitizeExtension = (value?: string): string | undefined => {
  if (!value) {
    return undefined;
  }
  return value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
};

const normalizeExtension = (value?: string): string | undefined => {
  const sanitized = sanitizeExtension(value);
  if (!sanitized) {
    return undefined;
  }
  if (sanitized === 'opus') {
    return 'ogg';
  }
  return sanitized;
};

const normalizeMimeType = (value?: string): string | undefined => {
  if (!value) {
    return undefined;
  }
  const lower = value.toLowerCase();
  if (lower === 'audio/opus') {
    return 'audio/ogg';
  }
  if (lower === 'application/octet-stream') {
    return undefined;
  }
  return lower;
};

const getExtensionFromUri = (uri: string): string | undefined => {
  if (!uri) {
    return undefined;
  }
  const withoutQuery = uri.split(/[?#]/)[0];
  const match = withoutQuery.match(/\.([a-zA-Z0-9]+)$/);
  return normalizeExtension(match?.[1]);
};

const getFileNameFromUri = (uri: string): string | undefined => {
  if (!uri) {
    return undefined;
  }
  const withoutQuery = uri.split(/[?#]/)[0];
  const lastSegment = withoutQuery.split('/').pop();
  if (!lastSegment || !lastSegment.includes('.')) {
    return undefined;
  }
  try {
    return decodeURIComponent(lastSegment);
  } catch {
    return lastSegment;
  }
};

const getExtensionFromFileName = (name?: string): string | undefined => {
  if (!name || !name.includes('.')) {
    return undefined;
  }
  return normalizeExtension(name.split('.').pop());
};

const inferNormalizedExtension = (
  audioUri: string,
  fileName?: string,
  mimeType?: string,
): string => {
  const normalizedMimeType = normalizeMimeType(mimeType);
  const inferredExtension =
    getExtensionFromFileName(fileName) ||
    getExtensionFromUri(audioUri) ||
    (normalizedMimeType ? MIME_TO_EXTENSION[normalizedMimeType] : undefined) ||
    'wav';
  return normalizeExtension(inferredExtension) || 'wav';
};

const getFileSizeBytes = async (uri: string): Promise<number | undefined> => {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists ? (info as any).size : undefined;
  } catch {
    return undefined;
  }
};

// Formats the cloud accepts as-is for inline uploads (the server resolves the
// media type from the multipart Content-Type/filename, not container magic
// bytes). Excludes m4a/mp4 by default so non-keyboard uploads keep their WAV
// transcode.
const INLINE_SAFE_EXTENSIONS = new Set(['wav', 'mp3', 'flac', 'webm']);

// Keyboard recordings are small AAC/m4a clips, which normalizeAudioMediaType
// maps to audio/mp4 — accepted natively by the STT providers. Uploading them
// inline skips the WAV transcode plus chunked background-session upload (which
// also blocks fused cleanup), the slow path behind dictations stuck on
// "Transcribing". Scoped to the keyboard context because its
// retryKeyboardAudioAsWav fallback is what covers a provider rejecting the
// compressed upload; other contexts have no such fallback.
const KEYBOARD_INLINE_SAFE_EXTENSIONS = new Set([...INLINE_SAFE_EXTENSIONS, 'm4a', 'mp4']);

// normalizeExtension collapses both .ogg and .opus to 'ogg', so this matches
// any Ogg-Opus upload. AVFoundation can't decode these, so they take the
// container-split chunking path instead of the WAV transcode path.
export const isOggOpus = (fileName?: string, mimeType?: string, uri?: string): boolean => {
  const extension =
    getExtensionFromFileName(fileName) || (uri ? getExtensionFromUri(uri) : undefined);
  if (extension === 'ogg') {
    return true;
  }
  const normalized = (mimeType || '').toLowerCase();
  return normalized === 'audio/ogg' || normalized === 'audio/opus';
};

// Single source of truth for the cloud chunking decision, shared by the
// dispatch in transcribeWithApi and the up-front requestNeedsChunking check so
// the two can't drift. Returns null when the file fits an inline upload.
const planCloudChunking = (
  fileSize: number | undefined,
  normalizedExtension: string,
  fileName?: string,
  mimeType?: string,
  audioUri?: string,
  inlineSafeExtensions: Set<string> = INLINE_SAFE_EXTENSIONS,
): 'ogg' | 'wav' | null => {
  // An unknown size means we couldn't stat the file; treat it as over the inline
  // limit so a large upload is never sent whole to the ~4.5MB gateway by mistake.
  const overInlineLimit = fileSize === undefined || fileSize > CLOUD_INLINE_LIMIT;
  if (isOggOpus(fileName, mimeType, audioUri)) {
    return overInlineLimit ? 'ogg' : null;
  }
  if (overInlineLimit || !inlineSafeExtensions.has(normalizedExtension)) {
    return 'wav';
  }
  return null;
};

type UploadHttpResponse = {
  status: number;
  body: string;
  uploadMs?: number;
  bodyBuildMs?: number;
};

const UPLOAD_MAX_RETRIES = 2;
const UPLOAD_INITIAL_RETRY_DELAY_MS = 1000;

// 501 is excluded: it's deterministic, and the fused-cleanup path detects
// endpoint unavailability from it.
const isTransientUploadStatus = (status: number): boolean => status >= 500 && status !== 501;

// Retries the raw upload on network failure (rejection) or a transient 5xx,
// with backoff. Everything else — 4xx, 501 — is returned untouched so callers
// keep their existing status handling. The audio file is on disk, so a retry
// costs only time; without it one network blip forces the user to re-dictate.
// Retries are billing-safe: requests carry a clientTranscriptionId the server
// upserts usage rows on.
const uploadWithRetry = async (
  upload: () => Promise<UploadHttpResponse>,
  label: string,
): Promise<UploadHttpResponse> => {
  try {
    return await withRetry(
      async () => {
        const response = await upload();
        if (isTransientUploadStatus(response.status)) {
          throw new TranscriptionApiError(label, response.status, response.body);
        }
        return response;
      },
      {
        maxRetries: UPLOAD_MAX_RETRIES,
        initialDelay: UPLOAD_INITIAL_RETRY_DELAY_MS,
        onRetry: (attempt, error, delayMs) => {
          if (__DEV__) {
            console.warn(
              `[transcription] ${label} upload retry=${attempt} delayMs=${delayMs}:`,
              error instanceof Error ? error.message : error,
            );
          }
        },
      },
    );
  } catch (error) {
    // Retries exhausted on a 5xx: hand the response back so callers keep
    // their existing status handling. Network rejections keep propagating.
    if (error instanceof TranscriptionApiError) {
      return { status: error.status, body: error.body };
    }
    throw error;
  }
};

// Minimal status/text extraction for chunk uploads, which hit the plain
// transcribe endpoint and only need the raw text back (no fused cleanup or
// server-timing parsing — those are single-shot concerns).
const parseChunkTranscriptionText = (response: { status: number; body: string }): string => {
  if (response.status === 401) {
    throw new Error('Session expired. Please sign in again.');
  }
  if (response.status === 429) {
    throw wordLimitErrorFromBody(response.body);
  }
  if (response.status === 413) {
    throw new Error(
      'Audio is too large for cloud transcription. Please record a shorter clip or upload a smaller file.',
    );
  }
  const policyError = transcriptionPolicyErrorFromResponse(response.status, response.body);
  if (policyError) {
    throw policyError;
  }
  if (response.status !== 200) {
    console.error('API transcription error:', response.body);
    throw new TranscriptionApiError('transcribe', response.status, response.body);
  }
  return parseJsonBody(response.body).text ?? '';
};

const stitchChunkTexts = (texts: string[]): string => texts.join(' ').replace(/\s+/g, ' ').trim();

const readNumber = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
};

const parseJsonBody = (body: string): Record<string, any> => {
  const parsed = JSON.parse(body);
  return parsed && typeof parsed === 'object' ? parsed : {};
};

const normalizeServerTiming = (
  value: unknown,
): Record<string, string | number | boolean | null> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const timing: Record<string, string | number | boolean | null> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof raw === 'string' ||
      typeof raw === 'number' ||
      typeof raw === 'boolean' ||
      raw === null
    ) {
      timing[key] = raw;
    }
  }

  return Object.keys(timing).length > 0 ? timing : undefined;
};

const extractText = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value === 'string') {
      return value;
    }
  }
  return '';
};

const isFusedEndpointUnavailableStatus = (status: number) =>
  status === 404 || status === 405 || status === 501;

const isProviderAudioFormatError = (body: string): boolean =>
  /model\s+does\s+not\s+support\s+the\s+format|does\s+not\s+support\s+the\s+format|unsupported\s+(audio\s+)?format|format\s+(is\s+)?not\s+supported/i.test(
    body,
  );

const isWavAudio = (request: Pick<TranscriptionRequest, 'audioUri' | 'fileName' | 'mimeType'>) => {
  const mime = normalizeMimeType(request.mimeType);
  if (mime === 'audio/wav' || mime === 'audio/x-wav' || mime === 'audio/wave') {
    return true;
  }
  const extension =
    getExtensionFromFileName(request.fileName) || getExtensionFromUri(request.audioUri);
  return extension === 'wav' || extension === 'wave';
};

export class TranscriptionService {
  static isAudioFormatUnsupportedError(error: unknown): boolean {
    if (error instanceof TranscriptionApiError) {
      return isProviderAudioFormatError(error.body);
    }
    if (error instanceof Error) {
      return isProviderAudioFormatError(error.message);
    }
    return false;
  }

  private static canRetryKeyboardAudioAsWav(
    request: TranscriptionRequest,
    error: unknown,
  ): boolean {
    return (
      request.requestContext === 'keyboard' &&
      request.provider === 'cloud' &&
      !isWavAudio(request) &&
      this.isAudioFormatUnsupportedError(error)
    );
  }

  private static async retryKeyboardAudioAsWav<T>(
    request: TranscriptionRequest,
    error: unknown,
    retry: (fallbackRequest: TranscriptionRequest) => Promise<T>,
  ): Promise<T> {
    if (!this.canRetryKeyboardAudioAsWav(request, error)) {
      throw error;
    }

    const converted = await AppGroupStorage.convertRecordingToWav(request.audioUri);
    if (!converted) {
      throw error;
    }

    AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_COMPRESSED_AUDIO_UNSUPPORTED, '1');
    AppGroupStorage.setItem(
      APP_GROUP_KEYS.KEYBOARD_COMPRESSED_AUDIO_UNSUPPORTED_AT_MS,
      String(Date.now()),
    );
    if (__DEV__) {
      console.warn(
        `[transcription] compressed keyboard audio rejected; retrying as WAV fileSize=${converted.fileSizeBytes ?? 'unknown'}`,
      );
    }

    try {
      return await retry({
        ...request,
        audioUri: converted.fileUri,
        fileName: converted.fileName,
        mimeType: converted.mimeType,
      });
    } finally {
      FileSystem.deleteAsync(converted.fileUri, { idempotent: true }).catch((deleteError) => {
        if (__DEV__) {
          console.warn('[transcription] failed to delete temporary WAV fallback:', deleteError);
        }
      });
    }
  }

  private static async transcribeWithApi(
    audioUri: string,
    language?: string,
    fileName?: string,
    mimeType?: string,
    jobId?: string,
    options: {
      endpointPath?: string;
      endpointLabel?: string;
      extraParameters?: Record<string, string>;
      extraHeaders?: Record<string, string>;
      timeoutSeconds?: number;
      requestContext?: TranscriptionRequest['requestContext'];
      clientTranscriptionId?: string;
      fusedCleanup?: boolean;
    } = {},
  ): Promise<TranscriptionResponse> {
    const sessionCookie = useAuthStore.getState().sessionCookie;
    if (!sessionCookie) {
      throw new Error('Not authenticated. Please sign in to use cloud transcription.');
    }

    const normalizedMimeType = normalizeMimeType(mimeType);
    const normalizedExtension = inferNormalizedExtension(audioUri, fileName, mimeType);

    let finalMimeType = normalizedMimeType || EXTENSION_TO_MIME[normalizedExtension] || 'audio/wav';
    // m4a/AAC uploads go out as audio/mp4 — the MIME backends reliably accept.
    if (finalMimeType === 'audio/x-m4a' || finalMimeType === 'audio/m4a') {
      finalMimeType = 'audio/mp4';
    }
    const uploadFileName =
      fileName || getFileNameFromUri(audioUri) || `recording.${normalizedExtension}`;

    const parameters: Record<string, string> = {
      clientType: 'mobile',
      ...options.extraParameters,
    };
    if (!parameters.transcriptionTimeoutMs) {
      parameters.transcriptionTimeoutMs = String(TRANSCRIPTION_TIMEOUT_MS);
    }
    if (!parameters.totalTimeoutMs) {
      parameters.totalTimeoutMs = String(
        (options.timeoutSeconds ?? CLOUD_TRANSCRIPTION_TIMEOUT_SECONDS) * 1000,
      );
    }
    if (jobId) {
      parameters.jobId = jobId;
    }
    const clientTranscriptionId = options.clientTranscriptionId ?? jobId;
    if (clientTranscriptionId) {
      // Dedupe key for retries: the server upserts usage rows on
      // (user_id, client_transcription_id), so a retry after a timeout that
      // actually succeeded server-side can't double-count words.
      parameters.clientTranscriptionId = clientTranscriptionId;
    }
    if (language) {
      parameters.language = language;
    }
    if (options.requestContext) {
      parameters.requestContext = options.requestContext;
    }
    if (options.requestContext === 'keyboard') {
      parameters.normalizeAudio = '1';
      parameters.audioNormalization = 'speech-16k-mono';
      parameters.clientAudioMimeType = finalMimeType;
      parameters.clientAudioFileName = uploadFileName;
    }
    // TODO(prompt-token-cap): Whisper's `prompt` parameter is capped at ~244
    // tokens. A dictionary larger than ~50-100 entries will silently truncate.
    // When this matters, prioritize entries (recency, source, usage frequency)
    // and/or split context across multiple requests rather than naive join.
    const promptHints = buildDictationHints(isDictationContext(options.requestContext));
    if (promptHints.length > 0) {
      parameters.prompt = promptHints.join(', ');
    }

    const endpointPath = options.endpointPath ?? TRANSCRIBE_ENDPOINT;
    const endpointLabel = options.endpointLabel ?? 'transcribe';
    const timeoutSeconds = options.timeoutSeconds ?? CLOUD_TRANSCRIPTION_TIMEOUT_SECONDS;
    const headers: Record<string, string> = {
      Cookie: sessionCookie,
      'X-OpenWhispr-Client-Timeout-Ms': String(timeoutSeconds * 1000),
      'X-OpenWhispr-Transcription-Timeout-Ms': String(TRANSCRIPTION_TIMEOUT_MS),
      ...getClientVersionHeader(),
      ...(options.requestContext === 'keyboard'
        ? { 'X-OpenWhispr-Audio-Normalization': 'speech-16k-mono' }
        : {}),
      ...options.extraHeaders,
    };

    const fileSizeBytes = await getFileSizeBytes(audioUri);

    // The gateway rejects bodies over ~4.5MB and the cloud only detects certain
    // container formats, so large or undecodable audio is split and uploaded as
    // chunks. Fused cleanup can't run per-chunk, so callers gate it out (see
    // requestNeedsChunking) and clean the stitched transcript separately.
    if (AudioTools.isAvailable() && !options.fusedCleanup) {
      const plan = planCloudChunking(
        fileSizeBytes,
        normalizedExtension,
        fileName,
        mimeType,
        audioUri,
        options.requestContext === 'keyboard'
          ? KEYBOARD_INLINE_SAFE_EXTENSIONS
          : INLINE_SAFE_EXTENSIONS,
      );
      if (plan === 'ogg') {
        const { chunks } = await AudioTools.splitOggOpus(audioUri, CLOUD_INLINE_LIMIT);
        return this.transcribeChunked(chunks, 'audio/ogg', parameters, sessionCookie);
      }
      if (plan === 'wav') {
        const { chunks } = await AudioTools.splitToChunks(audioUri, CLOUD_CHUNK_SECONDS);
        return this.transcribeChunked(chunks, 'audio/wav', parameters, sessionCookie);
      }
    }

    // Keyboard dictations run while the app is backgrounded, where the system
    // schedules background-URLSession transfers lazily — small clips stalled on
    // "Transcribing" until the app was foregrounded. Small keyboard uploads
    // therefore go in-process (full priority, completes within the
    // stop-recording background task); big files keep the background session,
    // whose survive-app-death property outweighs latency at that size.
    const preferInProcessUpload =
      options.requestContext === 'keyboard' &&
      fileSizeBytes !== undefined &&
      fileSizeBytes <= CLOUD_INPROCESS_UPLOAD_LIMIT;
    const useBackgroundSession = BackgroundUploader.isAvailable() && !preferInProcessUpload;

    const uploadStartedAt = Date.now();
    const response = await uploadWithRetry(
      () =>
        useBackgroundSession
          ? BackgroundUploader.upload({
              url: `${API_ENDPOINTS.OPENWHISPR_API}${endpointPath}`,
              fileUri: audioUri,
              fileFieldName: 'file',
              fileMimeType: finalMimeType,
              fileName: uploadFileName,
              parameters,
              timeoutSeconds,
              headers,
            })
          : FileSystem.uploadAsync(`${API_ENDPOINTS.OPENWHISPR_API}${endpointPath}`, audioUri, {
              httpMethod: 'POST',
              uploadType: FileSystem.FileSystemUploadType.MULTIPART,
              // uploadAsync defaults to a background NSURLSession on iOS — the
              // exact lazily-scheduled transport this path exists to avoid
              // (observed: 24s for a 163KB clip until the app was foregrounded).
              sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
              fieldName: 'file',
              mimeType: finalMimeType,
              parameters,
              headers,
            }),
      endpointLabel,
    );
    const uploadMs = Date.now() - uploadStartedAt;

    // No speech is an expected outcome (silence, background noise), not a
    // failure. The server signals it with 422 + NO_SPEECH_DETECTED. Surface a
    // recognizable no-speech error (see isNoSpeechError) so callers show the
    // gentle "no speech" state — not an error toast — and skip the error log
    // and generic throw below.
    if (
      response.status === 422 &&
      typeof response.body === 'string' &&
      /NO_SPEECH_DETECTED|no speech/i.test(response.body)
    ) {
      throw new Error('No speech detected');
    }

    if (response.status === 401) {
      throw new Error('Session expired. Please sign in again.');
    }

    if (response.status === 429) {
      throw wordLimitErrorFromBody(response.body);
    }

    if (response.status === 413) {
      throw new Error(
        'Audio is too large for cloud transcription. Please record a shorter clip or upload a smaller file.',
      );
    }

    const policyError = transcriptionPolicyErrorFromResponse(response.status, response.body);
    if (policyError) {
      throw policyError;
    }

    if (response.status !== 200) {
      if (options.fusedCleanup && isFusedEndpointUnavailableStatus(response.status)) {
        throw new FusedCleanupUnavailableError(
          `Fused cleanup endpoint unavailable: HTTP ${response.status} ${response.body}`,
          response.status,
        );
      }
      console.error(
        `[transcription] ${endpointLabel} API error status=${response.status} file=${uploadFileName} mime=${finalMimeType}:`,
        response.body,
      );
      throw new TranscriptionApiError(endpointLabel, response.status, response.body);
    }

    const data = parseJsonBody(response.body);
    const processingMs = readNumber(
      data.processingMs,
      data.processing_ms,
      data.transcriptionMs,
      data.transcription_ms,
      data.sttProcessingMs,
      data.stt_processing_ms,
    );
    const cleanupMs = readNumber(
      data.cleanupMs,
      data.cleanup_ms,
      data.reasoningMs,
      data.reasoning_ms,
    );
    const originalText = extractText(
      data.originalText,
      data.original_text,
      data.rawText,
      data.raw_text,
      data.rawTranscript,
      data.raw_transcript,
    );
    const text = extractText(
      data.text,
      data.cleanedText,
      data.cleaned_text,
      data.transcript,
      originalText,
    );
    const serverTiming = normalizeServerTiming(
      data.serverTiming ?? data.server_timing ?? data.timings ?? data.timing ?? data.metrics,
    );
    const cleanupApplied =
      typeof data.cleanupApplied === 'boolean'
        ? data.cleanupApplied
        : typeof data.cleanup_applied === 'boolean'
          ? data.cleanup_applied
          : false;

    if (__DEV__) {
      console.log(
        `[transcription] ${endpointLabel} status=${response.status} transport=${useBackgroundSession ? 'background' : 'in-process'} fileSize=${fileSizeBytes ?? 'unknown'} mime=${finalMimeType} uploadMs=${uploadMs} bodyBuildMs=${
          'bodyBuildMs' in response && typeof response.bodyBuildMs === 'number'
            ? response.bodyBuildMs
            : 'unknown'
        } serverMs=${processingMs ?? 'unknown'} cleanupMs=${cleanupMs ?? 'unknown'}`,
      );
    }

    return {
      text,
      originalText: originalText || undefined,
      duration: 0,
      provider: 'cloud',
      endpoint: endpointPath,
      cleanupApplied,
      fusedCleanup: options.fusedCleanup || false,
      processingMs,
      cleanupMs,
      uploadMs:
        'uploadMs' in response && typeof response.uploadMs === 'number'
          ? response.uploadMs
          : uploadMs,
      bodyBuildMs:
        'bodyBuildMs' in response && typeof response.bodyBuildMs === 'number'
          ? response.bodyBuildMs
          : undefined,
      fileSizeBytes,
      mimeType: finalMimeType,
      serverTiming,
    };
  }

  // Mirrors the chunk-dispatch decision in transcribeWithApi so callers can
  // decide up front (e.g. to skip the fused-cleanup endpoint, which can't run
  // per-chunk) without triggering a split.
  static async requestNeedsChunking(request: TranscriptionRequest): Promise<boolean> {
    if (request.provider !== 'cloud' || !AudioTools.isAvailable()) {
      return false;
    }
    const normalizedExtension = inferNormalizedExtension(
      request.audioUri,
      request.fileName,
      request.mimeType,
    );
    const fileSize = await getFileSizeBytes(request.audioUri);
    return (
      planCloudChunking(
        fileSize,
        normalizedExtension,
        request.fileName,
        request.mimeType,
        request.audioUri,
        request.requestContext === 'keyboard'
          ? KEYBOARD_INLINE_SAFE_EXTENSIONS
          : INLINE_SAFE_EXTENSIONS,
      ) !== null
    );
  }

  // Uploads chunks with bounded concurrency, preserves order, and owns their
  // cleanup (deleted even on failure). On the first failure, workers stop
  // picking up new chunks so a quota (429) failure can't keep spending backend
  // usage; every worker settles before cleanup runs, so no chunk file is
  // deleted out from under an in-flight upload.
  private static async transcribeChunked(
    chunkUris: string[],
    chunkMimeType: string,
    parameters: Record<string, string>,
    sessionCookie: string,
  ): Promise<TranscriptionResponse> {
    try {
      const texts: string[] = new Array(chunkUris.length);
      let nextIndex = 0;
      let firstError: unknown = null;

      const worker = async (): Promise<void> => {
        while (firstError === null) {
          const index = nextIndex++;
          if (index >= chunkUris.length) {
            return;
          }
          // Each chunk records its own usage row, so each needs a distinct
          // dedupe key — stable across retries of the same chunk.
          const chunkParameters = parameters.clientTranscriptionId
            ? {
                ...parameters,
                clientTranscriptionId: `${parameters.clientTranscriptionId}-chunk${index}`,
              }
            : parameters;
          try {
            const response = await uploadWithRetry(
              () =>
                this.uploadAudioFile(
                  chunkUris[index],
                  chunkMimeType,
                  chunkParameters,
                  sessionCookie,
                ),
              'transcribe',
            );
            texts[index] = parseChunkTranscriptionText(response);
          } catch (error) {
            firstError ??= error;
            return;
          }
        }
      };

      const workerCount = Math.min(CLOUD_CHUNK_CONCURRENCY, chunkUris.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      if (firstError !== null) throw firstError;
      return { text: stitchChunkTexts(texts), duration: 0, provider: 'cloud' };
    } finally {
      await AudioTools.cleanup(chunkUris);
    }
  }

  private static uploadAudioFile(
    audioUri: string,
    mimeType: string,
    parameters: Record<string, string>,
    sessionCookie: string,
  ): Promise<{ status: number; body: string }> {
    const url = `${API_ENDPOINTS.OPENWHISPR_API}${TRANSCRIBE_ENDPOINT}`;
    // Keyboard chunks take the in-process transport for the same reason small
    // inline uploads do: the system schedules background-session transfers
    // lazily while the app is backgrounded, which is exactly when keyboard
    // dictations run.
    const preferInProcessUpload = parameters.requestContext === 'keyboard';
    if (BackgroundUploader.isAvailable() && !preferInProcessUpload) {
      return BackgroundUploader.upload({
        url,
        fileUri: audioUri,
        fileFieldName: 'file',
        fileMimeType: mimeType,
        parameters,
        headers: { Cookie: sessionCookie, ...getClientVersionHeader() },
      });
    }
    return FileSystem.uploadAsync(url, audioUri, {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
      fieldName: 'file',
      mimeType,
      parameters,
      headers: { Cookie: sessionCookie, ...getClientVersionHeader() },
    });
  }

  private static async transcribeLocally(
    audioUri: string,
    language?: string,
    requestContext?: TranscriptionRequest['requestContext'],
  ): Promise<TranscriptionResponse> {
    if (!LocalTranscriptionService.isAvailable()) {
      throw new Error(
        'Local transcription is not available. Please use cloud transcription or build the app with the native modules enabled.',
      );
    }

    const startedAt = Date.now();
    // Dictionary words + (dictation-only) snippet triggers as the Whisper initial
    // prompt, so on-device/private transcription recognizes them too. (Parakeet has
    // no prompt input; the facade drops it on that branch.)
    const hintWords = buildDictationHints(isDictationContext(requestContext));
    const response = await LocalTranscriptionService.transcribe(audioUri, {
      language,
      prompt: hintWords.length > 0 ? hintWords.join(', ') : undefined,
    });
    if (__DEV__) {
      console.log(
        `[transcription] local engine=${response.endpoint} elapsedMs=${Date.now() - startedAt}`,
      );
    }
    return response;
  }

  static canAttemptFusedCloudCleanup(): boolean {
    return !fusedCleanupEndpointUnavailable;
  }

  static isFusedCleanupUnavailableError(error: unknown): boolean {
    return error instanceof FusedCleanupUnavailableError;
  }

  static async transcribeWithCloudCleanup(
    request: TranscriptionRequest,
  ): Promise<TranscriptionResponse> {
    if (fusedCleanupEndpointUnavailable) {
      throw new FusedCleanupUnavailableError('Fused cleanup endpoint already marked unavailable');
    }

    const cleanupLanguage =
      request.language && request.language !== 'auto' ? request.language : undefined;
    const extraParameters: Record<string, string> = {
      cleanup: 'full',
      cleanupEnabled: '1',
      cleanupProvider: 'cloud',
      cleanupTimeoutMs: String(CLEANUP_TIMEOUT_MS),
      transcriptionTimeoutMs: String(TRANSCRIPTION_TIMEOUT_MS),
      totalTimeoutMs: String(FUSED_CLEANUP_TIMEOUT_SECONDS * 1000),
      responseFormat: 'text+raw+timings',
    };

    if (cleanupLanguage) {
      extraParameters.cleanupLanguage = cleanupLanguage;
      extraParameters.cleanupLocale = cleanupLanguage;
    }
    const cleanupHints = buildDictationHints(isDictationContext(request.requestContext));
    if (cleanupHints.length > 0) {
      extraParameters.customDictionary = JSON.stringify(cleanupHints);
    }

    const runFusedCleanup = (candidate: TranscriptionRequest) =>
      this.transcribeWithApi(
        candidate.audioUri,
        candidate.language,
        candidate.fileName,
        candidate.mimeType,
        candidate.jobId,
        {
          endpointPath: TRANSCRIBE_AND_CLEAN_ENDPOINT,
          endpointLabel: 'transcribe-clean',
          extraParameters,
          timeoutSeconds: candidate.timeoutSeconds ?? FUSED_CLEANUP_TIMEOUT_SECONDS,
          requestContext: candidate.requestContext,
          clientTranscriptionId: candidate.clientTranscriptionId,
          fusedCleanup: true,
          extraHeaders: {
            'X-OpenWhispr-Cleanup-Timeout-Ms': String(CLEANUP_TIMEOUT_MS),
          },
        },
      );

    try {
      return await runFusedCleanup(request);
    } catch (error) {
      if (error instanceof FusedCleanupUnavailableError) {
        fusedCleanupEndpointUnavailable = true;
        throw error;
      }
      return this.retryKeyboardAudioAsWav(request, error, async (fallbackRequest) => {
        try {
          return await runFusedCleanup(fallbackRequest);
        } catch (retryError) {
          if (retryError instanceof FusedCleanupUnavailableError) {
            fusedCleanupEndpointUnavailable = true;
          }
          throw retryError;
        }
      });
    }
  }

  static async transcribe(request: TranscriptionRequest): Promise<TranscriptionResponse> {
    const { audioUri, provider, language } = request;

    const runCloud = (candidate: TranscriptionRequest) =>
      this.transcribeWithApi(
        candidate.audioUri,
        candidate.language,
        candidate.fileName,
        candidate.mimeType,
        candidate.jobId,
        {
          requestContext: candidate.requestContext,
          clientTranscriptionId: candidate.clientTranscriptionId,
          timeoutSeconds: candidate.timeoutSeconds,
        },
      );

    switch (provider) {
      case 'local':
        // Private mode must never silently leave the device. If the on-device
        // model is unavailable we surface the error so the caller can ask the
        // user for explicit consent before any cloud fallback.
        return await this.transcribeLocally(audioUri, language, request.requestContext);

      case 'cloud':
        try {
          return await runCloud(request);
        } catch (error) {
          return this.retryKeyboardAudioAsWav(request, error, runCloud);
        }

      default:
        throw new Error(`Unsupported transcription provider: ${provider}`);
    }
  }

  // Whisper-specific by design: these back the legacy whisper model management flows.
  // Parakeet model management goes through LocalParakeetService / useModelDownloadStore.
  static async getAvailableLocalModels(): Promise<string[]> {
    const models = await LocalWhisperService.getAvailableModels();
    return models.map((m) => m.name);
  }

  static async downloadLocalModel(
    modelName: string,
    onProgress?: (progress: number) => void,
  ): Promise<void> {
    await LocalWhisperService.downloadModel(modelName, onProgress);
  }

  static isLocalAvailable(): boolean {
    return LocalTranscriptionService.isAvailable();
  }

  static async prepareLocal(language?: string): Promise<void> {
    if (!LocalTranscriptionService.isAvailable()) {
      return;
    }
    await LocalTranscriptionService.prepareForLanguage(language);
  }
}

export function isLocalModelMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /not available|model path not found|please download/i.test(error.message);
}
