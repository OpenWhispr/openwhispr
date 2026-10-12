export const API_ENDPOINTS = {
  OPENWHISPR_API: process.env.EXPO_PUBLIC_API_URL || 'https://api.openwhispr.com',
};

export const DEFAULT_MODELS = {
  TRANSCRIPTION: {
    // The Whisper fallback model only — engine selection (Parakeet vs Whisper) is
    // language-driven and lives in services/transcription/localEngine.ts.
    LOCAL: 'base',
  },
  REASONING: {
    LOCAL: 'local-cleanup',
  },
};

export const STORAGE_KEYS = {
  USER_CONFIG: '@openwhispr:user_config',
  TRANSCRIPTS: '@openwhispr:transcripts',
  AUTH_TOKEN: '@openwhispr:auth_token',
  AGENT_SESSIONS: '@openwhispr:agent_sessions',
};

export const MAX_RECORDING_DURATION = 600000; // 10 minutes in ms
export const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

// Cloud transcription chunking: the API gateway rejects request bodies larger
// than ~4.5MB, so files above this are split into segment-length 16kHz mono WAV
// chunks and uploaded individually, then stitched back together. At 32KB/s, 120s
// is ~3.84MB per chunk, safely under the cap.
export const CLOUD_INLINE_LIMIT = 4 * 1024 * 1024; // 4MB
export const CLOUD_CHUNK_SECONDS = 120; // ~3.84MB per WAV chunk
export const CLOUD_CHUNK_CONCURRENCY = 5; // max parallel chunk uploads

// Keyboard uploads at or below this size go through a plain in-process request
// instead of the background URLSession: the system schedules backgrounded
// apps' background-session transfers lazily (dictations stalled on
// "Transcribing" until the app was foregrounded), while an in-process upload
// of a small clip finishes in seconds inside the stop-recording background
// task. Larger files keep the background session, where surviving suspension
// matters more than latency. 2MB ≈ 8 min of 32kbps m4a keyboard audio.
export const CLOUD_INPROCESS_UPLOAD_LIMIT = 2 * 1024 * 1024; // 2MB
