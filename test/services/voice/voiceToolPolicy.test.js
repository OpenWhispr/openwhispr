const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../../src/services/voice/voiceToolPolicy.ts");

test("a write tool runs once per turn; a second call returns the first result without running", async () => {
  const { createWriteOnceGuard } = await load();
  const guard = createWriteOnceGuard(new Set(["create_note"]));
  let runs = 0;
  const execute = async () => {
    runs += 1;
    return { id: runs };
  };

  const first = await guard.run("create_note", execute);
  // Different arguments in the model's second call make no difference: it does not run.
  const second = await guard.run("create_note", execute);

  assert.equal(runs, 1);
  assert.deepEqual(first, { id: 1 });
  assert.equal(second.alreadyDone, true);
  assert.deepEqual(second.result, { id: 1 });
  // The blocked call must read as not done, or "make two notes" is answered as both made.
  assert.match(second.note, /second create_note call .* NOT run/);
  assert.match(second.note, /only the first one was done/);
  assert.match(second.note, /ask for the next one separately/);
  assert.doesNotMatch(second.note, /what was done/);
});

test("read-only tools are never limited", async () => {
  const { createWriteOnceGuard } = await load();
  const guard = createWriteOnceGuard(new Set(["create_note"]));
  let runs = 0;
  await guard.run("search_notes", async () => (runs += 1));
  await guard.run("search_notes", async () => (runs += 1));
  assert.equal(runs, 2);
});

test("reports each write's outcome once; an error result counts as failed", async () => {
  const { createWriteOnceGuard } = await load();
  const outcomes = [];
  const guard = createWriteOnceGuard(new Set(["update_dictionary", "create_note"]), (name, ok) =>
    outcomes.push([name, ok])
  );
  await guard.run("update_dictionary", async () => ({ error: "Dictionary is full" }));
  await guard.run("create_note", async () => ({ id: 7 }));
  await guard.run("create_note", async () => ({ id: 8 }));
  assert.deepEqual(outcomes, [
    ["update_dictionary", false],
    ["create_note", true],
  ]);
});

test("a failed write may be retried once, e.g. with a corrected note id", async () => {
  const { createWriteOnceGuard } = await load();
  const outcomes = [];
  const guard = createWriteOnceGuard(new Set(["update_note"]), (name, ok) =>
    outcomes.push([name, ok])
  );

  const first = await guard.run("update_note", async () => ({ error: "Note 12 not found" }));
  const retry = await guard.run("update_note", async () => ({ id: 21 }));
  const repeat = await guard.run("update_note", async () => ({ id: 22 }));

  assert.deepEqual(first, { error: "Note 12 not found" });
  assert.deepEqual(retry, { id: 21 });
  assert.equal(repeat.alreadyDone, true);
  assert.match(repeat.note, /NOT run/);
  assert.deepEqual(outcomes, [
    ["update_note", false],
    ["update_note", true],
  ]);
});

// A repeat after a FAILED write must not read as a plain success, or the model
// goes on to tell the user the write worked.
test("after a failed retry, further calls report the failure instead of running", async () => {
  const { createWriteOnceGuard } = await load();
  const guard = createWriteOnceGuard(new Set(["create_note"]));
  let runs = 0;
  const execute = async () => {
    runs += 1;
    return { error: "Notes are full" };
  };

  await guard.run("create_note", execute);
  await guard.run("create_note", execute);
  const third = await guard.run("create_note", execute);

  assert.equal(runs, 2);
  assert.equal(third.alreadyDone, true);
  assert.deepEqual(third.result, { error: "Notes are full" });
  assert.match(third.note, /already failed/i);
  assert.match(third.note, /Notes are full/);
});

test("a write that throws counts as failed and can be retried once", async () => {
  const { createWriteOnceGuard } = await load();
  const outcomes = [];
  const guard = createWriteOnceGuard(new Set(["create_note"]), (name, ok) =>
    outcomes.push([name, ok])
  );

  await assert.rejects(
    guard.run("create_note", async () => {
      throw new Error("database is locked");
    }),
    /database is locked/
  );
  const retry = await guard.run("create_note", async () => ({ id: 3 }));

  assert.deepEqual(retry, { id: 3 });
  assert.deepEqual(outcomes, [
    ["create_note", false],
    ["create_note", true],
  ]);
});

