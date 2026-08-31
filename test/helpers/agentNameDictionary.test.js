const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/agentNameDictionary.js");

// An empty delta means no write at all, which is what stops startup from
// touching the dictionary when the renderer cache is stale (#1295).
test("asks for no changes when the agent name is already present", async () => {
  const { agentNameDictionaryChanges } = await load();
  const result = agentNameDictionaryChanges(["OpenWhispr", "Alice", "Bob"], "OpenWhispr");
  assert.deepEqual(result, { add: [], remove: [] });
});

test("asks for no changes for a stale one-word cache that already has the name", async () => {
  const { agentNameDictionaryChanges } = await load();
  assert.deepEqual(agentNameDictionaryChanges(["OpenWhispr"], "OpenWhispr"), {
    add: [],
    remove: [],
  });
});

test("adds the agent name when missing, without naming other words", async () => {
  const { agentNameDictionaryChanges } = await load();
  assert.deepEqual(agentNameDictionaryChanges(["Alice"], "OpenWhispr"), {
    add: ["OpenWhispr"],
    remove: [],
  });
});

test("swaps the previous agent name for the new one on rename", async () => {
  const { agentNameDictionaryChanges } = await load();
  assert.deepEqual(agentNameDictionaryChanges(["OpenWhispr", "Alice"], "Jarvis", "OpenWhispr"), {
    add: ["Jarvis"],
    remove: ["OpenWhispr"],
  });
});

test("does not ask to remove an old name the dictionary never had", async () => {
  const { agentNameDictionaryChanges } = await load();
  assert.deepEqual(agentNameDictionaryChanges(["Jarvis", "Alice"], "Jarvis", "OpenWhispr"), {
    add: [],
    remove: [],
  });
});

test("ignores a blank agent name", async () => {
  const { agentNameDictionaryChanges } = await load();
  assert.deepEqual(agentNameDictionaryChanges(["Alice"], "   "), { add: [], remove: [] });
});

test("never names a word outside the agent name itself", async () => {
  const { agentNameDictionaryChanges } = await load();
  const dictionary = ["OpenWhispr", "Alice", "Bob", "Imported Term"];
  const { add, remove } = agentNameDictionaryChanges(dictionary, "Jarvis", "OpenWhispr");
  assert.deepEqual([...add, ...remove].sort(), ["Jarvis", "OpenWhispr"]);
});

test("does not add a case-variant of an agent name already in the dictionary", async () => {
  const { agentNameDictionaryChanges } = await load();
  assert.deepEqual(agentNameDictionaryChanges(["openwhispr", "Alice"], "OpenWhispr"), {
    add: [],
    remove: [],
  });
});

test("removes the stored spelling when renaming away from a case-variant", async () => {
  const { agentNameDictionaryChanges } = await load();
  assert.deepEqual(agentNameDictionaryChanges(["openwhispr", "Alice"], "Jarvis", "OpenWhispr"), {
    add: ["Jarvis"],
    remove: ["openwhispr"],
  });
});

test("does not recase an existing agent name when only capitalization changes", async () => {
  const { agentNameDictionaryChanges } = await load();
  assert.deepEqual(agentNameDictionaryChanges(["OpenWhispr"], "openwhispr", "OpenWhispr"), {
    add: [],
    remove: [],
  });
});

test("does not remove a padded stored agent name when the name is unchanged", async () => {
  const { agentNameDictionaryChanges } = await load();
  assert.deepEqual(agentNameDictionaryChanges([" OpenWhispr "], "OpenWhispr", "OpenWhispr"), {
    add: [],
    remove: [],
  });
});

test("removes the padded stored spelling when renaming away", async () => {
  const { agentNameDictionaryChanges } = await load();
  assert.deepEqual(agentNameDictionaryChanges([" OpenWhispr ", "Alice"], "Jarvis", "OpenWhispr"), {
    add: ["Jarvis"],
    remove: [" OpenWhispr "],
  });
});

test("does not remove agent name when only surrounding whitespace changes", async () => {
  const { agentNameDictionaryChanges } = await load();
  assert.deepEqual(agentNameDictionaryChanges(["OpenWhispr"], "  OpenWhispr  ", "OpenWhispr"), {
    add: [],
    remove: [],
  });
});

test("removes previous agent name when oldName contains surrounding whitespace", async () => {
  const { agentNameDictionaryChanges } = await load();
  assert.deepEqual(
    agentNameDictionaryChanges(["OpenWhispr", "Alice"], "Jarvis", "  OpenWhispr  "),
    {
      add: ["Jarvis"],
      remove: ["OpenWhispr"],
    }
  );
});

test("accepts a Set dictionary and asks for no changes when the name is present", async () => {
  const { agentNameDictionaryChanges } = await load();
  assert.deepEqual(agentNameDictionaryChanges(new Set(["OpenWhispr", "Alice"]), "OpenWhispr"), {
    add: [],
    remove: [],
  });
});

test("swaps the previous agent name when the dictionary is a Set", async () => {
  const { agentNameDictionaryChanges } = await load();
  assert.deepEqual(
    agentNameDictionaryChanges(new Set(["OpenWhispr", "Alice"]), "Jarvis", "OpenWhispr"),
    {
      add: ["Jarvis"],
      remove: ["OpenWhispr"],
    }
  );
});

test("accepts any iterable dictionary, not just arrays", async () => {
  const { agentNameDictionaryChanges } = await load();
  const dictionary = new Map([
    ["OpenWhispr", 1],
    ["Alice", 2],
  ]).keys();
  assert.deepEqual(agentNameDictionaryChanges(dictionary, "OpenWhispr", "Alice"), {
    add: [],
    remove: ["Alice"],
  });
});

test("degrades a non-iterable dictionary to an empty one without throwing", async () => {
  const { agentNameDictionaryChanges } = await load();
  assert.deepEqual(agentNameDictionaryChanges({ 0: "OpenWhispr" }, "Jarvis"), {
    add: ["Jarvis"],
    remove: [],
  });
});

test("does not throw when the dictionary contains non-string elements", async () => {
  const { agentNameDictionaryChanges } = await load();
  assert.deepEqual(agentNameDictionaryChanges(new Set(["OpenWhispr", 42, null]), "OpenWhispr"), {
    add: [],
    remove: [],
  });
});

test("findStoredWord returns undefined for a non-string word", async () => {
  const { findStoredWord } = await load();
  assert.equal(findStoredWord(["OpenWhispr"], 42), undefined);
  assert.equal(findStoredWord(["OpenWhispr"], null), undefined);
  assert.equal(findStoredWord(["OpenWhispr"], undefined), undefined);
});

test("findStoredWord matches a stored string word", async () => {
  const { findStoredWord } = await load();
  assert.equal(findStoredWord(["OpenWhispr", "Alice"], "openwhispr"), "OpenWhispr");
});
