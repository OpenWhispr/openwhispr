import { DEBUG_LOG_KEYS } from './debugLogKeys';

/**
 * The debug log's line format, the same as the native `DebugLogFormat`: `time level area event
 * key=value…`. Numbers and booleans are written as they are; a string only under a key in
 * DEBUG_LOG_KEYS (cut to 64 characters, `error` to 160), any other string as `<n chars>`. So free
 * text — a transcript, a prompt, a note — can't reach the file by mistake.
 */
export type DebugField = string | number | boolean | null | undefined;
export type DebugFields = Record<string, DebugField>;
export type DebugLevel = 'I' | 'W' | 'E';

export const MAX_STRING = 64;
export const MAX_ERROR = 160;

const pad = (value: number, size = 2) => String(value).padStart(size, '0');

export function timestamp(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
}

const token = (text: string, max: number) => text.replace(/[^A-Za-z0-9_.:/-]/g, '_').slice(0, max);

function safe(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const quote = (text: string) =>
  text && !/[ "=]/.test(text) ? text : `"${text.replace(/"/g, "'")}"`;

function number(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function fieldValue(key: string, value: DebugField): string {
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return number(value);
  const text = String(value);
  if (key === 'error') return quote(safe(text, MAX_ERROR));
  if (DEBUG_LOG_KEYS.has(key)) return quote(safe(text, MAX_STRING));
  return `<${text.length} chars>`;
}

export function formatLine(
  date: Date,
  level: DebugLevel,
  area: string,
  event: string,
  fields: DebugFields = {},
): string {
  let line = `${timestamp(date)} ${level} ${token(area, 8).padEnd(6)} ${token(event, 40)}`;
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    line += ` ${token(key, 24)}=${fieldValue(key, value)}`;
  }
  return line;
}

/** An error as its class and message, cut short. Never pass a provider's response body. */
export function safeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return typeof error === 'string' ? error : 'unknown';
}

/** The error's machine-readable code where it has one (ApiError, a coded native error). */
export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : undefined;
}

/** 8 hex of FNV-1a, for "was it the same text?" without the text. */
export function textHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Words in a text, for counts; never the words. */
export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
/** A short id for one attempt: `d-7k2q` (d dictation, a assistant, t translation, m meeting, u upload). */
export function newRunId(kind: 'd' | 'a' | 't' | 'm' | 'u'): string {
  let id = `${kind}-`;
  for (let i = 0; i < 4; i++) id += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return id;
}

/**
 * An API call's route as logged: method and path, query values dropped, long or opaque segments
 * (tokens, signed URLs) shortened. `https://api.openwhispr.com/api/notes/12?x=1` → `/api/notes/12`.
 */
export function routeOf(url: string): string {
  let path = url;
  const match = /^[a-z]+:\/\/[^/]+(\/[^?#]*)?/i.exec(url);
  if (match) path = match[1] || '/';
  else path = url.split(/[?#]/)[0];
  return path
    .split('/')
    .map((part) => (part.length > 40 ? `<${part.length}>` : part))
    .join('/')
    .slice(0, 120);
}

/** The host only, for requests that aren't to the OpenWhispr API (a provider, a model download). */
export function hostOf(url: string): string {
  return /^[a-z]+:\/\/([^/?#]+)/i.exec(url)?.[1] ?? '';
}