test("two parallel calls in one step still run the tool once", async () => {
  const { createWriteOnceGuard } = await load();
  const guard = createWriteOnceGuard(new Set(["copy_to_clipboard"]));
  let runs = 0;
  const execute = async () => {
    runs += 1;
    return { copied: true };
  };
  await Promise.all([
    guard.run("copy_to_clipboard", execute),
    guard.run("copy_to_clipboard", execute),
  ]);
  assert.equal(runs, 1);
});

// The OpenWhispr Cloud tool-call path executes tools directly
// (registry.get(name).execute(args)) and gets back a ToolResult
// ({ success, data, displayText }), not the AI-SDK { error } shape the guard
// above understands. runToolResultOnce adapts createWriteOnceGuard for that
// shape so cloud voice turns get the same one-run-per-write-tool guarantee.
test("cloud ToolResult writes run once per turn; a repeat call reports it was not run", async () => {
  const { createWriteOnceGuard, runToolResultOnce } = await load();
  const outcomes = [];
  const guard = createWriteOnceGuard(new Set(["create_note"]), (name, ok) =>
    outcomes.push([name, ok])
  );
  let runs = 0;
  const execute = async () => {
    runs += 1;
    return { success: true, data: { id: runs }, displayText: "Created note" };
  };

  const first = await runToolResultOnce(guard, "create_note", execute);
  const second = await runToolResultOnce(guard, "create_note", execute);

  assert.equal(runs, 1);
  assert.deepEqual(first, { success: true, data: { id: 1 }, displayText: "Created note" });
  assert.equal(second.success, true);
  assert.match(String(second.data), /second create_note call .* NOT run/);
  // The UI-facing displayText reuses the real first result, not the model note.
  assert.equal(second.displayText, "Created note");
  assert.deepEqual(outcomes, [["create_note", true]]);
});

test("runToolResultOnce reports a failed ToolResult write as ok: false, preserving the result", async () => {
  const { createWriteOnceGuard, runToolResultOnce } = await load();
  const outcomes = [];
  const guard = createWriteOnceGuard(new Set(["update_dictionary"]), (name, ok) =>
    outcomes.push([name, ok])
  );
  const result = await runToolResultOnce(guard, "update_dictionary", async () => ({
    success: false,
    data: null,
    displayText: "Dictionary is full",
  }));

  assert.deepEqual(result, { success: false, data: null, displayText: "Dictionary is full" });
  assert.deepEqual(outcomes, [["update_dictionary", false]]);
});

// The cloud adapter's repeat call must not turn a failed write into a plain
// success just because "the guard ran the tool successfully once".
test("runToolResultOnce: a repeat after a failed retry reports success: false and reuses the original displayText", async () => {
  const { createWriteOnceGuard, runToolResultOnce } = await load();
  const outcomes = [];
  const guard = createWriteOnceGuard(new Set(["create_note"]), (name, ok) =>
    outcomes.push([name, ok])
  );
  let runs = 0;
  const execute = async () => {
    runs += 1;
    return { success: false, data: null, displayText: "Notes are full" };
  };

  const first = await runToolResultOnce(guard, "create_note", execute);
  await runToolResultOnce(guard, "create_note", execute);
  const third = await runToolResultOnce(guard, "create_note", execute);

  assert.equal(runs, 2);
  assert.deepEqual(first, { success: false, data: null, displayText: "Notes are full" });
  assert.equal(third.success, false);
  assert.match(String(third.data), /already failed/i);
  assert.match(String(third.data), /Notes are full/);
  assert.equal(third.displayText, "Notes are full");
  assert.deepEqual(outcomes, [
    ["create_note", false],
    ["create_note", false],
  ]);
});

test("runToolResultOnce leaves read-only cloud tools unlimited", async () => {
  const { createWriteOnceGuard, runToolResultOnce } = await load();
  const guard = createWriteOnceGuard(new Set(["create_note"]));
  let runs = 0;
  const execute = async () => {
    runs += 1;
    return { success: true, data: [], displayText: "ok" };
  };
  await runToolResultOnce(guard, "search_notes", execute);
  await runToolResultOnce(guard, "search_notes", execute);
  assert.equal(runs, 2);
});
