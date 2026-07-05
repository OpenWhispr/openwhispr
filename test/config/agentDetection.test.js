const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/config/agentDetection.ts");

test("detects wake-word invocations", async () => {
  const { detectAgentName } = await load();

  assert.equal(
    detectAgentName("Hey Whispr, what is the keyboard shortcut?", "Whispr"),
    true
  );
  assert.equal(
    detectAgentName("Here is my draft. Hey Whispr, shorten it.", "Whispr"),
    true
  );
});

test("detects name-first commands at the start of a segment", async () => {
  const { detectAgentName } = await load();

  assert.equal(detectAgentName("Whispr rewrite this paragraph", "Whispr"), true);
  assert.equal(detectAgentName("Whispr, make this more professional", "Whispr"), true);
});

test("does not route cleanup when the agent name is only mentioned", async () => {
  const { detectAgentName } = await load();

  assert.equal(
    detectAgentName("What is the keyboard shortcut key to perform an action?", "Whispr"),
    false
  );
  assert.equal(detectAgentName("I met Sarah yesterday at the office", "Sarah"), false);
  assert.equal(detectAgentName("Tell Sarah I said hi", "Sarah"), false);
  assert.equal(detectAgentName("I need to whisper this quietly", "Whispr"), false);
});

test("does not fuzzy-match unrelated words without a wake word", async () => {
  const { detectAgentName } = await load();

  assert.equal(detectAgentName("The area was flooded yesterday", "Aria"), false);
});
