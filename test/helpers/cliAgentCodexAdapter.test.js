const test = require("node:test");
const assert = require("node:assert/strict");

const { CodexAdapter } = require("../../src/helpers/cliAgent/codexAdapter");

const adapter = new CodexAdapter();
const req = (o = {}) => ({
  prompt: "open a ticket",
  systemPrompt: "SYS",
  model: "",
  permissionMode: "auto",
  resumeSessionId: null,
  ...o,
});

test("buildArgs: defaults — system prompt is prepended to the prompt", () => {
  assert.deepEqual(adapter.buildArgs(req()), [
    "exec", "--json", "--full-auto", "SYS\n\nopen a ticket",
  ]);
});

test("buildArgs: model, bypass, manual", () => {
  assert.deepEqual(adapter.buildArgs(req({ model: "gpt-5.2", permissionMode: "bypass", systemPrompt: "" })), [
    "exec", "--json", "-m", "gpt-5.2", "--dangerously-bypass-approvals-and-sandbox", "open a ticket",
  ]);
  assert.deepEqual(adapter.buildArgs(req({ permissionMode: "manual", systemPrompt: "" })), [
    "exec", "--json", "open a ticket",
  ]);
});

test("buildArgs: resume inserts subcommand before flags", () => {
  assert.deepEqual(adapter.buildArgs(req({ resumeSessionId: "t1", systemPrompt: "" })), [
    "exec", "resume", "t1", "--json", "--full-auto", "open a ticket",
  ]);
});

test("mapEvent: thread.started → init", () => {
  assert.deepEqual(adapter.mapEvent({ type: "thread.started", thread_id: "t1" }), {
    type: "init",
    sessionId: "t1",
  });
});

test("mapEvent: item.started stages", () => {
  assert.deepEqual(
    adapter.mapEvent({ type: "item.started", item: { type: "command_execution", command: "ls" } }),
    { type: "stage", label: { kind: "command" } }
  );
  assert.deepEqual(
    adapter.mapEvent({ type: "item.started", item: { type: "mcp_tool_call", server: "jira", tool: "create_issue" } }),
    { type: "stage", label: { kind: "tool", name: "jira: create_issue" } }
  );
  assert.deepEqual(
    adapter.mapEvent({ type: "item.started", item: { type: "reasoning" } }),
    { type: "stage", label: { kind: "thinking" } }
  );
});

test("mapEvent: final agent message + turn.completed → result", () => {
  assert.equal(adapter.mapEvent({ type: "item.completed", item: { type: "agent_message", text: "Done." } }), null);
  assert.deepEqual(adapter.mapEvent({ type: "turn.completed" }), {
    type: "result", text: "Done.", isError: false, permissionDenials: [],
  });
});

test("mapEvent: turn.failed → error result", () => {
  const a = new CodexAdapter();
  assert.deepEqual(a.mapEvent({ type: "turn.failed", error: { message: "boom" } }), {
    type: "result", text: "boom", isError: true, permissionDenials: [],
  });
});

// Real codex-cli 0.146.0 emits "no rollout found for thread id <uuid> (code -32600)"
// on `codex exec resume` with an unknown id — verified with a live run.
test("isUnknownSessionError", () => {
  assert.equal(
    adapter.isUnknownSessionError(
      "Error: thread/resume: thread/resume failed: no rollout found for thread id 00000000-0000-0000-0000-000000000000 (code -32600)"
    ),
    true
  );
  assert.equal(adapter.isUnknownSessionError("network error"), false);
});
