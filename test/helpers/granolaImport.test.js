const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const load = () => import("../../src/helpers/granolaImport.js");

// ---------------------------------------------------------------------------
// parseCsv — RFC-4180 tokenizer
// ---------------------------------------------------------------------------

test("parseCsv splits simple rows and fields", async () => {
  const { parseCsv } = await load();
  const { rows, warnings } = parseCsv("a,b,c\n1,2,3");
  assert.deepEqual(rows, [
    ["a", "b", "c"],
    ["1", "2", "3"],
  ]);
  assert.deepEqual(warnings, []);
});

test("parseCsv keeps embedded commas and newlines inside quoted fields", async () => {
  const { parseCsv } = await load();
  const { rows } = parseCsv('title,notes\n"Meeting, one","line1\nline2"');
  assert.deepEqual(rows, [
    ["title", "notes"],
    ["Meeting, one", "line1\nline2"],
  ]);
});

test('parseCsv unescapes doubled quotes ("") inside quoted fields', async () => {
  const { parseCsv } = await load();
  const { rows } = parseCsv('a\n"He said ""hi"" twice"');
  assert.deepEqual(rows, [["a"], ['He said "hi" twice']]);
});

test("parseCsv treats CRLF line endings like LF", async () => {
  const { parseCsv } = await load();
  const { rows } = parseCsv("a,b\r\n1,2\r\n");
  assert.deepEqual(rows, [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("parseCsv preserves CRLF inside quoted fields as-is", async () => {
  const { parseCsv } = await load();
  const { rows } = parseCsv('a\n"x\r\ny"');
  assert.deepEqual(rows, [["a"], ["x\r\ny"]]);
});

test("parseCsv strips a leading UTF-8 BOM", async () => {
  const { parseCsv } = await load();
  const { rows } = parseCsv("﻿a,b\n1,2");
  assert.deepEqual(rows, [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("parseCsv ignores a trailing newline instead of producing an empty row", async () => {
  const { parseCsv } = await load();
  const { rows } = parseCsv("a,b\n1,2\n");
  assert.equal(rows.length, 2);
});

test("parseCsv recovers from an unclosed quote at EOF with a warning", async () => {
  const { parseCsv } = await load();
  const { rows, warnings } = parseCsv('a\n"unterminated rest');
  assert.deepEqual(rows, [["a"], ["unterminated rest"]]);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "MALFORMED_QUOTE_RECOVERED");
});

// ---------------------------------------------------------------------------
// mapHeaders — fuzzy, header-driven column mapping
// ---------------------------------------------------------------------------

test("mapHeaders maps exact lowercase headers to column indices", async () => {
  const { mapHeaders } = await load();
  const { mapping, unknown } = mapHeaders([
    "id",
    "title",
    "summary",
    "transcript",
    "created_at",
    "attendees",
  ]);
  assert.deepEqual(mapping, {
    id: 0,
    title: 1,
    summary: 2,
    transcript: 3,
    createdAt: 4,
    attendees: 5,
  });
  assert.deepEqual(unknown, []);
});

test("mapHeaders matches case, space, and punctuation variants", async () => {
  const { mapHeaders } = await load();
  const { mapping } = mapHeaders(["Note Title", "AI Notes", "Created At"]);
  assert.deepEqual(mapping, { title: 0, summary: 1, createdAt: 2 });
});

test("mapHeaders records unknown columns with a warning instead of failing", async () => {
  const { mapHeaders } = await load();
  const { mapping, unknown, warnings } = mapHeaders(["title", "summary", "workspace"]);
  assert.deepEqual(mapping, { title: 0, summary: 1 });
  assert.deepEqual(unknown, ["workspace"]);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "UNKNOWN_COLUMNS_IGNORED");
});

test("mapHeaders leaves transcript unmapped when the column is absent", async () => {
  const { mapHeaders } = await load();
  const { mapping } = mapHeaders(["title", "summary", "created_at"]);
  assert.equal(mapping.transcript, undefined);
});

test("mapHeaders maps summary and user-notes columns independently", async () => {
  const { mapHeaders } = await load();
  const { mapping, unknown } = mapHeaders(["notes", "summary", "title"]);
  assert.equal(mapping.summary, 1);
  assert.equal(mapping.userNotes, 0);
  assert.deepEqual(unknown, []);
});

// ---------------------------------------------------------------------------
// normalizeDate — anything plausible → SQLite "YYYY-MM-DD HH:MM:SS" UTC
// ---------------------------------------------------------------------------

test("normalizeDate converts ISO-8601 with Z", async () => {
  const { normalizeDate } = await load();
  assert.equal(normalizeDate("2026-07-15T14:30:05Z"), "2026-07-15 14:30:05");
});

test("normalizeDate converts ISO-8601 with a UTC offset", async () => {
  const { normalizeDate } = await load();
  assert.equal(normalizeDate("2026-07-15T14:30:00-04:00"), "2026-07-15 18:30:00");
});

test("normalizeDate treats ISO-8601 without timezone as UTC for determinism", async () => {
  const { normalizeDate } = await load();
  assert.equal(normalizeDate("2026-07-15T14:30:00"), "2026-07-15 14:30:00");
  assert.equal(normalizeDate("2026-07-15 14:30"), "2026-07-15 14:30:00");
});

test("normalizeDate accepts a bare date", async () => {
  const { normalizeDate } = await load();
  assert.equal(normalizeDate("2026-07-15"), "2026-07-15 00:00:00");
});

test("normalizeDate accepts epoch milliseconds and seconds", async () => {
  const { normalizeDate } = await load();
  const ms = Date.UTC(2026, 0, 2, 3, 4, 5);
  assert.equal(normalizeDate(String(ms)), "2026-01-02 03:04:05");
  assert.equal(normalizeDate(String(ms / 1000)), "2026-01-02 03:04:05");
});

test("normalizeDate accepts US M/D/YYYY with 12-hour time", async () => {
  const { normalizeDate } = await load();
  assert.equal(normalizeDate("7/15/2026, 2:30 PM"), "2026-07-15 14:30:00");
  assert.equal(normalizeDate("7/15/2026 12:05 AM"), "2026-07-15 00:05:00");
  assert.equal(normalizeDate("7/15/2026"), "2026-07-15 00:00:00");
});

test("normalizeDate reinterprets day-first order when the month is impossible", async () => {
  const { normalizeDate } = await load();
  assert.equal(normalizeDate("13/5/2026"), "2026-05-13 00:00:00");
});

test("normalizeDate returns null for garbage or empty input", async () => {
  const { normalizeDate } = await load();
  assert.equal(normalizeDate("not a date"), null);
  assert.equal(normalizeDate(""), null);
  assert.equal(normalizeDate(undefined), null);
});

// ---------------------------------------------------------------------------
// parseTranscriptToSegments — "Speaker: text" lines → native segments
// ---------------------------------------------------------------------------

test("parseTranscriptToSegments splits speaker-labeled lines into locked segments", async () => {
  const { parseTranscriptToSegments } = await load();
  const segments = parseTranscriptToSegments(
    "Alice: Hello there\nBob: Hi Alice\nAlice: How are you?",
    1000
  );
  assert.deepEqual(segments, [
    {
      text: "Hello there",
      source: "system",
      timestamp: 1000,
      speakerName: "Alice",
      speakerLocked: true,
      speakerLockSource: "user",
    },
    {
      text: "Hi Alice",
      source: "system",
      timestamp: 1001,
      speakerName: "Bob",
      speakerLocked: true,
      speakerLockSource: "user",
    },
    {
      text: "How are you?",
      source: "system",
      timestamp: 1002,
      speakerName: "Alice",
      speakerLocked: true,
      speakerLockSource: "user",
    },
  ]);
});

test("parseTranscriptToSegments falls back to one segment per paragraph for free text", async () => {
  const { parseTranscriptToSegments } = await load();
  const segments = parseTranscriptToSegments("Just a flowing paragraph.\nNo speakers here.", 500);
  assert.deepEqual(segments, [
    { text: "Just a flowing paragraph.", source: "system", timestamp: 500 },
    { text: "No speakers here.", source: "system", timestamp: 501 },
  ]);
});

test("parseTranscriptToSegments stays unlabeled below the speaker-line threshold", async () => {
  const { parseTranscriptToSegments } = await load();
  const text =
    "Alice: Hi\nA long unstructured line without any label\nAnother unstructured line here";
  const segments = parseTranscriptToSegments(text, 0);
  assert.equal(segments.length, 3);
  assert.ok(segments.every((segment) => segment.speakerName === undefined));
});

test("parseTranscriptToSegments requires two distinct speakers to label lines", async () => {
  const { parseTranscriptToSegments } = await load();
  const segments = parseTranscriptToSegments("Alice: Hi\nAlice: Bye", 0);
  assert.ok(segments.every((segment) => segment.speakerName === undefined));
});

test("parseTranscriptToSegments does not mistake URLs for speaker labels", async () => {
  const { parseTranscriptToSegments } = await load();
  const segments = parseTranscriptToSegments(
    "https://example.com/foo: bar baz\nhttps://example.com/x: qux quux",
    0
  );
  assert.ok(segments.every((segment) => segment.speakerName === undefined));
});

test("parseTranscriptToSegments rejects speaker names longer than four words", async () => {
  const { parseTranscriptToSegments } = await load();
  const segments = parseTranscriptToSegments(
    "This is definitely not a speaker name: because it is long\nAnd this line is even less like one: yes",
    0
  );
  assert.ok(segments.every((segment) => segment.speakerName === undefined));
});

test("parseTranscriptToSegments returns no segments for empty input", async () => {
  const { parseTranscriptToSegments } = await load();
  assert.deepEqual(parseTranscriptToSegments("", 0), []);
  assert.deepEqual(parseTranscriptToSegments(null, 0), []);
});

test("parseTranscriptToSegments appends unlabeled continuation lines to the previous segment", async () => {
  const { parseTranscriptToSegments } = await load();
  const segments = parseTranscriptToSegments(
    "Alice: First point\ncontinued thought\nBob: Reply\nCarol: Another\nDave: More\nEve: Yet more",
    0
  );
  assert.equal(segments[0].text, "First point\ncontinued thought");
  assert.equal(segments.length, 5);
});

// ---------------------------------------------------------------------------
// deterministicUuid — stable identity for idempotent re-imports
// ---------------------------------------------------------------------------

test("deterministicUuid produces a valid RFC-4122-shaped UUID", async () => {
  const { deterministicUuid } = await load();
  assert.match(
    deterministicUuid("granola:abc123"),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
});

test("deterministicUuid is stable for the same key and distinct across keys", async () => {
  const { deterministicUuid } = await load();
  assert.equal(deterministicUuid("granola:abc"), deterministicUuid("granola:abc"));
  assert.notEqual(deterministicUuid("granola:abc"), deterministicUuid("granola:abd"));
});

// ---------------------------------------------------------------------------
// parseGranolaCsv — full composition
// ---------------------------------------------------------------------------

const FULL_CSV = [
  "id,title,summary,transcript,created_at,attendees",
  'doc1,Weekly Sync,"- Discussed roadmap\n- Next steps","Alice: Hello\nBob: Hi there\nAlice: Bye",2026-07-15T14:30:00Z,"Alice <alice@x.com>; Bob"',
  'doc2,1:1 with Bob,"Notes about the 1:1",,2026-07-16T09:00:00Z,',
  'doc3,,"Untitled meeting summary",,bad-date,',
].join("\n");

test("parseGranolaCsv maps a full export into insert-ready notes", async () => {
  const { parseGranolaCsv } = await load();
  const result = parseGranolaCsv(FULL_CSV);
  assert.equal(result.ok, true);
  assert.equal(result.notes.length, 3);

  const [first, second, third] = result.notes;
  assert.equal(first.title, "Weekly Sync");
  assert.equal(first.content, "- Discussed roadmap\n- Next steps");
  assert.equal(first.createdAt, "2026-07-15 14:30:00");
  assert.equal(first.sourceFile, "granola:doc1");
  // "Bob" has no email, so he is dropped: participants consumers require one.
  assert.deepEqual(JSON.parse(first.participants), [
    { displayName: "Alice", email: "alice@x.com" },
  ]);

  const segments = JSON.parse(first.transcript);
  assert.equal(first.transcript.startsWith("["), true);
  assert.equal(segments.length, 3);
  assert.equal(segments[0].speakerName, "Alice");
  assert.equal(segments[0].source, "system");
  assert.equal(segments[0].timestamp, Date.parse("2026-07-15T14:30:00Z"));

  assert.equal(second.transcript, null);
  assert.equal(second.participants, null);

  assert.equal(third.title, "Untitled");
  assert.equal(third.createdAt, null);
  const codes = result.warnings.map((w) => w.code);
  assert.ok(codes.includes("TITLE_MISSING_DEFAULTED"));
  assert.ok(codes.includes("DATE_UNPARSEABLE"));
});

test("parseGranolaCsv reports header mapping and derives stable ids", async () => {
  const { parseGranolaCsv, deterministicUuid } = await load();
  const result = parseGranolaCsv(FULL_CSV);
  assert.equal(result.headerInfo.mapped.title, "title");
  assert.deepEqual(result.headerInfo.unknown, []);
  assert.equal(result.notes[0].clientNoteId, deterministicUuid("doc1"));
  const again = parseGranolaCsv(FULL_CSV);
  assert.deepEqual(
    again.notes.map((n) => n.clientNoteId),
    result.notes.map((n) => n.clientNoteId)
  );
});

test("parseGranolaCsv preserves the released title+date fallback key for the first note", async () => {
  const { parseGranolaCsv } = await load();
  const csv = 'title,summary,created_at\nSync,"Some notes",2026-07-15T14:30:00Z';
  const result = parseGranolaCsv(csv);
  assert.equal(result.notes[0].sourceFile, "granola:0852623745d4c283");
  const again = parseGranolaCsv(csv);
  assert.equal(again.notes[0].clientNoteId, result.notes[0].clientNoteId);
});

test("parseGranolaCsv generates distinct fallback keys for notes sharing title and date without an id column", async () => {
  const { parseGranolaCsv } = await load();
  const csv = [
    "title,summary,created_at",
    'Sync,"Morning sync notes",2026-07-15T14:30:00Z',
    'Sync,"Afternoon sync notes",2026-07-15T14:30:00Z',
  ].join("\n");
  const result = parseGranolaCsv(csv);
  assert.equal(result.notes.length, 2);
  assert.notEqual(result.notes[0].clientNoteId, result.notes[1].clientNoteId);
  assert.notEqual(result.notes[0].sourceFile, result.notes[1].sourceFile);
});

test("parseGranolaCsv keeps a colliding note id when its summary changes", async () => {
  const { parseGranolaCsv } = await load();
  const originalCsv = [
    "title,summary,created_at",
    'Sync,"First meeting",2026-07-15T14:30:00Z',
    'Sync,"Original second meeting",2026-07-15T14:30:00Z',
  ].join("\n");
  const editedCsv = [
    "title,summary,created_at",
    'Sync,"First meeting",2026-07-15T14:30:00Z',
    'Sync,"Edited second meeting",2026-07-15T14:30:00Z',
  ].join("\n");

  const original = parseGranolaCsv(originalCsv);
  const edited = parseGranolaCsv(editedCsv);

  assert.equal(edited.notes[1].clientNoteId, original.notes[1].clientNoteId);
});

test("createGranolaNoteKeyAllocator disambiguates legacy title and date tuples", async () => {
  const { createGranolaNoteKeyAllocator } = await load();
  const sharedFields = { id: "" };
  const leftFields = { ...sharedFields, title: "A|B", rawDate: "C" };
  const rightFields = { ...sharedFields, title: "A", rawDate: "B|C" };

  const leftFirstAllocator = createGranolaNoteKeyAllocator();
  const leftLegacyKey = leftFirstAllocator(leftFields);
  const rightVersionedKey = leftFirstAllocator(rightFields);
  const rightFirstAllocator = createGranolaNoteKeyAllocator();
  const rightLegacyKey = rightFirstAllocator(rightFields);
  const leftVersionedKey = rightFirstAllocator(leftFields);

  assert.equal(leftLegacyKey, rightLegacyKey);
  assert.notEqual(leftVersionedKey, rightVersionedKey);
});

test("createGranolaNoteKeyAllocator counts delimiter-colliding tuples independently", async () => {
  const { createGranolaNoteKeyAllocator } = await load();
  const leftFields = { id: "", title: "A|B", rawDate: "C" };
  const rightFields = { id: "", title: "A", rawDate: "B|C" };

  const allocatorWithCollision = createGranolaNoteKeyAllocator();
  allocatorWithCollision(leftFields);
  allocatorWithCollision(rightFields);
  const secondLeftKeyAfterCollision = allocatorWithCollision(leftFields);

  const allocatorWithoutCollision = createGranolaNoteKeyAllocator();
  allocatorWithoutCollision(leftFields);
  const secondLeftKey = allocatorWithoutCollision(leftFields);

  assert.equal(secondLeftKeyAfterCollision, secondLeftKey);
});

test("parseGranolaCsv distinguishes notes with matching content but different transcripts", async () => {
  const { parseGranolaCsv } = await load();
  const csv = [
    "title,summary,created_at,transcript",
    'Sync,"Same summary",2026-07-15T14:30:00Z,"Alice: First meeting"',
    'Sync,"Same summary",2026-07-15T14:30:00Z,"Bob: Second meeting"',
    'Sync,"Same summary",2026-07-15T14:30:00Z,"Carol: Third meeting"',
  ].join("\n");
  const result = parseGranolaCsv(csv);
  assert.equal(result.notes.length, 3);
  assert.equal(new Set(result.notes.map((note) => note.clientNoteId)).size, 3);
  assert.equal(new Set(result.notes.map((note) => note.sourceFile)).size, 3);
});

test("parseGranolaCsv assigns distinct fallback keys to identical source rows", async () => {
  const { parseGranolaCsv } = await load();
  const csv = [
    "title,summary,created_at",
    'Sync,"Same summary",2026-07-15T14:30:00Z',
    'Sync,"Same summary",2026-07-15T14:30:00Z',
    'Sync,"Same summary",2026-07-15T14:30:00Z',
  ].join("\n");
  const result = parseGranolaCsv(csv);
  assert.equal(result.notes.length, 3);
  assert.equal(new Set(result.notes.map((note) => note.clientNoteId)).size, 3);
  assert.equal(new Set(result.notes.map((note) => note.sourceFile)).size, 3);
});

test("parseGranolaCsv shares fallback collision allocation across CSV files", async () => {
  const { createGranolaNoteKeyAllocator, parseGranolaCsv } = await load();
  assert.equal(typeof createGranolaNoteKeyAllocator, "function");
  const allocateNoteKey = createGranolaNoteKeyAllocator();
  const csv = 'title,summary,created_at\nSync,"Same summary",2026-07-15T14:30:00Z';
  const notes = [
    ...parseGranolaCsv(csv, { allocateNoteKey }).notes,
    ...parseGranolaCsv(csv, { allocateNoteKey }).notes,
    ...parseGranolaCsv(csv, { allocateNoteKey }).notes,
  ];
  assert.equal(new Set(notes.map((note) => note.clientNoteId)).size, 3);
  assert.equal(new Set(notes.map((note) => note.sourceFile)).size, 3);
});

test("parseGranolaCsv generates distinct fallback keys for multiple untitled notes without dates", async () => {
  const { parseGranolaCsv } = await load();
  const csv = ["summary", '"First untitled meeting"', '"Second untitled meeting"'].join("\n");
  const result = parseGranolaCsv(csv);
  assert.equal(result.notes.length, 2);
  assert.equal(result.notes[0].title, "Untitled");
  assert.equal(result.notes[1].title, "Untitled");
  assert.notEqual(result.notes[0].clientNoteId, result.notes[1].clientNoteId);
  assert.notEqual(result.notes[0].sourceFile, result.notes[1].sourceFile);
});

test("parseGranolaCsv warns once when the transcript column is missing", async () => {
  const { parseGranolaCsv } = await load();
  const result = parseGranolaCsv('title,summary\nA,"notes a"\nB,"notes b"');
  assert.equal(result.ok, true);
  const codes = result.warnings.filter((w) => w.code === "TRANSCRIPT_COLUMN_MISSING");
  assert.equal(codes.length, 1);
  assert.equal(result.notes[0].transcript, null);
});

test("parseGranolaCsv skips summary-less and empty rows with warnings", async () => {
  const { parseGranolaCsv } = await load();
  const result = parseGranolaCsv('title,summary\nHas Notes,"content"\nNo Notes,\n,\n');
  assert.equal(result.notes.length, 1);
  const codes = result.warnings.map((w) => w.code);
  assert.ok(codes.includes("ROW_NO_SUMMARY_SKIPPED"));
  assert.ok(codes.includes("ROW_EMPTY_SKIPPED"));
});

test("parseGranolaCsv pads short rows and truncates long rows with a warning", async () => {
  const { parseGranolaCsv } = await load();
  const result = parseGranolaCsv(
    'title,summary,created_at\nShort,"only two"\nLong,"x",2026-07-15,extra'
  );
  assert.equal(result.notes.length, 2);
  assert.equal(result.notes[0].createdAt, null);
  const codes = result.warnings.filter((w) => w.code === "ROW_COLUMN_COUNT_MISMATCH");
  assert.equal(codes.length, 2);
});

test("parseGranolaCsv fails loud on empty files", async () => {
  const { parseGranolaCsv } = await load();
  const result = parseGranolaCsv("");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "EMPTY_FILE");
});

test("parseGranolaCsv fails loud when neither title nor summary maps", async () => {
  const { parseGranolaCsv } = await load();
  const result = parseGranolaCsv("foo,bar\n1,2");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "HEADERS_UNRECOGNIZED");
});

test("parseGranolaCsv fails loud on a header-only file", async () => {
  const { parseGranolaCsv } = await load();
  const result = parseGranolaCsv("title,summary");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "NO_DATA_ROWS");
});

// ---------------------------------------------------------------------------
// Real export shape — reconciled against a live 2026-08-24 Granola export
// ---------------------------------------------------------------------------

const REAL_HEADER_ROW =
  "document_id,user_email,document_title,workspace_name,document_created,summary,notes,transcript";

test("parseGranolaCsv maps the real Granola export headers", async () => {
  const { parseGranolaCsv } = await load();
  const csv =
    REAL_HEADER_ROW +
    "\n" +
    'abc-123,owner@x.com,Design Review,Acme,2026-08-20T17:46:57.650Z,"# Notes\n- point",,"Para one.\nPara two."';
  const result = parseGranolaCsv(csv);
  assert.equal(result.ok, true);
  const note = result.notes[0];
  assert.equal(note.title, "Design Review");
  assert.equal(note.createdAt, "2026-08-20 17:46:57");
  assert.equal(note.sourceFile, "granola:abc-123");
  assert.equal(note.content, "# Notes\n- point");
  assert.deepEqual(result.headerInfo.unknown, ["user_email", "workspace_name"]);
});

test("parseGranolaCsv appends user notes beneath the AI summary", async () => {
  const { parseGranolaCsv } = await load();
  const result = parseGranolaCsv('title,summary,notes\nSync,"AI summary","My own notes"');
  assert.equal(result.notes[0].content, "AI summary\n\n---\n\nMy own notes");
});

test("parseGranolaCsv uses user notes as content when the summary is empty", async () => {
  const { parseGranolaCsv } = await load();
  const result = parseGranolaCsv('title,summary,notes\nSync,,"My own notes"');
  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0].content, "My own notes");
});

test("parseGranolaCsv parses the sanitized real-export fixture end to end", async () => {
  const { parseGranolaCsv } = await load();
  const fixture = fs.readFileSync(
    path.join(__dirname, "fixtures", "granola-export-sample.csv"),
    "utf8"
  );
  const result = parseGranolaCsv(fixture);
  assert.equal(result.ok, true);
  assert.equal(result.notes.length, 1);
  const note = result.notes[0];
  assert.equal(note.title, "Product Design Review");
  assert.equal(note.createdAt, "2026-08-20 17:46:57");
  assert.match(note.content, /^# UI Cleanup Priorities/);
  const segments = JSON.parse(note.transcript);
  assert.ok(segments.length > 1);
  assert.ok(segments.every((segment) => segment.speakerName === undefined));
  // Anchor derives from the stored created_at, which is second-granular.
  assert.equal(segments[0].timestamp, Date.parse("2026-08-20T17:46:57Z"));
  assert.deepEqual(result.headerInfo.unknown, ["user_email", "workspace_name"]);
  // The only warning a clean real export produces is the file-level unknown-columns one.
  assert.deepEqual(result.warnings, [
    { code: "UNKNOWN_COLUMNS_IGNORED", detail: "user_email, workspace_name" },
  ]);
});
