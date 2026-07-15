const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/regenerableNoteTitle.js");
const LABELS = ["Untitled Note", "New note", "New note"]; // typical localized labels

test("empty / whitespace title is regenerable", async () => {
  const { isRegenerableNoteTitle } = await load();
  assert.equal(isRegenerableNoteTitle("", LABELS), true);
  assert.equal(isRegenerableNoteTitle("   ", LABELS), true);
  assert.equal(isRegenerableNoteTitle(null, LABELS), true);
});

test("builtin English placeholders are regenerable regardless of locale labels", async () => {
  const { isRegenerableNoteTitle } = await load();
  assert.equal(isRegenerableNoteTitle("Untitled Note", []), true);
  assert.equal(isRegenerableNoteTitle("New note", []), true);
  assert.equal(isRegenerableNoteTitle("New Note", []), true); // case-insensitive
  assert.equal(isRegenerableNoteTitle("untitled", []), true);
});

test("localized placeholder labels are regenerable", async () => {
  const { isRegenerableNoteTitle } = await load();
  assert.equal(isRegenerableNoteTitle("Nueva nota", ["Nueva nota", "Nota sin título"]), true);
  assert.equal(isRegenerableNoteTitle("Neue Notiz", ["Neue Notiz"]), true);
});

test("unedited calendar event name is regenerable", async () => {
  const { isRegenerableNoteTitle } = await load();
  assert.equal(isRegenerableNoteTitle("Weekly Team Sync", LABELS, "Weekly Team Sync"), true);
});

test("a manually-typed title is preserved (not regenerable)", async () => {
  const { isRegenerableNoteTitle } = await load();
  assert.equal(isRegenerableNoteTitle("Q3 Roadmap Decisions", LABELS), false);
  // even if a calendar event exists, a title that differs from it is user-set
  assert.equal(isRegenerableNoteTitle("My own title", LABELS, "Weekly Team Sync"), false);
});
