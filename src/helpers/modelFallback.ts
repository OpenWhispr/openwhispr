import { PROVIDER_ERROR_CODES } from "./providerHttpErrors.js";

const knownProviderCodes = new Set<string>(Object.values(PROVIDER_ERROR_CODES));
const recoverableProviderCodes = new Set<string>([
  PROVIDER_ERROR_CODES.QUOTA_EXHAUSTED,
  PROVIDER_ERROR_CODES.RATE_LIMITED,
  PROVIDER_ERROR_CODES.UNAVAILABLE,
  PROVIDER_ERROR_CODES.TIMEOUT,
  PROVIDER_ERROR_CODES.UNREACHABLE,
]);

/** Stored selections only. Credentials stay in encrypted provider slots and named key profiles. */
export interface FallbackTarget {
  provider: string;
  model: string;
  keyId?: string;
}

export const MAX_FALLBACK_TARGETS = 3;

export function normalizeFallbackTargets(value: unknown): FallbackTarget[] {
  if (!Array.isArray(value)) return [];
  const targets: FallbackTarget[] = [];
  for (const entry of value) {
    if (!entry || typeof entry.provider !== "string" || typeof entry.model !== "string") continue;
    const provider = entry.provider.trim();
    const model = entry.model.trim();
    if (!provider || !model || provider.length > 64 || model.length > 256) continue;
    if (
      targets.some(
        (target) =>
          target.provider === provider && target.model === model && target.keyId === entry.keyId
      )
    )
      continue;
    const keyId =
      typeof entry.keyId === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(entry.keyId)
        ? entry.keyId
        : undefined;
    if (entry.keyId !== undefined && !keyId) continue;
    targets.push({ provider, model, ...(keyId ? { keyId } : {}) });
    if (targets.length === MAX_FALLBACK_TARGETS) break;
  }
  return targets;
}

export function canFallback(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const fault = error as {
    name?: string;
    code?: string;
    status?: number;
    response?: { status?: number };
    message?: string;
    selectionEditFatal?: boolean;
  };
  if (fault.name === "AbortError" || fault.selectionEditFatal) return false;
  if (/POLICY|AUTH|INVALID_KEY|API_KEY_MISSING|CONTENT_FILTER|SAFETY|CANCEL/.test(fault.code ?? ""))
    return false;
  // Main classifies some quota failures from HTTP 400/403, and gives network
  // failures a safe message instead of the browser's raw fetch error. Use that
  // classification before the generic HTTP/message checks below.
  if (fault.code && knownProviderCodes.has(fault.code)) {
    return recoverableProviderCodes.has(fault.code);
  }
  const status = fault.status ?? fault.response?.status;
  if (typeof status === "number" && status > 0) {
    return status === 402 || status === 408 || status === 429 || (status >= 500 && status < 600);
  }
  if (
    [
      "LLM_REQUEST_TIMEOUT",
      "PROVIDER_RATE_LIMITED",
      "SERVER_ERROR",
      "ETIMEDOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EAI_AGAIN",
      "TRANSCRIPTION_BATCH_UNAVAILABLE",
      "LOCAL_TRANSCRIPTION_FAILED",
      "LOCAL_SERVER_UNAVAILABLE",
      "LOCAL_MODEL_BUSY",
    ].includes(fault.code ?? "")
  )
    return true;
  // Browser fetch failures have no HTTP response. Do not treat every TypeError
  // (or an arbitrary provider error message) as a network failure.
  return (
    fault.name === "TypeError" &&
    /^(Failed to fetch|fetch failed|NetworkError|Load failed)/i.test(fault.message ?? "")
  );
}

function abortError(): Error {
  return Object.assign(new Error("Request cancelled"), { name: "AbortError" });
}

export async function runModelFallback<T>({
  primary,
  targets,
  attempt,
  isAllowed = () => true,
  wasCancelled = () => false,
}: {
  primary: FallbackTarget;
  targets: FallbackTarget[];
  attempt: (target: FallbackTarget, isFallback: boolean) => Promise<T>;
  isAllowed?: (target: FallbackTarget) => boolean | Promise<boolean>;
  wasCancelled?: () => boolean;
}): Promise<{ value: T; target: FallbackTarget; usedFallback: boolean }> {
  let originalError: unknown;
  const selections = [
    primary,
    ...normalizeFallbackTargets(targets).filter(
      (target) =>
        target.provider !== primary.provider ||
        target.model !== primary.model ||
        target.keyId !== primary.keyId
    ),
  ];
  for (let index = 0; index < selections.length; index++) {
    if (wasCancelled()) throw abortError();
    const target = selections[index];
    if (index > 0 && !(await isAllowed(target))) continue;
    if (wasCancelled()) throw abortError();
    try {
      const value = await attempt(target, index > 0);
      if (wasCancelled()) throw abortError();
      return { value, target, usedFallback: index > 0 };
    } catch (error) {
      if (wasCancelled()) throw abortError();
      if (!canFallback(error)) throw error;
      if (index === 0) originalError = error;
    }
  }
  // Preserve the actionable primary failure when every provider is unavailable.
  throw originalError;
}
