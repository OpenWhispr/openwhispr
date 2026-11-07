const test = require("node:test");
const assert = require("node:assert/strict");

const { ToolRegistry } = require("../../../src/services/tools/ToolRegistry");
const { adaptToolsForVoice } = require("../../../src/services/voice/voiceToolPolicy");

function registryWith(...tools) {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  adaptToolsForVoice(registry);
  return registry;
}

function countingTool(name, results) {
  const calls = [];
  return {
    calls,
    tool: {
      name,
      description: "",
      parameters: {},
      readOnly: false,
      execute: async (args) => {
        calls.push(args);
        return results[Math.min(calls.length, results.length) - 1];
      },
    },
  };
}

const created = { success: true, data: { id: 7 }, displayText: "Created note" };
const failed = { success: false, data: null, displayText: "Notes database is locked" };

test("an identical local write runs once in a spoken turn, and the repeat says so", async () => {
  const { calls, tool } = countingTool("create_note", [created]);
  const note = registryWith(tool).get("create_note");

  const first = await note.execute({ title: "Groceries", content: "Milk" });
  const repeat = await note.execute({ content: "Milk", title: "Groceries" });

  assert.equal(calls.length, 1, "argument order doesn't make it a new write");
  assert.deepEqual(first, created);
  assert.equal(repeat.success, true);
  assert.equal(repeat.displayText, "Created note");
  assert.equal(repeat.data.notRunAgain, true);
  assert.match(repeat.data.note, /was not run again/);
});

test("different writes in one turn all run, including ones running at once", async () => {
  const { calls, tool } = countingTool("create_note", [created]);
  const note = registryWith(tool).get("create_note");

  await Promise.all([
    note.execute({ title: "One" }),
    note.execute({ title: "Two" }),
    note.execute({ title: "One" }),
  ]);
  assert.deepEqual(
    calls.map(({ title }) => title),
    ["One", "Two"]
  );
});

test("a failed write may run once more, then its failure is returned", async () => {
  const { calls, tool } = countingTool("update_note", [failed, failed, created]);
  const update = registryWith(tool).get("update_note");

  assert.equal((await update.execute({ id: 1 })).success, false);
  assert.equal((await update.execute({ id: 1 })).success, false);
  assert.deepEqual(await update.execute({ id: 1 }), failed);
  assert.equal(calls.length, 2);
});

test("sends, reads and other tools are left as they are", () => {
  const send = countingTool("email_draft", [created]).tool;
  const read = { ...countingTool("search_notes", [created]).tool, readOnly: true };
  const registry = registryWith(send, read);
  assert.equal(registry.get("email_draft"), send);
  assert.equal(registry.get("search_notes"), read);
});

test("web results are cut to three short ones without links", async () => {
  const results = Array.from({ length: 5 }, (_, index) => ({
    title: `Result ${index}`,
    url: `https://example.com/${index}`,
    text: "x".repeat(500),
    publishedDate: null,
  }));
  const web = registryWith({
    name: "web_search",
    description: "",
    parameters: {},
    readOnly: true,
    execute: async () => ({ success: true, data: results, displayText: "Found" }),
  }).get("web_search");

  const { data, displayText } = await web.execute({ query: "weather" });
  assert.equal(displayText, "Found");
  assert.equal(data.length, 3);
  assert.deepEqual(Object.keys(data[0]), ["title", "text", "publishedDate"]);
  assert.equal(data[0].text.length, 240);
});
