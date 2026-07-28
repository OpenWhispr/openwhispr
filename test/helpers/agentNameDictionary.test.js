const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/agentNameDictionary.js");

// The `changed` flag is what stops a startup write from replacing the whole
// SQLite dictionary with a stale renderer cache (#1295). Guard it directly.
test("reports no change when the agent name is already present", async () => {
  const { applyAgentNameToDictionary } = await load();
  const existing = ["OpenWhispr", "Alice", "Bob"];
  const result = applyAgentNameToDictionary(existing, "OpenWhispr");
  assert.equal(result.changed, false);
  assert.deepEqual(result.dictionary, existing);
});

test("reports no change for a stale one-word cache that already has the name", async () => {
  const { applyAgentNameToDictionary } = await load();
  assert.equal(applyAgentNameToDictionary(["OpenWhispr"], "OpenWhispr").changed, false);
});

test("adds the agent name at the front when missing", async () => {
  const { applyAgentNameToDictionary } = await load();
  const result = applyAgentNameToDictionary(["Alice"], "OpenWhispr");
  assert.equal(result.changed, true);
  assert.deepEqual(result.dictionary, ["OpenWhispr", "Alice"]);
});

test("drops the previous agent name on rename", async () => {
  const { applyAgentNameToDictionary } = await load();
  const result = applyAgentNameToDictionary(["OpenWhispr", "Alice"], "Jarvis", "OpenWhispr");
  assert.equal(result.changed, true);
  assert.deepEqual(result.dictionary, ["Jarvis", "Alice"]);
});

test("reports no change when the old name was never in the dictionary", async () => {
  const { applyAgentNameToDictionary } = await load();
  const result = applyAgentNameToDictionary(["Jarvis", "Alice"], "Jarvis", "OpenWhispr");
  assert.equal(result.changed, false);
  assert.deepEqual(result.dictionary, ["Jarvis", "Alice"]);
});

test("ignores a blank agent name", async () => {
  const { applyAgentNameToDictionary } = await load();
  const result = applyAgentNameToDictionary(["Alice"], "   ");
  assert.equal(result.changed, false);
  assert.deepEqual(result.dictionary, ["Alice"]);
});

test("does not mutate the caller's array", async () => {
  const { applyAgentNameToDictionary } = await load();
  const original = ["Alice"];
  applyAgentNameToDictionary(original, "OpenWhispr");
  assert.deepEqual(original, ["Alice"]);
});
