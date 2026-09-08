import { createHash } from "node:crypto";

/**
 * Granola CSV import parsing. Pure module: no fs, no Electron.
 *
 * Granola's official CSV export (Settings → Profile → Generate CSV) is the only
 * data source available since Granola encrypted its local cache (v6+). The column
 * set is undocumented and has varied between exports, so parsing is header-driven
 * and tolerant: unknown columns are ignored, the transcript column is optional,
 * and per-row problems produce warnings instead of aborting the import.
 */

/**
 * RFC-4180 CSV tokenizer. Handles quoted fields with embedded commas/newlines,
 * doubled-quote escapes, CRLF and LF endings, and a leading UTF-8 BOM.
 * An unclosed quote at EOF is recovered (rest of input becomes the field).
 *
 * @param {string} text
 * @returns {{ rows: string[][], warnings: Array<{ code: string }> }}
 */
export function parseCsv(text) {
  const warnings = [];
  let src = String(text ?? "");
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === "") {
      inQuotes = true;
    } else if (ch === ",") {
      pushField();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      pushRow();
    } else {
      field += ch;
    }
  }

  if (inQuotes) warnings.push({ code: "MALFORMED_QUOTE_RECOVERED" });
  if (field !== "" || row.length > 0) pushRow();

  return { rows, warnings };
}

// Reconciled against a real 2026-08-24 export: document_id, user_email,
// document_title, workspace_name, document_created, summary, notes, transcript.
// "summary" is the AI notes; "notes" is what the user typed themselves.
const HEADER_SYNONYMS = {
  id: ["id", "noteid", "docid", "documentid"],
  title: ["title", "documenttitle", "notetitle", "name", "meetingtitle"],
  summary: ["summary", "ainotes", "aisummary", "enhancednotes", "content"],
  userNotes: ["notes", "mynotes", "usernotes"],
  transcript: ["transcript", "transcription", "fulltranscript"],
  createdAt: [
    "createdat",
    "documentcreated",
    "date",
    "created",
    "meetingdate",
    "starttime",
    "datetime",
  ],
  attendees: ["attendees", "participants", "people", "guests"],
};

const normalizeHeader = (header) =>
  String(header ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/**
 * Map a CSV header row onto the note fields the importer understands.
 * Matching is case/space/punctuation-insensitive; unknown columns are
 * reported but never fatal.
 *
 * @param {string[]} headerRow
 * @returns {{
 *   mapping: Partial<Record<"id"|"title"|"summary"|"userNotes"|"transcript"|"createdAt"|"attendees", number>>,
 *   unknown: string[],
 *   warnings: Array<{ code: string, detail?: string }>,
 * }}
 */
export function mapHeaders(headerRow) {
  const warnings = [];
  const normalized = headerRow.map(normalizeHeader);
  const claimed = new Set();
  const mapping = {};

  for (const [field, synonyms] of Object.entries(HEADER_SYNONYMS)) {
    for (const synonym of synonyms) {
      const index = normalized.findIndex((header, i) => header === synonym && !claimed.has(i));
      if (index !== -1) {
        mapping[field] = index;
        claimed.add(index);
        break;
      }
    }
  }

  const unknown = headerRow.filter((_, i) => !claimed.has(i));
  if (unknown.length > 0) {
    warnings.push({ code: "UNKNOWN_COLUMNS_IGNORED", detail: unknown.join(", ") });
  }

  return { mapping, unknown, warnings };
}

const pad2 = (value) => String(value).padStart(2, "0");

const formatSqliteUtc = (date) =>
  `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ` +
  `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;

const ISO_DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const US_DATE_RE =
  /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i;

/**
 * Normalize a CSV date cell to SQLite's `"YYYY-MM-DD HH:MM:SS"` UTC format
 * (matching CURRENT_TIMESTAMP rows so imported notes sort correctly), or null
 * when the value can't be parsed. Timezone-less values are treated as UTC for
 * determinism; slash dates are read month-first (Granola is US-based) unless
 * the month would be impossible.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeDate(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  if (/^\d{10,13}$/.test(raw)) {
    const num = Number(raw);
    return formatSqliteUtc(new Date(raw.length >= 13 ? num : num * 1000));
  }

  let match = raw.match(ISO_DATE_RE);
  if (match) {
    const [, year, month, day, hour = "00", minute = "00", second = "00", tz] = match;
    if (tz && tz !== "Z") {
      const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${tz}`);
      return Number.isNaN(date.getTime()) ? null : formatSqliteUtc(date);
    }
    return formatSqliteUtc(new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second)));
  }

  match = raw.match(US_DATE_RE);
  if (match) {
    const [, monthRaw, dayRaw, year, hourRaw = "0", minuteRaw = "0", secondRaw = "0", ampm] = match;
    let month = +monthRaw;
    let day = +dayRaw;
    if (month > 12 && day <= 12) [month, day] = [day, month];
    if (month > 12 || day > 31) return null;
    let hour = +hourRaw;
    if (ampm?.toUpperCase() === "PM" && hour < 12) hour += 12;
    if (ampm?.toUpperCase() === "AM" && hour === 12) hour = 0;
    return formatSqliteUtc(new Date(Date.UTC(+year, month - 1, day, hour, +minuteRaw, +secondRaw)));
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : formatSqliteUtc(parsed);
}

