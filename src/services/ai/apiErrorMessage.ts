/**
 * Reads a human-readable message out of an OpenAI-compatible error body. Kept free
 * of runtime imports so the shape table stays unit-testable on its own.
 */
const MAX_STRINGIFIED_LENGTH = 500;

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** FastAPI/Pydantic validation errors or detail strings: {detail: "..."} or {detail: [{loc, msg}]}. */
function fromDetailList(container: unknown): string | null {
  if (!isRecord(container)) return null;

  const detailStr = asNonEmptyString(container.detail);
  if (detailStr) return detailStr;

  if (!Array.isArray(container.detail)) return null;

  const parts: string[] = [];
  for (const entry of container.detail) {
    if (!isRecord(entry)) continue;
    const msg = asNonEmptyString(entry.msg);
    if (!msg) continue;
    const loc = Array.isArray(entry.loc) ? entry.loc : [];
    const field = asNonEmptyString(loc.length ? loc[loc.length - 1] : null);
    parts.push(field ? `${field}: ${msg}` : msg);
  }

  return parts.length ? parts.join("; ") : null;
}

function stringify(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    if (!json) return null;
    return json.length > MAX_STRINGIFIED_LENGTH
      ? `${json.slice(0, MAX_STRINGIFIED_LENGTH)}…`
      : json;
  } catch {
    return null;
  }
}

export function extractApiErrorMessage(errorData: unknown, fallback: string): string {
  const safeFallback = asNonEmptyString(fallback) || "Unknown API error";
  if (!isRecord(errorData)) return safeFallback;

  const nested = isRecord(errorData.error) ? asNonEmptyString(errorData.error.message) : null;
  if (nested) return nested;

  const flat = asNonEmptyString(errorData.message);
  if (flat) return flat;

  const topDetail = fromDetailList(errorData);
  if (topDetail) return topDetail;

  const messageDetail = fromDetailList(errorData.message);
  if (messageDetail) return messageDetail;

  const errorString = asNonEmptyString(errorData.error);
  if (errorString) return errorString;

  if (isRecord(errorData.message) || Array.isArray(errorData.message)) {
    const stringified = stringify(errorData.message);
    if (stringified) return stringified;
  }

  if (isRecord(errorData.error) || Array.isArray(errorData.error)) {
    const stringified = stringify(errorData.error);
    if (stringified) return stringified;
  }

  return safeFallback;
}
