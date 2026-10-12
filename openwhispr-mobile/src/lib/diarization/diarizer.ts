/** One diarized speaker turn. Times are in SECONDS (the engine's native unit). */
export interface DiarSegment {
  start: number;
  end: number;
  /** null when the engine cannot attribute the turn (e.g. overlap / no-match). */
  speakerId: number | null;
}

/** Result of diarizing one 16 kHz mono WAV file. Times in SECONDS. */
export interface DiarizationResult {
  speakerCount: number;
  segments: DiarSegment[];
  /**
   * Per-speaker centroid embeddings keyed by speakerId. Unnormalised / pre-PLDA —
   * L2-normalise + cosine for voiceprint matching (M4). Not used by M2's merge.
   */
  embeddings: Record<number, number[]>;
}

/**
 * Engine-agnostic diarizer. The concrete adapter (FluidAudio now; SpeakerKit later)
 * must satisfy this so the service + merge stay engine-independent.
 */
export interface Diarizer {
  isAvailable(): boolean;
  /** True if the on-device model weights are already downloaded (no network needed to diarize). */
  isModelDownloaded(): Promise<boolean>;
  /**
   * Download the ~100 MB model weights with EXPLICIT user consent (mirrors the local whisper model).
   * Call this behind a download prompt before diarize(); no-op if already present.
   */
  downloadModel(onProgress?: (fraction: number) => void): Promise<void>;
  /** Remove the downloaded model weights from disk to reclaim storage. No-op if not present. */
  deleteModel(): Promise<void>;
  /**
   * Diarize a 16 kHz mono WAV (produce it via AudioTools.transcodeToWav so whisper.rn
   * and the diarizer read the same timeline). Assumes the model is already downloaded.
   * @param numberOfSpeakers exact speaker-count hint; omit/0 = auto-detect. Exact-or-auto only.
   */
  diarize(wavUri: string, numberOfSpeakers?: number): Promise<DiarizationResult>;
}

export const TRANSCRIPTION_STATUSES = [
  'idle',
  'recording',
  'transcribing',
  'diarizing',
  'done',
  'failed',
] as const;

export type TranscriptionStatus = (typeof TRANSCRIPTION_STATUSES)[number];

export const isTranscriptionStatus = (value: string): value is TranscriptionStatus =>
  (TRANSCRIPTION_STATUSES as readonly string[]).includes(value);
