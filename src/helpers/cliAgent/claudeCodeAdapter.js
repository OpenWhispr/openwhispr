const { BaseCliAdapter } = require("./baseCliAdapter");

const PERMISSION_MODE_MAP = {
  manual: "default",
  auto: "auto",
  acceptEdits: "acceptEdits",
  bypass: "bypassPermissions",
};

class ClaudeCodeAdapter extends BaseCliAdapter {
  get id() { return "claude-code"; }
  get binaryName() { return "claude"; }

  buildArgs(request) {
    const args = ["-p", request.prompt, "--output-format", "stream-json", "--verbose"];
    if (request.model) args.push("--model", request.model);
    args.push("--permission-mode", PERMISSION_MODE_MAP[request.permissionMode] || "acceptEdits");
    if (request.systemPrompt) args.push("--append-system-prompt", request.systemPrompt);
    if (request.resumeSessionId) args.push("--resume", request.resumeSessionId);
    return args;
  }

  _stageForToolUse(block) {
    if (block.name === "Bash") return { type: "stage", label: { kind: "command" } };
    if (block.name === "Skill") {
      return { type: "stage", label: { kind: "skill", name: block.input?.command || "skill" } };
    }
    const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(block.name);
    if (mcp) return { type: "stage", label: { kind: "tool", name: `${mcp[1]}: ${mcp[2]}` } };
    return { type: "stage", label: { kind: "tool", name: block.name } };
  }

  mapEvent(json) {
    if (json.type === "system" && json.subtype === "init" && json.session_id) {
      return { type: "init", sessionId: json.session_id };
    }
    if (json.type === "assistant") {
      const blocks = json.message?.content || [];
      const stages = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => this._stageForToolUse(b));
      return stages.length ? stages : null;
    }
    if (json.type === "result") {
      const events = [];
      if (json.session_id) events.push({ type: "init", sessionId: json.session_id });
      events.push({
        type: "result",
        text: json.result ?? "",
        isError: !!json.is_error,
        permissionDenials: (json.permission_denials || []).map((d) => d.tool_name || String(d)),
      });
      return events;
    }
    return null;
  }

  isUnknownSessionError(stderrText) {
    return /no conversation found/i.test(stderrText);
  }
}

module.exports = { ClaudeCodeAdapter };
