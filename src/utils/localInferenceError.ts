/**
 * Turns a failed local-inference IPC result into an Error the UI can render.
 *
 * The main process reports a machine-readable `code` and `details`; the
 * translation keys live here, on the renderer side, so both surfaces that show
 * these failures — the notes toast and the dictation cleanup toast — get the
 * same wording for free.
 *
 * Before #2142 the raw llama.cpp 400 body was shown to the user verbatim.
 */

export interface LocalInferenceFailure {
  error?: string;
  code?: string;
  details?: Record<string, unknown> | null;
}

export interface LocalInferenceError extends Error {
  code?: string;
  messageKey?: string;
  messageParams?: Record<string, string | number>;
}

const asPositiveInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;

function contextTooLarge(
  details: Record<string, unknown>
): Pick<LocalInferenceError, "messageKey" | "messageParams"> {
  const model = typeof details.modelName === "string" ? details.modelName : "";
  const needed = asPositiveInteger(details.neededTokens);
  const max = asPositiveInteger(details.maxContextTokens);

  if (needed === null || max === null) {
    return {
      messageKey: "models.errors.contextTooLargeGeneric",
      messageParams: { model },
    };
  }
  return {
    messageKey: "models.errors.contextTooLarge",
    messageParams: { model, needed, max },
  };
}

export function buildLocalInferenceError(result: LocalInferenceFailure): LocalInferenceError {
  const error: LocalInferenceError = new Error(result.error || "Local inference failed");
  if (result.code) error.code = result.code;

  if (result.code === "CONTEXT_TOO_LARGE") {
    Object.assign(error, contextTooLarge(result.details ?? {}));
  }

  return error;
}
