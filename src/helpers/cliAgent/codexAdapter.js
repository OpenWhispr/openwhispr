const { BaseCliAdapter } = require("./baseCliAdapter");

// codex has no equivalent of Claude Code's supervised "auto" mode, so both
// auto and acceptEdits map to --full-auto.
const PERMISSION_FLAGS = {
  manual: [],
  auto: ["--full-auto"],
  acceptEdits: ["--full-auto"],
  bypass: ["--dangerously-bypass-approvals-and-sandbox"],
};

// Stateful per run (accumulates the last agent message until turn.completed):
// callers must construct a fresh instance for every run.
class CodexAdapter extends BaseCliAdapter {
  constructor() {
    super();
    this._lastAgentMessage = "";
  }

  get id() { return "codex"; }
  get binaryName() { return "codex"; }

  buildArgs(request) {
    const args = ["exec"];
    if (request.resumeSessionId) args.push("resume", request.resumeSessionId);
    args.push("--json");
    if (request.model) args.push("-m", request.model);
    args.push(...(PERMISSION_FLAGS[request.permissionMode] || PERMISSION_FLAGS.auto));
    // codex has no append-system-prompt flag; fold it into the prompt.
    const prompt = request.systemPrompt
      ? `${request.systemPrompt}\n\n${request.prompt}`
      : request.prompt;
    args.push(prompt);
    return args;
  }

  mapEvent(json) {
    if (json.type === "thread.started" && json.thread_id) {
      return { type: "init", sessionId: json.thread_id };
    }
    if (json.type === "item.started") {
      const item = json.item || {};
      if (item.type === "command_execution") return { type: "stage", label: { kind: "command" } };
      if (item.type === "mcp_tool_call") {
        return { type: "stage", label: { kind: "tool", name: `${item.server}: ${item.tool}` } };
      }
      if (item.type === "reasoning") return { type: "stage", label: { kind: "thinking" } };
      return null;
    }
    if (json.type === "item.completed" && json.item?.type === "agent_message") {
      this._lastAgentMessage = json.item.text || "";
      return null;
    }
    if (json.type === "turn.completed") {
      return { type: "result", text: this._lastAgentMessage, isError: false, permissionDenials: [] };
    }
    if (json.type === "turn.failed") {
      return {
        type: "result",
        text: json.error?.message || "Codex turn failed",
        isError: true,
        permissionDenials: [],
      };
    }
    return null;
  }

  isUnknownSessionError(stderrText) {
    // Verified against codex-cli 0.146.0: `codex exec resume <unknown-id>` fails with
    // "...thread/resume failed: no rollout found for thread id <uuid> (code -32600)".
    return /no rollout found/i.test(stderrText);
  }
}

module.exports = { CodexAdapter };
