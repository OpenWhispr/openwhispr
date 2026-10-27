/**
 * Dragon "Export custom word and phrase list" parsing. Pure module: no fs, no
 * Electron. Only the written form of each entry is kept — spoken forms are
 * dropped by design (spec §2).
 *
 * Verified shape (Nuance help + real Dragon 13/14 exports; evidence in the
 * titan spec's assets):
 *   TXT  optional "@Version=Plato-UTF8" first line, one entry per line,
 *        "written\\spoken" pairs (a single "\" before Dragon 11).
 *   XML  <WordExport> root, one <Word name="written\\spoken"> per entry,
 *        declared encoding utf-16; word properties live in the element body
 *        and have no public schema, so they are ignored.
 */

// The API's limits (openwhispr-api lib/schemas.ts, lib/dictionary-service.ts):
// a longer word fails its whole sync batch, and words past the cap never sync.
export const DICTIONARY_WORD_MAX_LENGTH = 100;
export const DICTIONARY_MAX_WORDS = 5000;

const HEADER_LINE = /^@version\s*=\s*plato(-utf8)?$/i;

const XML_NAME_ATTRIBUTE = /\sname="([^"]*)"/;
// Only a file decoded with the wrong encoding puts control characters in a
// word, and Postgres can't store the NUL that a wrong UTF-16 guess produces.
const CONTROL_CHARACTER = /\p{Cc}/u;
const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, ref) => {
    if (ref[0] !== "#") return XML_ENTITIES[ref.toLowerCase()];
    const code =
      ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    if (!Number.isFinite(code) || code > 0x10ffff) return _m;
    return String.fromCodePoint(code);
  });
}

// Text in an 8-bit encoding has no NUL bytes, so a file with them is UTF-16
// without a BOM; ASCII characters put the NUL second in little-endian.
function bomlessUtf16(b) {
  const end = Math.min(b.length, 4096) - 1;
  let evenNuls = 0;
  let oddNuls = 0;
  for (let i = 0; i < end; i += 2) {
    if (b[i] === 0) evenNuls += 1;
    if (b[i + 1] === 0) oddNuls += 1;
  }
  if (evenNuls === 0 && oddNuls === 0) return null;
  return oddNuls >= evenNuls ? "utf-16le" : "utf-16be";
}

export function decodeDragonExport(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const utf16 =
    b[0] === 0xff && b[1] === 0xfe
      ? "utf-16le"
      : b[0] === 0xfe && b[1] === 0xff
        ? "utf-16be"
        : bomlessUtf16(b);
  if (utf16) return { text: new TextDecoder(utf16).decode(b), encoding: utf16 };
  // TextDecoder drops a UTF-8 BOM on its own; hand-made lists are often cp1252.
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(b), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(b), encoding: "windows-1252" };
  }
}

// Nuance's own rule: the LAST separator wins, because a written form can
// itself contain a backslash. "\\" is the Dragon 11+ separator; a lone "\"
// is the pre-11 one and what users type when they "fix" the double.
function writtenForm(entry) {
  const idx = entry.includes("\\\\") ? entry.lastIndexOf("\\\\") : entry.lastIndexOf("\\");
  if (idx === -1) return entry;
  return entry.slice(0, idx).trim();
}

function collect(entries) {
  const byLower = new Map();
  const warnings = [];
  let duplicatesInFile = 0;
  for (const { value, line } of entries) {
    const written = writtenForm(value);
    if (!written) {
      warnings.push({ code: "AMBIGUOUS_BACKSLASH", line });
      continue;
    }
    if (CONTROL_CHARACTER.test(written) || !written.isWellFormed()) {
      warnings.push({ code: "UNREADABLE_CHARACTERS", line });
      continue;
    }
    if (written.length > DICTIONARY_WORD_MAX_LENGTH) {
      warnings.push({ code: "TOO_LONG", line });
      continue;
    }
    const lower = written.toLowerCase();
    if (byLower.has(lower)) {
      duplicatesInFile += 1;
      continue;
    }
    byLower.set(lower, written);
  }
  return { words: [...byLower.values()], totalEntries: entries.length, duplicatesInFile, warnings };
}

