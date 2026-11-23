import { PROVIDER_ERROR_CODES, SELF_HOSTED_NAME, providerError } from "./providerHttpErrors.js";

/** @typedef {{ name: string, value: string }} SelfHostedSttHeader */
/** @typedef {{ dictation: SelfHostedSttHeader[], upload: SelfHostedSttHeader[] }} SelfHostedSttHeaders */

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const INVALID_HEADER_VALUE = /[^\t\x20-\x7e\x80-\xff]/;
// The request sets these itself, or a proxy reads them.
const RESERVED_HEADER_NAMES = new Set([
  "content-type",
  "content-length",
  "host",
  "transfer-encoding",
  "connection",
  "upgrade",
  "trailer",
  "te",
  "proxy-authorization",
  "proxy-authenticate",
]);

const isRow = (row) => typeof row?.name === "string" && typeof row?.value === "string";
const rowsOf = (rows) => (Array.isArray(rows) ? rows.filter(isRow) : []);
const hasContent = (row) => Boolean(row.name.trim() || row.value);

/**
 * Why a row can't be sent: "missingName", "invalidName", "reserved" or "invalidValue". An
 * empty row is never sent, so it has no problem.
 * @param {SelfHostedSttHeader} row
 */
export function selfHostedSttHeaderProblem({ name, value }) {
  const trimmed = name.trim();
  if (!trimmed && !value) return null;
  if (!trimmed) return "missingName";
  if (!HEADER_NAME.test(trimmed)) return "invalidName";
  if (RESERVED_HEADER_NAMES.has(trimmed.toLowerCase())) return "reserved";
  if (INVALID_HEADER_VALUE.test(value)) return "invalidValue";
  return null;
}

/**
 * Dictation (with its retries and voice drafts) and uploads post to different servers (#2049),
 * so each keeps its own headers.
 * @returns {SelfHostedSttHeaders}
 */
export function parseSelfHostedSttHeaders(serialized) {
  let parsed = null;
  try {
    parsed = serialized ? JSON.parse(serialized) : null;
  } catch {}
  return { dictation: rowsOf(parsed?.dictation), upload: rowsOf(parsed?.upload) };
}

/**
 * The stored form, without empty rows: "" once neither server has a header, so clearing the
 * last one deletes the secret.
 * @param {SelfHostedSttHeaders} headers
 */
export function serializeSelfHostedSttHeaders(headers) {
  const kept = {
    dictation: rowsOf(headers.dictation).filter(hasContent),
    upload: rowsOf(headers.upload).filter(hasContent),
  };
  return kept.dictation.length || kept.upload.length ? JSON.stringify(kept) : "";
}

/**
 * The headers and redirect mode of one request to a self-hosted speech server. `auth` is the
 * request's own authentication, which wins over a custom header of the same name. Redirects
 * are refused once a custom header is set: fetch drops only Authorization when a redirect
 * leaves the origin, so following one would hand the rest to whichever host it names.
 * @param {SelfHostedSttHeader[]} [rows]
 * @param {Record<string, string>} [auth]
 * @returns {{ headers: Record<string, string>, redirect: "error" | "follow" }}
 */
export function selfHostedSttRequest(rows = [], auth = {}) {
  const headers = new Headers();
  let custom = false;
  for (const row of rowsOf(rows)) {
    if (!hasContent(row)) continue;
    if (selfHostedSttHeaderProblem(row)) {
      throw Object.assign(
        providerError(PROVIDER_ERROR_CODES.INVALID_HEADERS, {
          provider: SELF_HOSTED_NAME,
          selfHosted: true,
          surface: "transcription",
        }),
        // The connection check's code for the same failure.
        { errorCode: "invalidHeaders" }
      );
    }
    headers.set(row.name.trim(), row.value);
    custom = true;
  }
  for (const [name, value] of new Headers(auth)) headers.set(name, value);
  return { headers: Object.fromEntries(headers), redirect: custom ? "error" : "follow" };
}
