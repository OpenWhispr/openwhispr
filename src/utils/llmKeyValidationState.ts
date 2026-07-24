import type { LlmKeyValidationCode, LlmKeyValidationResult } from "../types/electron";

export const STORAGE_PREFIX = "llmKeyValidationStatus:";

type ValidationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const VALID_CODES: ReadonlySet<LlmKeyValidationCode> = new Set([
  "INVALID_KEY",
  "PERMISSION_DENIED",
  "BILLING_REQUIRED",
  "RATE_LIMITED",
  "TIMEOUT",
  "NETWORK_ERROR",
  "PROVIDER_UNAVAILABLE",
  "INVALID_ENDPOINT",
  "UNSUPPORTED_PROVIDER",
  "INVALID_REQUEST",
  "PERSISTENCE_FAILED",
  "VALIDATION_FAILED",
]);

function isValidationCode(value: unknown): value is LlmKeyValidationCode {
  return typeof value === "string" && VALID_CODES.has(value as LlmKeyValidationCode);
}

function storageKey(validationStateKey: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(validationStateKey)}`;
}

export function readUnverifiedLlmKeyState(
  storage: ValidationStorage | undefined,
  validationStateKey: string | undefined
): LlmKeyValidationResult | null {
  if (!storage || !validationStateKey) return null;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(storageKey(validationStateKey)) || "null");
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("verified" in parsed) ||
      parsed.verified !== false ||
      !("provider" in parsed) ||
      typeof parsed.provider !== "string" ||
      !("code" in parsed) ||
      !isValidationCode(parsed.code)
    ) {
      return null;
    }
    return {
      success: true,
      provider: parsed.provider,
      verified: false,
      code: parsed.code,
      retryable: "retryable" in parsed && parsed.retryable === true,
    };
  } catch {
    return null;
  }
}

export function writeUnverifiedLlmKeyState(
  storage: ValidationStorage | undefined,
  validationStateKey: string | undefined,
  result: LlmKeyValidationResult
): void {
  if (!storage || !validationStateKey || !result?.success || result.verified !== false) return;
  if (!isValidationCode(result.code)) return;
  try {
    storage.setItem(
      storageKey(validationStateKey),
      JSON.stringify({
        provider: typeof result.provider === "string" ? result.provider : "",
        verified: false,
        code: result.code,
        retryable: result.retryable === true,
      })
    );
  } catch {
    // Validation status is advisory; storage failures must not block key setup.
  }
}

export function clearUnverifiedLlmKeyState(
  storage: ValidationStorage | undefined,
  validationStateKey: string | undefined
): void {
  if (!storage || !validationStateKey) return;
  try {
    storage.removeItem(storageKey(validationStateKey));
  } catch {
    // Validation status is advisory; storage failures must not block key setup.
  }
}
