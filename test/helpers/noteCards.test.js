const test = require("node:test");
const assert = require("node:assert/strict");
const { extractNoteCards } = require("../../src/components/chat/noteCards.ts");

const completed = (name, metadata, result) => ({
  id: "tc-1",
  name,
  arguments: "{}",
  status: "completed",
  result,
  metadata,
});
const extractCards = (toolCalls) => extractNoteCards(toolCalls, "Note");

test("note tools with single-object metadata still produce one card each", () => {
  const cards = extractCards([
    completed("create_note", { id: 7, title: "Kickoff" }),
    completed("get_note", { id: 9 }, 'Retrieved note: "Roadmap"'),
  ]);
  assert.deepEqual(cards, [
    { noteId: 7, title: "Kickoff" },
    { noteId: 9, title: "Roadmap" },
  ]);
});

test("search_notes array metadata produces a card per hit, skipping null and non-numeric ids", () => {
  const cards = extractCards([
    completed("search_notes", [
      { id: 3, title: "Sales sync" },
      { id: null, title: "Cloud-only hit" },
      { id: "b1c2-uuid", title: "Cloud id hit" },
      { id: 4, title: "" },
    ]),
  ]);
  assert.deepEqual(cards, [
    { noteId: 3, title: "Sales sync" },
    { noteId: 4, title: "Note" },
  ]);
});

test("search cards dedupe against note-tool cards and each other", () => {
  const cards = extractCards([
    completed("update_note", { id: 3, title: "Sales sync" }),
    completed("search_notes", [
      { id: 3, title: "Sales sync" },
      { id: 5, title: "Q3 plan" },
    ]),
    completed("search_notes", [{ id: 5, title: "Q3 plan" }]),
  ]);
  assert.deepEqual(cards, [
    { noteId: 3, title: "Sales sync" },
    { noteId: 5, title: "Q3 plan" },
  ]);
});

test("search cards cap at 5 across the whole turn", () => {
  const hits = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, title: `Note ${i + 1}` }));
  const cards = extractCards([
    completed("search_notes", hits.slice(0, 4)),
    completed("search_notes", hits.slice(4)),
  ]);
  assert.equal(cards.length, 5);
});

test("incomplete or unknown tools produce nothing", () => {
  const cards = extractCards([
    { ...completed("search_notes", [{ id: 1, title: "x" }]), status: "executing" },
    completed("copy_to_clipboard", { id: 2 }),
  ]);
  assert.deepEqual(cards, []);
});

test("skips non-positive, non-integer, and coerced falsy note ids", () => {
  const cards = extractCards([
    completed("create_note", { id: 0, title: "Zero ID" }),
    completed("update_note", { id: -1, title: "Negative ID" }),
    completed("get_note", { id: 2.5, title: "Float ID" }),
    completed("search_notes", [
      { id: 0, title: "Zero hit" },
      { id: -3, title: "Negative hit" },
      { id: 1.8, title: "Float hit" },
      { id: false, title: "Boolean hit" },
      { id: "", title: "Empty string hit" },
      { id: 10, title: "Valid Note" },
    ]),
  ]);
  assert.deepEqual(cards, [{ noteId: 10, title: "Valid Note" }]);
});

test("falls back to default title for whitespace-only titles in metadata or hits", () => {
  const cards = extractCards([
    completed("create_note", { id: 12, title: "   \n\t " }),
    completed("search_notes", [{ id: 14, title: "   " }]),
  ]);
  assert.deepEqual(cards, [
    { noteId: 12, title: "Note" },
    { noteId: 14, title: "Note" },
  ]);
});
