const test = require("node:test");
const assert = require("node:assert/strict");

let contextModule;

test.before(async () => {
  const path = require("node:path");
  const { pathToFileURL } = require("node:url");
  const root = process.env.OPENWHISPR_TEST_SOURCE || path.resolve(__dirname, "../..");
  contextModule = await import(
    pathToFileURL(path.join(root, "src/utils/agentSelectionContext.ts"))
  );
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

test("text selected in another app is quoted as such, and keeps its source when normalized", () => {
  const context = contextModule.normalizeAgentSelectionContext({
    text: "Q4 revenue table",
    source: "external",
  });
  assert.deepEqual(context, { text: "Q4 revenue table", sourceMessageId: "", source: "external" });

  const request = contextModule.buildAgentRequestText("summarize this", context);
  assert.match(request, /"source":"selected_in_another_app"/);
  assert.doesNotMatch(request, /previous_assistant_response/);
});

test("copied parent context is consumed only by the fork's own matching user message", () => {
  const text = "Ship the quarterly report on Friday.";
  const origin = { context: text, copiedMessageCount: 2 };
  const copied = [{ role: "user", selectedContext: text }, { role: "assistant" }];
  assert.equal(contextModule.unsentForkContext(origin, copied), text);
  const own = [...copied, { role: "user", selectedContext: "another paragraph" }];
  assert.equal(contextModule.unsentForkContext(origin, own), text);
  own.push({ role: "user", selectedContext: text });
  assert.equal(contextModule.unsentForkContext(origin, own), null);
  assert.equal(contextModule.unsentForkContext(origin, [...own, { role: "assistant" }]), null);
  assert.equal(contextModule.unsentForkContext(null, copied), null);
});
