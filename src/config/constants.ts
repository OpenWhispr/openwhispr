// API Configuration helpers
export const normalizeBaseUrl = (value?: string | null): string => {
  if (!value) return "";

  let normalized = value.trim();
  if (!normalized) return "";

  // Remove common API endpoint suffixes to get the base URL
  const suffixReplacements: Array<[RegExp, string]> = [
    [/\/v1\/chat\/completions$/i, "/v1"],
    [/\/chat\/completions$/i, ""],
    [/\/v1\/responses$/i, "/v1"],
    [/\/responses$/i, ""],
    [/\/v1\/models$/i, "/v1"],
    [/\/models$/i, ""],
    [/\/v1\/audio\/transcriptions$/i, "/v1"],
    [/\/audio\/transcriptions$/i, ""],
    [/\/v1\/audio\/translations$/i, "/v1"],
    [/\/audio\/translations$/i, ""],
  ];

  for (const [pattern, replacement] of suffixReplacements) {
    if (pattern.test(normalized)) {
      normalized = normalized.replace(pattern, replacement).replace(/\/+$/, "");
    }
  }

  return normalized.replace(/\/+$/, "");
};

export const buildApiUrl = (base: string, path: string): string => {
  const normalizedBase = normalizeBaseUrl(base) || "https://api.openai.com/v1";
  if (!path) {
    return normalizedBase;
  }
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
};

const env = (typeof import.meta !== "undefined" && (import.meta as any).env) || {};

const computeBaseUrl = (candidates: Array<string | undefined>, fallback: string): string => {
  for (const candidate of candidates) {
    const normalized = normalizeBaseUrl(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return fallback;
};

const DEFAULT_OPENAI_BASE = computeBaseUrl(
  [env.OPENWHISPR_OPENAI_BASE_URL as string | undefined, env.OPENAI_BASE_URL as string | undefined],
  "https://api.openai.com/v1"
);

const DEFAULT_TRANSCRIPTION_BASE = computeBaseUrl(
  [
    env.OPENWHISPR_TRANSCRIPTION_BASE_URL as string | undefined,
    env.WHISPER_BASE_URL as string | undefined,
  ],
  DEFAULT_OPENAI_BASE
);

export const API_ENDPOINTS = {
  OPENAI_BASE: DEFAULT_OPENAI_BASE,
  OPENAI: buildApiUrl(DEFAULT_OPENAI_BASE, "/responses"),
  OPENAI_MODELS: buildApiUrl(DEFAULT_OPENAI_BASE, "/models"),
  ANTHROPIC: "https://api.anthropic.com/v1/messages",
  GEMINI: "https://generativelanguage.googleapis.com/v1beta",
  GROQ_BASE: "https://api.groq.com/openai/v1",
  MISTRAL_BASE: "https://api.mistral.ai/v1",
  TRANSCRIPTION_BASE: DEFAULT_TRANSCRIPTION_BASE,
  TRANSCRIPTION: buildApiUrl(DEFAULT_TRANSCRIPTION_BASE, "/audio/transcriptions"),
} as const;

export const API_VERSIONS = {
  ANTHROPIC: "2023-06-01",
  GEMINI: "v1beta",
} as const;

// Model Configuration
export const MODEL_CONSTRAINTS = {
  MIN_FILE_SIZE: 1_000_000, // 1MB minimum for valid model files
  MODEL_TEST_TIMEOUT: 5000, // 5 seconds for model validation
  INFERENCE_TIMEOUT: 30000, // 30 seconds default (configurable)
} as const;

// Token Limits
export const TOKEN_LIMITS = {
  MIN_TOKENS: 100,
  MAX_TOKENS: 2048,
  MIN_TOKENS_ANTHROPIC: 100,
  MAX_TOKENS_ANTHROPIC: 4096,
  MIN_TOKENS_GEMINI: 100,
  MAX_TOKENS_GEMINI: 8192,
  TOKEN_MULTIPLIER: 2, // text.length * multiplier
  REASONING_CONTEXT_SIZE: 4096,
} as const;

// Cache Configuration
export const CACHE_CONFIG = {
  API_KEY_TTL: 3600000, // 1 hour in milliseconds
  MODEL_CACHE_SIZE: 3, // Maximum models to keep in memory
  AVAILABILITY_CHECK_TTL: 30000, // 30s for accessibility, FFmpeg, tool availability checks
  PASTE_DELAY_MS: 50, // Delay before paste simulation to allow clipboard to settle
} as const;

// OpenWhispr Cloud API
export const OPENWHISPR_API_URL = (env.VITE_OPENWHISPR_API_URL as string) || "";

// Retry Configuration
export const RETRY_CONFIG = {
  MAX_RETRIES: 3,
  INITIAL_DELAY: 1000, // 1 second
  MAX_DELAY: 10000, // 10 seconds
  BACKOFF_MULTIPLIER: 2,
} as const;
