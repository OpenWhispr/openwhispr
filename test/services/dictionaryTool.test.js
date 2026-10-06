const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/tools/dictionaryTool.ts");

function harness(words) {
  const calls = [];
  return {
    calls,
    actions: {
      getDictionary: () => words,
      updateDictionary: (changes) => calls.push(changes),
    },
  };
}

test("adds new words and removes existing ones case-insensitively in one call", async () => {
  const { createUpdateDictionaryTool } = await load();
  const { actions, calls } = harness(["OpenWhispr", "Parakeat"]);
  const tool = createUpdateDictionaryTool(actions);

  const result = await tool.execute({ add: [" Parakeet ", "Orukeet"], remove: ["parakeat"] });

  assert.deepEqual(calls, [{ add: ["Parakeet", "Orukeet"], remove: ["parakeat"] }]);
  assert.deepEqual(result, {
    success: true,
    data: {
      added: ["Parakeet", "Orukeet"],
      removed: ["parakeat"],
      alreadyPresent: [],
      notFound: [],
    },
    displayText: 'Added "Parakeet", "Orukeet"; Removed "parakeat"',
  });
});

test("words already present are reported instead of re-added", async () => {
  const { createUpdateDictionaryTool } = await load();
  const { actions, calls } = harness(["OpenWhispr"]);
  const tool = createUpdateDictionaryTool(actions);

  const result = await tool.execute({ add: ["openwhispr"] });

  assert.equal(calls.length, 0);
  assert.equal(result.success, false);
  assert.equal(result.displayText, 'Already in the dictionary: "openwhispr"');
});

test("removing a word that is not there fails without writing", async () => {
  const { createUpdateDictionaryTool } = await load();
  const { actions, calls } = harness(["OpenWhispr"]);
  const tool = createUpdateDictionaryTool(actions);

  const result = await tool.execute({ remove: ["Whisper"] });

  assert.equal(calls.length, 0);
  assert.deepEqual(result, {
    success: false,
    data: null,
    displayText: 'Not in the dictionary: "Whisper"',
  });
});

test("the tool is a write tool", async () => {
  const { createUpdateDictionaryTool } = await load();
  const tool = createUpdateDictionaryTool(harness([]).actions);
  assert.equal(tool.name, "update_dictionary");
  assert.equal(tool.readOnly, false);
});
