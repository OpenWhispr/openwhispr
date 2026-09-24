const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../../src/services/voice/voiceToolPolicy.ts");

test("voice turns never offer snippet editing", async () => {
  const { VOICE_EXCLUDED_TOOLS } = await load();
  assert.deepEqual([...VOICE_EXCLUDED_TOOLS], ["update_snippets"]);
});

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
  assert.match(second.note, /already/i);
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

// R8: a repeat call after a FAILED first write must not read as a plain
// success (the model would go on to tell the user the write worked).
test("a repeat call after a failed first run reports the failure, not a plain success", async () => {
  const { createWriteOnceGuard } = await load();
  const guard = createWriteOnceGuard(new Set(["create_note"]));
  const execute = async () => ({ error: "Notes are full" });

  const first = await guard.run("create_note", execute);
  const second = await guard.run("create_note", execute);

  assert.deepEqual(first, { error: "Notes are full" });
  assert.equal(second.alreadyDone, true);
  assert.deepEqual(second.result, { error: "Notes are full" });
  assert.match(second.note, /already failed/i);
  assert.match(second.note, /Notes are full/);
});

test("two parallel calls in one step still run the tool once", async () => {
  const { createWriteOnceGuard } = await load();
  const guard = createWriteOnceGuard(new Set(["copy_to_clipboard"]));
  let runs = 0;
  const execute = async () => {
    runs += 1;
    return { copied: true };
  };
  await Promise.all([guard.run("copy_to_clipboard", execute), guard.run("copy_to_clipboard", execute)]);
  assert.equal(runs, 1);
});

// R5: the OpenWhispr Cloud tool-call path executes tools directly
// (registry.get(name).execute(args)) and gets back a ToolResult
// ({ success, data, displayText }), not the AI-SDK { error } shape the guard
// above understands. runToolResultOnce adapts createWriteOnceGuard for that
// shape so cloud voice turns get the same one-run-per-write-tool guarantee.
test("cloud ToolResult writes run once per turn; a repeat call reports the already-ran note", async () => {
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
  assert.match(String(second.data), /already/i);
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

// R8: the cloud adapter's repeat call must not turn a failed write into a
// plain success just because "the guard ran the tool successfully once".
test("runToolResultOnce: a repeat call after a failed first write reports success: false and reuses the original displayText", async () => {
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
  const second = await runToolResultOnce(guard, "create_note", execute);

  assert.equal(runs, 1);
  assert.deepEqual(first, { success: false, data: null, displayText: "Notes are full" });
  assert.equal(second.success, false);
  assert.match(String(second.data), /already failed/i);
  assert.match(String(second.data), /Notes are full/);
  assert.equal(second.displayText, "Notes are full");
  assert.deepEqual(outcomes, [["create_note", false]]);
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