const SPEAKER_LINE_RE = /^([^:\n]{1,60}):\s+(\S.*)$/;
const SPEAKER_LINE_RATIO = 0.6;
const SPEAKER_NAME_MAX_WORDS = 4;

const matchSpeakerLine = (line) => {
  const match = line.match(SPEAKER_LINE_RE);
  if (!match) return null;
  const speakerName = match[1].trim();
  if (speakerName.split(/\s+/).length > SPEAKER_NAME_MAX_WORDS) return null;
  return { speakerName, text: match[2].trim() };
};

/**
 * Convert a transcript cell into `notes.transcript` segments. When most lines
 * look like "Speaker: text" (and at least two distinct speakers appear), each
 * line becomes its own segment with the name locked as a user-provided mapping
 * so diarization never fights it; otherwise each paragraph becomes its own
 * unlabeled segment.
 * Timestamps are epoch-ms anchored at the note's creation time, +1ms per
 * segment to preserve order (the app rebases relative offsets on export).
 *
 * @param {unknown} text
 * @param {number} anchorMs
 * @returns {Array<object>}
 */
export function parseTranscriptToSegments(text, anchorMs) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return [];

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const parsedLines = lines.map(matchSpeakerLine);
  const speakerLines = parsedLines.filter(Boolean);
  const distinctSpeakers = new Set(speakerLines.map((line) => line.speakerName));

  const useSpeakerMode =
    speakerLines.length / lines.length >= SPEAKER_LINE_RATIO && distinctSpeakers.size >= 2;
  if (!useSpeakerMode) {
    return lines.map((line, i) => ({ text: line, source: "system", timestamp: anchorMs + i }));
  }

  const segments = [];
  lines.forEach((line, i) => {
    const parsed = parsedLines[i];
    if (parsed) {
      segments.push({
        text: parsed.text,
        source: "system",
        timestamp: anchorMs + segments.length,
        speakerName: parsed.speakerName,
        speakerLocked: true,
        speakerLockSource: "user",
      });
    } else if (segments.length > 0) {
      segments[segments.length - 1].text += `\n${line}`;
    } else {
      segments.push({ text: line, source: "system", timestamp: anchorMs });
    }
  });
  return segments;
}

/**
 * Deterministic RFC-4122-shaped UUID from a stable key, so re-running the same
 * import maps to the same `client_note_id` and the UNIQUE index makes the
 * operation idempotent.
 *
 * @param {string} key
 * @returns {string}
 */
export function deterministicUuid(key) {
  const hex = createHash("sha256").update(`openwhispr-granola:${key}`).digest("hex");
  const withVersion = `4${hex.slice(13, 16)}`;
  const variantNibble = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const withVariant = `${variantNibble}${hex.slice(17, 20)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${withVersion}-${withVariant}-${hex.slice(20, 32)}`;
}

const shortHash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);

/**
 * Allocate stable note keys across every CSV file in one Granola import.
 * The first missing-id row retains the released fallback identity; only later
 * collisions receive a versioned key.
 *
 * @returns {(fields: {
 *   id: string,
 *   title: string,
 *   rawDate: string,
 * }) => string}
 */
export function createGranolaNoteKeyAllocator() {
  const claimedLegacyFallbackKeys = new Set();
  const fallbackOccurrences = new Map();

  return ({ id, title, rawDate }) => {
    if (id) return id;

    const legacyFallbackKey = shortHash(`${title}|${rawDate}`);
    const fallbackTuple = JSON.stringify([title, rawDate]);
    const occurrence = fallbackOccurrences.get(fallbackTuple) ?? 0;
    fallbackOccurrences.set(fallbackTuple, occurrence + 1);

    if (!claimedLegacyFallbackKeys.has(legacyFallbackKey)) {
      claimedLegacyFallbackKeys.add(legacyFallbackKey);
      return legacyFallbackKey;
    }

    return shortHash(JSON.stringify(["v2", title, rawDate, occurrence]));
  };
}

const NAME_EMAIL_RE = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/;
const BARE_EMAIL_RE = /^\S+@\S+\.\S+$/;

