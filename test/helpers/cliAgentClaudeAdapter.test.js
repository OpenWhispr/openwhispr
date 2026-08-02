const test = require("node:test");
const assert = require("node:assert/strict");

const { ClaudeCodeAdapter } = require("../../src/helpers/cliAgent/claudeCodeAdapter");

const adapter = new ClaudeCodeAdapter();
const req = (o = {}) => ({
  prompt: "open a ticket",
  systemPrompt: "SYS",
  model: "",
  permissionMode: "auto",
  resumeSessionId: null,
  ...o,
});

test("buildArgs: defaults", () => {
  assert.deepEqual(adapter.buildArgs(req()), [
    "-p", "open a ticket",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "auto",
    "--append-system-prompt", "SYS",
  ]);
});

test("buildArgs: acceptEdits permission mode", () => {
  const args = adapter.buildArgs(req({ permissionMode: "acceptEdits" }));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
});

test("buildArgs: model, resume, permission mapping", () => {
  const args = adapter.buildArgs(
    req({ model: "opus", permissionMode: "bypass", resumeSessionId: "s9" })
  );
  assert.ok(args.includes("--model") && args[args.indexOf("--model") + 1] === "opus");
  assert.ok(args.includes("--resume") && args[args.indexOf("--resume") + 1] === "s9");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.equal(
    adapter.buildArgs(req({ permissionMode: "manual" }))[
      adapter.buildArgs(req({ permissionMode: "manual" })).indexOf("--permission-mode") + 1
    ],
    "default"
  );
});

test("buildArgs: no system prompt flag when empty", () => {
  assert.ok(!adapter.buildArgs(req({ systemPrompt: "" })).includes("--append-system-prompt"));
});

test("mapEvent: system init", () => {
  assert.deepEqual(
    adapter.mapEvent({ type: "system", subtype: "init", session_id: "abc" }),
    { type: "init", sessionId: "abc" }
  );
});

test("mapEvent: assistant tool_use blocks become stages", () => {
  const evt = {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "thinking" },
        { type: "tool_use", name: "Bash", input: {} },
        { type: "tool_use", name: "mcp__jira__create_issue", input: {} },
        { type: "tool_use", name: "Skill", input: { command: "commit-message" } },
        { type: "tool_use", name: "Read", input: {} },
      ],
    },
  };
  assert.deepEqual(adapter.mapEvent(evt), [
    { type: "stage", label: { kind: "command" } },
    { type: "stage", label: { kind: "tool", name: "jira: create_issue" } },
    { type: "stage", label: { kind: "skill", name: "commit-message" } },
    { type: "stage", label: { kind: "tool", name: "Read" } },
  ]);
});

test("mapEvent: result", () => {
  assert.deepEqual(
    adapter.mapEvent({
      type: "result",
      result: "Done.",
      is_error: false,
      session_id: "abc",
      permission_denials: [{ tool_name: "Bash" }],
    }),
    [
      { type: "init", sessionId: "abc" },
      { type: "result", text: "Done.", isError: false, permissionDenials: ["Bash"] },
    ]
  );
});

test("mapEvent: irrelevant events map to null", () => {
  assert.equal(adapter.mapEvent({ type: "user" }), null);
});

test("isUnknownSessionError", () => {
  assert.equal(adapter.isUnknownSessionError("No conversation found with session ID s9"), true);
  assert.equal(adapter.isUnknownSessionError("rate limited"), false);
});
