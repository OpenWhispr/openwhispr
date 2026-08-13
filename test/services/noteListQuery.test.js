const test = require("node:test");
const assert = require("node:assert/strict");

test("note snapshot pagination includes an id tie-breaker", async () => {
  const { buildNotesListPath } = await import("../../src/services/noteListQuery.ts");
  const path = buildNotesListPath({
    limit: 50,
    before: "2026-07-22T12:00:00.000Z",
    scope: "all",
    cursorId: "note-50",
  });

  assert.equal(
    path,
    "/api/notes/list?limit=50&before=2026-07-22T12%3A00%3A00.000Z&scope=all&before_id=note-50"
  );
});

test("note delta pagination includes an id tie-breaker", async () => {
  const { buildNotesListPath } = await import("../../src/services/noteListQuery.ts");
  const path = buildNotesListPath({
    limit: 50,
    since: "2026-07-22T12:00:00.000Z",
    scope: "all",
    cursorId: "note-50",
  });

  assert.equal(
    path,
    "/api/notes/list?limit=50&since=2026-07-22T12%3A00%3A00.000Z&scope=all&since_id=note-50"
  );
});
