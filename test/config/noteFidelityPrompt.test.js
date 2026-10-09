const test = require("node:test");
const assert = require("node:assert/strict");

test("source fidelity instructions reach chat and every note-generation entry point", async () => {
  const { getAgentSystemPrompt } = await import("../../src/config/prompts.ts");
  const { SOURCE_FIDELITY_RULE } = await import("../../src/helpers/sourceFidelity.js");
  const { compileTemplatePrompt, compileSummaryActionPrompt, compileChatActionPrompt } =
    await import("../../src/helpers/templatePrompts.js");
  const prompts = [getAgentSystemPrompt([]), getAgentSystemPrompt(["get_note", "update_note"])];
  for (const isMeetingNote of [true, false]) {
    prompts.push(compileTemplatePrompt({ prompt: "Custom instructions" }, { isMeetingNote }));
    prompts.push(
      compileTemplatePrompt(
        { sections: [{ heading: "Decisions", instruction: "List decisions" }] },
        { isMeetingNote }
      )
    );
    for (const fromSummary of [true, false]) {
      prompts.push(
        compileSummaryActionPrompt({ prompt: "Shorten this" }, { fromSummary, isMeetingNote })
      );
      prompts.push(compileChatActionPrompt({ prompt: "Draft a follow-up" }, { fromSummary }));
    }
  }
  for (const prompt of prompts) assert.ok(prompt.includes(SOURCE_FIDELITY_RULE));
  assert.match(SOURCE_FIDELITY_RULE, /uncertainty, negation, and status/);
  assert.match(SOURCE_FIDELITY_RULE, /task with its stated owner and deadline/);
  assert.match(SOURCE_FIDELITY_RULE, /before\/after timing/);
});

test("note edits require distinct fields and successful save before reporting success", async () => {
  const { getAgentSystemPrompt } = await import("../../src/config/prompts.ts");
  const prompt = getAgentSystemPrompt([
    "get_note",
    "update_note",
    { name: "email_draft", connectorId: "email" },
  ]);
  assert.match(prompt, /Read get_note before editing/);
  assert.match(prompt, /content for personal notes, summary for the AI Summary/);
  assert.match(prompt, /preserve all unrelated text exactly/);
  assert.match(prompt, /Never copy the combined context, field labels, or transcript/);
  assert.match(prompt, /Only claim the edit was saved after update_note succeeds/);
  assert.match(prompt, /previous email interaction does not authorize another email action/);
  assert.match(prompt, /ask which document before acting/);
});
