const test = require("node:test");
const assert = require("node:assert/strict");

const promptsModule = import("../../src/config/prompts.ts");
const registryModule = import("../../src/config/prompts/registry.ts");

test("the plain-text suffix is appended once, at the very end", async () => {
  const { appendPlainTextResponseSuffix } = await promptsModule;
  const { PLAIN_TEXT_RESPONSE_SUFFIX } = await registryModule;

  const result = appendPlainTextResponseSuffix("BASE PROMPT");

  assert.ok(result.startsWith("BASE PROMPT"));
  assert.ok(result.endsWith(PLAIN_TEXT_RESPONSE_SUFFIX));
  assert.equal(result.split("OUTPUT FORMAT:").length, 2);
});

test("the suffix names every markdown construct the strip helper removes", async () => {
  const { PLAIN_TEXT_RESPONSE_SUFFIX } = await registryModule;
  for (const construct of ["asterisks", "backticks", "heading", "list", "tables", "link"]) {
    assert.match(PLAIN_TEXT_RESPONSE_SUFFIX, new RegExp(construct));
  }
});

// The panel renders markdown, so a panel-bound answer must never be asked
// for plain prose. Guards against someone "simplifying" the suffix into the
// default prompt later — that would also trip the prompt-hash protocol.
test("a panel-bound agent prompt carries no plain-text instruction", async () => {
  const { getAgentSystemPrompt } = await promptsModule;
  assert.ok(!getAgentSystemPrompt().includes("OUTPUT FORMAT:"));
  assert.ok(!getAgentSystemPrompt(["web_search"], "some note").includes("OUTPUT FORMAT:"));
});