// Consumers of notes.participants require an email (e.g. SpeakerPicker reads
// p.email unguarded), so name-only tokens are dropped rather than emitted.
const parseAttendees = (cell) =>
  String(cell ?? "")
    .split(/[,;\n]/)
    .map((token) => token.trim())
    .filter(Boolean)
    .flatMap((token) => {
      const named = token.match(NAME_EMAIL_RE);
      if (named) return [{ displayName: named[1] || named[2], email: named[2] }];
      if (BARE_EMAIL_RE.test(token)) return [{ displayName: token, email: token }];
      return [];
    });

/**
 * Parse a Granola CSV export into insert-ready note rows.
 *
 * @param {string} text
 * @param {{ allocateNoteKey?: ReturnType<typeof createGranolaNoteKeyAllocator> }} [options]
 * @returns {{
 *   ok: boolean,
 *   error?: { code: "EMPTY_FILE"|"HEADERS_UNRECOGNIZED"|"NO_DATA_ROWS" },
 *   headerInfo: { mapped: Record<string, string>, unknown: string[] },
 *   notes: Array<{
 *     clientNoteId: string, sourceFile: string, title: string, content: string,
 *     transcript: string | null, participants: string | null, createdAt: string | null,
 *   }>,
 *   warnings: Array<{ code: string, row?: number, detail?: string }>,
 * }}
 */
export function parseGranolaCsv(text, { allocateNoteKey = createGranolaNoteKeyAllocator() } = {}) {
  const src = String(text ?? "");
  const emptyHeaderInfo = { mapped: {}, unknown: [] };
  if (!src.trim()) {
    return {
      ok: false,
      error: { code: "EMPTY_FILE" },
      headerInfo: emptyHeaderInfo,
      notes: [],
      warnings: [],
    };
  }

  const { rows, warnings: csvWarnings } = parseCsv(src);
  const [headerRow, ...dataRows] = rows;
  const { mapping, unknown, warnings: headerWarnings } = mapHeaders(headerRow);
  const warnings = [...csvWarnings, ...headerWarnings];
  const headerInfo = {
    mapped: Object.fromEntries(
      Object.entries(mapping).map(([field, index]) => [field, headerRow[index]])
    ),
    unknown,
  };

  if (
    mapping.title === undefined &&
    mapping.summary === undefined &&
    mapping.userNotes === undefined
  ) {
    return { ok: false, error: { code: "HEADERS_UNRECOGNIZED" }, headerInfo, notes: [], warnings };
  }
  if (dataRows.length === 0) {
    return { ok: false, error: { code: "NO_DATA_ROWS" }, headerInfo, notes: [], warnings };
  }
  if (mapping.transcript === undefined) {
    warnings.push({ code: "TRANSCRIPT_COLUMN_MISSING" });
  }

  const notes = [];
  dataRows.forEach((rawRow, i) => {
    const rowNumber = i + 2; // 1-based line number in the CSV, counting the header
    if (rawRow.every((value) => !value.trim())) {
      warnings.push({ code: "ROW_EMPTY_SKIPPED", row: rowNumber });
      return;
    }

    let row = rawRow;
    if (row.length !== headerRow.length) {
      warnings.push({ code: "ROW_COLUMN_COUNT_MISMATCH", row: rowNumber });
      row = row.slice(0, headerRow.length);
      while (row.length < headerRow.length) row.push("");
    }
    const cell = (field) =>
      mapping[field] === undefined ? "" : (row[mapping[field]] ?? "").trim();

    // AI summary first, the user's own typed notes beneath it; either alone works.
    const content = [cell("summary"), cell("userNotes")].filter(Boolean).join("\n\n---\n\n");
    if (!content) {
      warnings.push({ code: "ROW_NO_SUMMARY_SKIPPED", row: rowNumber });
      return;
    }

    let title = cell("title");
    if (!title) {
      title = "Untitled";
      warnings.push({ code: "TITLE_MISSING_DEFAULTED", row: rowNumber });
    }

    const rawDate = cell("createdAt");
    const createdAt = rawDate ? normalizeDate(rawDate) : null;
    if (rawDate && createdAt === null) {
      warnings.push({ code: "DATE_UNPARSEABLE", row: rowNumber, detail: rawDate });
    }

    const id = cell("id");
    const rawTranscript = cell("transcript");
    const rawAttendees = cell("attendees");
    const key = allocateNoteKey({
      id,
      title,
      rawDate,
    });

    const anchorMs = createdAt ? Date.parse(`${createdAt.replace(" ", "T")}Z`) : 0;
    const segments = parseTranscriptToSegments(rawTranscript, anchorMs);
    const attendees = parseAttendees(rawAttendees);

    notes.push({
      clientNoteId: deterministicUuid(key),
      sourceFile: `granola:${key}`,
      title,
      content,
      transcript: segments.length > 0 ? JSON.stringify(segments) : null,
      participants: attendees.length > 0 ? JSON.stringify(attendees) : null,
      createdAt,
    });
  });

  return { ok: true, headerInfo, notes, warnings };
}
