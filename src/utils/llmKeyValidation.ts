import type {
  LlmKeyValidationCode,
  LlmKeyValidationResult,
  LlmKeyProvider,
} from "../types/electron";

const BLOCKING_SETUP_CODES = new Set<LlmKeyValidationCode>([
  "INVALID_KEY",
  "INVALID_ENDPOINT",
  "INVALID_REQUEST",
  "UNSUPPORTED_PROVIDER",
  "PERSISTENCE_FAILED",
]);

export function shouldBlockLlmKeySetup(result: LlmKeyValidationResult): boolean {
  return !result.success && (result.code === undefined || BLOCKING_SETUP_CODES.has(result.code));
}

export function createUnverifiedLlmKeyResult(
  provider: LlmKeyProvider,
  code: LlmKeyValidationCode = "VALIDATION_FAILED",
  warning = "The API key could not be verified right now."
): LlmKeyValidationResult {
  return {
    success: true,
    provider,
    verified: false,
    code,
    warning,
    retryable: true,
  };
}