function parseTxt(src) {
  const entries = [];
  let header = null;
  src.split(/\r\n|\r|\n/).forEach((raw, i) => {
    const value = raw.trim();
    if (!value) return;
    if (header === null && entries.length === 0 && HEADER_LINE.test(value)) {
      header = value;
      return;
    }
    entries.push({ value, line: i + 1 });
  });
  const result = collect(entries);
  if (result.words.length === 0) return { ok: false, error: { code: "EMPTY_FILE" } };
  return { ok: true, format: "txt", header, ...result };
}

// Index of the ">" closing a start tag, skipping any inside quoted values.
function tagEnd(src, from) {
  let quoted = false;
  for (let i = from; i < src.length; i += 1) {
    if (src[i] === '"') quoted = !quoted;
    else if (src[i] === ">" && !quoted) return i;
  }
  return -1;
}

// Whether the next markup after a start tag is a child element (a property).
function opensChild(src, from) {
  let i = from;
  while (i < src.length && /\s/.test(src[i])) i += 1;
  return src[i] === "<" && /[A-Za-z]/.test(src[i + 1] ?? "");
}

// One forward scan, not a regex per tag: a pattern that looks for a tag's
// end from every "<Word" rereads the rest of the file whenever a tag never
// closes, which turns a few hundred KB into minutes. No XML parser either: the
// schema is one root and one attribute, the DOCTYPE points at a dead host, and
// nothing may ever try to fetch it.
function parseXml(src) {
  if (!/<WordExport\b/.test(src)) return { ok: false, error: { code: "UNSUPPORTED_XML" } };
  const entries = [];
  let propertiesIgnored = false;
  let from = 0;
  for (;;) {
    const start = src.indexOf("<Word", from);
    if (start === -1) break;
    from = start + "<Word".length;
    if (/\w/.test(src[from] ?? "")) continue; // <WordExport>, <Words>
    const end = tagEnd(src, from);
    if (end === -1) break;
    const tag = src.slice(start, end + 1);
    const name = XML_NAME_ATTRIBUTE.exec(tag);
    const value = name ? decodeEntities(name[1]).trim() : "";
    if (value) entries.push({ value, line: entries.length + 1 });
    if (!propertiesIgnored && !tag.endsWith("/>")) propertiesIgnored = opensChild(src, end + 1);
    from = end + 1;
  }
  const result = collect(entries);
  if (result.words.length === 0) return { ok: false, error: { code: "EMPTY_FILE" } };
  if (propertiesIgnored) result.warnings.push({ code: "XML_PROPERTIES_IGNORED" });
  return { ok: true, format: "xml", header: null, ...result };
}

/**
 * @param {string} text
 * @returns {{ ok: false, error: { code: "EMPTY_FILE" | "UNSUPPORTED_XML" } }
 *   | { ok: true, format: "txt" | "xml", header: string | null, words: string[],
 *       totalEntries: number, duplicatesInFile: number,
 *       warnings: Array<{ code: string, line?: number }> }}
 */
export function parseDragonWordList(text) {
  const src = String(text ?? "");
  return src.trimStart().startsWith("<") ? parseXml(src) : parseTxt(src);
}

// New words in file order, stopping at the dictionary cap.
export function planDragonImport(words, existingWords) {
  const existing = new Set(existingWords.map((w) => w.trim().toLowerCase()));
  const fresh = words.filter((w) => !existing.has(w.toLowerCase()));
  const add = fresh.slice(0, Math.max(0, DICTIONARY_MAX_WORDS - existing.size));
  return {
    add,
    skippedExisting: words.length - fresh.length,
    overLimit: fresh.length - add.length,
  };
}
