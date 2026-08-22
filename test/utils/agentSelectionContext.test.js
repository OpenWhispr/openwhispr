const test = require("node:test");
const assert = require("node:assert/strict");

let contextModule;

test.before(async () => {
  contextModule = await import("../../src/utils/agentSelectionContext.ts");
});

test("a request without selected Agent text is unchanged", () => {
  assert.equal(contextModule.buildAgentRequestText("make it shorter", null), "make it shorter");
});

test("selected Agent text is added only to the model request", () => {
  const request = contextModule.buildAgentRequestText("make it shorter", {
    text: "  This is the selected paragraph.  ",
    sourceMessageId: "assistant-1",
  });

  assert.match(request, /^make it shorter\n\n/);
  assert.match(request, /"source":"previous_assistant_response"/);
  assert.match(request, /"selectedText":"This is the selected paragraph\."/);
  assert.match(request, /primary referent/);
});

test("selected context is normalized and bounded", () => {
  const text = `  ${"x".repeat(contextModule.MAX_AGENT_SELECTION_CONTEXT_CHARACTERS + 20)}  `;
  const context = contextModule.normalizeAgentSelectionContext({
    text,
    sourceMessageId: "assistant-2",
  });

  assert.equal(context.text.length, contextModule.MAX_AGENT_SELECTION_CONTEXT_CHARACTERS);
  assert.equal(context.sourceMessageId, "assistant-2");
  assert.equal(contextModule.normalizeAgentSelectionContext({ text: "   " }), null);
});
