const os = require("os");
const { execFile } = require("child_process");
const { CliAgentSessionStore } = require("./sessionStore");
const { CliAgentError } = require("./baseCliAdapter");
const { ClaudeCodeAdapter } = require("./claudeCodeAdapter");
const { CodexAdapter } = require("./codexAdapter");
const debugLogger = require("../debugLogger");

const CLI_CHANNEL_PROMPT = [
  "The user's message was dictated by voice and transcribed automatically, so read",
  "through transcription errors for the intended meaning. Your final answer will be",
  "pasted directly into whatever window the user is working in: reply with short,",
  "plain prose only - no markdown, no headings, no code fences unless the user",
  "explicitly asked for code. Use your available tools to actually perform the task",
  "rather than describing how to do it.",
].join(" ");

const DEFAULT_ADAPTER_FACTORIES = {
  "claude-code": () => new ClaudeCodeAdapter(),
  codex: () => new CodexAdapter(),
};

// GUI-launched Electron on macOS/Linux lacks the user's shell PATH; resolve
// through a login shell. Cached per binary name.
function defaultResolveBinary(binaryName) {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile("where", [binaryName], (err, stdout) =>
        resolve(err ? null : stdout.split(/\r?\n/)[0].trim() || null)
      );
      return;
    }
    const shell = process.env.SHELL || "/bin/sh";
    execFile(shell, ["-lc", `command -v ${binaryName}`], (err, stdout) =>
      resolve(err ? null : stdout.trim() || null)
    );
  });
}

class CliAgentManager {
  constructor({ sessionFilePath, sendStage, adapterFactories, resolveBinary }) {
    this.sessionStore = new CliAgentSessionStore(sessionFilePath);
    this.sendStage = sendStage || (() => {});
    this.adapterFactories = adapterFactories || DEFAULT_ADAPTER_FACTORIES;
    this.resolveBinary = resolveBinary || defaultResolveBinary;
    this._binaryCache = new Map();
    this._current = null;
  }

  async _binaryFor(cli) {
    if (this._binaryCache.has(cli)) return this._binaryCache.get(cli);
    const factory = this.adapterFactories[cli];
    if (!factory) return null;
    const found = await this.resolveBinary(this._adapterBinaryName(cli));
    if (found) this._binaryCache.set(cli, found);
    return found;
  }

  _adapterBinaryName(cli) {
    return cli === "codex" ? "codex" : "claude";
  }

  async check(cli) {
    const p = await this._binaryFor(cli);
    return { available: !!p, path: p };
  }

  cancel() {
    this._current?.controller.abort();
    this._current = null;
  }

  async run(opts) {
    this.cancel();
    const controller = new AbortController();
    this._current = { controller };

    const commandPath = await this._binaryFor(opts.cli);
    if (!commandPath) {
      throw new CliAgentError(
        `${this._adapterBinaryName(opts.cli)} was not found on PATH`,
        "cli_not_found"
      );
    }

    const systemPrompt = [opts.systemPrompt, CLI_CHANNEL_PROMPT, opts.extraPrompt]
      .filter((s) => s && s.trim())
      .join("\n\n");
    const baseRequest = {
      commandPath,
      prompt: opts.prompt,
      systemPrompt,
      model: opts.model || "",
      permissionMode: opts.permissionMode || "auto",
      cwd: opts.workingDir?.trim() || os.homedir(),
      timeoutMs: (opts.timeoutSeconds > 0 ? opts.timeoutSeconds : 240) * 1000,
      resumeSessionId: this.sessionStore.get(opts.cli, opts.sessionMinutes ?? 30),
    };

    try {
      // Simple prompts may produce no tool events at all — show something
      // from the moment the CLI starts.
      this.sendStage({ kind: "thinking" });
      return await this._attempt(opts.cli, baseRequest, controller.signal, true);
    } finally {
      if (this._current?.controller === controller) this._current = null;
    }
  }

  async _attempt(cli, request, signal, allowSessionRetry) {
    const adapter = this.adapterFactories[cli]();
    try {
      const result = await adapter.run(request, {
        signal,
        onEvent: (evt) => {
          if (evt.type === "stage") this.sendStage(evt.label);
        },
      });
      if (result.sessionId) this.sessionStore.set(cli, result.sessionId);
      return result;
    } catch (err) {
      const staleSession =
        allowSessionRetry &&
        request.resumeSessionId &&
        err instanceof CliAgentError &&
        err.code !== "cancelled" &&
        adapter.isUnknownSessionError(err.stderr || "");
      if (!staleSession) throw err;
      debugLogger.debug("cli-agent: stale session, retrying without resume", { cli }, "cli-agent");
      this.sessionStore.clear(cli);
      return this._attempt(cli, { ...request, resumeSessionId: null }, signal, false);
    }
  }
}

module.exports = { CliAgentManager, CLI_CHANNEL_PROMPT };
