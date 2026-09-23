const childProcess = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;

function defaultModelForAdapter(adapter) {
  return adapter === "devin-cli" ? "swe" : "haiku";
}

class AgentCliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AgentCliError";
    this.code = code;
  }
}

class AgentCliRunner {
  constructor(options = {}) {
    this.spawn = options.spawn || childProcess.spawn;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.availabilityTimeoutMs = options.availabilityTimeoutMs || 5_000;
    this.outputLimit = options.outputLimit || DEFAULT_OUTPUT_LIMIT;
    this.killGraceMs = options.killGraceMs || 1_000;
    this.killProcess = options.killProcess || process.kill.bind(process);
    this.platform = options.platform || process.platform;
    this.spawnTreeKiller = options.spawnTreeKiller || childProcess.spawn;
    this.removeTempDir =
      options.removeTempDir ||
      ((cwd) => fs.rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
    this.terminationPromises = new WeakMap();
    this.active = new Map();
    this.pending = new Set();
    this.pendingCancellations = new Set();
  }

  async process(request) {
    this._validateRequest(request);
    if (this.active.has(request.requestId) || this.pending.has(request.requestId)) {
      throw new AgentCliError("DUPLICATE_REQUEST", "Request ID is already active");
    }
    this.pending.add(request.requestId);
    let cwd;
    let primaryError;
    try {
      cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openwhispr-agent-cli-"));
      if (this.pendingCancellations.delete(request.requestId)) {
        throw new AgentCliError("CANCELLED", "Agent CLI request was cancelled");
      }
      const command = this._command(request);
      const args = await this._args(request, cwd);
      if (this.pendingCancellations.delete(request.requestId)) {
        throw new AgentCliError("CANCELLED", "Agent CLI request was cancelled");
      }
      return await this._spawn(request, command, args, cwd);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      this.pending.delete(request.requestId);
      this.pendingCancellations.delete(request.requestId);
      if (cwd) {
        try {
          await this.removeTempDir(cwd);
        } catch {
          if (!primaryError) {
            throw new AgentCliError("CLEANUP_FAILED", "Agent CLI temporary data cleanup failed");
          }
        }
      }
    }
  }

  async checkAvailability({ adapter, executablePath } = {}) {
    if (adapter !== "claude-cli" && adapter !== "devin-cli") {
      return { available: false, adapter, code: "INVALID_ADAPTER" };
    }
    if (executablePath && !path.isAbsolute(executablePath)) {
      return { available: false, adapter, code: "INVALID_EXECUTABLE" };
    }
    if (executablePath) {
      try {
        await fs.access(executablePath, require("node:fs").constants.X_OK);
      } catch {
        return { available: false, adapter, code: "NOT_FOUND" };
      }
    }

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openwhispr-agent-cli-check-"));
    const command = executablePath || (adapter === "claude-cli" ? "claude" : "devin");
    try {
      return await new Promise((resolve) => {
        let child;
        try {
          child = this.spawn(command, ["auth", "status"], {
            cwd,
            env: { ...process.env },
            shell: false,
            detached: this.platform !== "win32",
            stdio: ["ignore", "ignore", "ignore"],
            windowsHide: true,
          });
        } catch (error) {
          resolve({
            available: false,
            adapter,
            code: error?.code === "ENOENT" ? "NOT_FOUND" : "SPAWN_FAILED",
          });
          return;
        }
        let settled = false;
        let timer;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const terminateAndFinish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          void this._terminate(child).then(
            () => resolve(result),
            () => resolve(result)
          );
        };
        child.on("error", (error) =>
          finish({
            available: false,
            adapter,
            code: error?.code === "ENOENT" ? "NOT_FOUND" : "SPAWN_FAILED",
          })
        );
        child.on("close", (code) =>
          finish({
            available: code === 0,
            adapter,
            ...(code === 0 ? {} : { code: "AUTH_FAILED" }),
          })
        );
        timer = setTimeout(
          () => terminateAndFinish({ available: false, adapter, code: "TIMEOUT" }),
          this.availabilityTimeoutMs
        );
      });
    } finally {
      try {
        await this.removeTempDir(cwd);
      } catch {}
    }
  }

  _validateRequest(request) {
    if (!request || typeof request.requestId !== "string" || !request.requestId.trim()) {
      throw new AgentCliError("INVALID_REQUEST", "A request ID is required");
    }
    if (request.adapter !== "claude-cli" && request.adapter !== "devin-cli") {
      throw new AgentCliError("INVALID_ADAPTER", "Unsupported Agent CLI adapter");
    }
    if (typeof request.systemPrompt !== "string" || typeof request.userPrompt !== "string") {
      throw new AgentCliError("INVALID_REQUEST", "System and user prompts are required");
    }
    if (request.executablePath && !path.isAbsolute(request.executablePath)) {
      throw new AgentCliError("INVALID_EXECUTABLE", "Executable path must be absolute");
    }
  }

  _command(request) {
    return request.executablePath || (request.adapter === "claude-cli" ? "claude" : "devin");
  }

  async _args(request, cwd) {
    const model = request.model?.trim() || defaultModelForAdapter(request.adapter);
    if (request.adapter === "claude-cli") {
      const systemPromptPath = path.join(cwd, "system-prompt.txt");
      await fs.writeFile(systemPromptPath, request.systemPrompt, { mode: 0o600 });
      return [
        "-p",
        "--model",
        model,
        "--system-prompt-file",
        systemPromptPath,
        "--tools",
        "",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--setting-sources",
        "",
        "--output-format",
        "text",
      ];
    }
    const promptPath = path.join(cwd, "prompt.txt");
    await fs.writeFile(promptPath, `${request.systemPrompt}\n\n${request.userPrompt}`, {
      mode: 0o600,
    });
    return [
      "-p",
      "--model",
      model,
      "--permission-mode",
      "auto",
      "--prompt-file",
      promptPath,
    ];
  }

  _spawn(request, command, args, cwd) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawn(command, args, {
          cwd,
          env: { ...process.env },
          shell: false,
          detached: this.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        reject(this._spawnError(error));
        return;
      }

      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let settled = false;
      let timeout;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.active.delete(request.requestId);
        fn(value);
      };
      const terminateAndReject = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.active.delete(request.requestId);
        void this._terminate(child).then(
          () => reject(error),
          () => reject(error)
        );
      };
      child.stdout.on("data", (chunk) => {
        const buffer = Buffer.from(chunk);
        if (stdout.length + buffer.length > this.outputLimit) {
          terminateAndReject(
            new AgentCliError("OUTPUT_LIMIT", "Agent CLI output exceeded the allowed size")
          );
          return;
        }
        stdout = Buffer.concat([stdout, buffer]);
      });
      child.stderr.on("data", (chunk) => {
        const buffer = Buffer.from(chunk);
        if (stderr.length + buffer.length > this.outputLimit) {
          terminateAndReject(
            new AgentCliError("OUTPUT_LIMIT", "Agent CLI output exceeded the allowed size")
          );
          return;
        }
        stderr = Buffer.concat([stderr, buffer]);
      });
      child.on("error", (error) => finish(reject, this._spawnError(error)));
      child.stdin.on("error", () => {});
      child.on("close", (code, signal) => {
        if (code !== 0) {
          const errorText = `${stderr.toString("utf8")}\n${stdout.toString("utf8")}`;
          let errorCode = "PROCESS_EXIT";
          let message = `Agent CLI exited unsuccessfully (${code ?? signal})`;
          if (/auth|login|log in|credential|unauthorized/i.test(errorText)) {
            errorCode = "AUTH_FAILED";
            message = "Agent CLI authentication is required";
          } else if (/credit balance|insufficient credit|billing/i.test(errorText)) {
            errorCode = "BILLING_REQUIRED";
            message = "Agent CLI account has insufficient credits";
          } else if (/\/upgrade|access this model|model.*not.*available/i.test(errorText)) {
            errorCode = "MODEL_UNAVAILABLE";
            message = "The selected model is not available for this Agent CLI account";
          }
          finish(reject, new AgentCliError(errorCode, message));
          return;
        }
        const text = stdout.toString("utf8").trim();
        if (!text) {
          finish(reject, new AgentCliError("EMPTY_OUTPUT", "Agent CLI returned empty output"));
          return;
        }
        finish(resolve, { requestId: request.requestId, text });
      });
      this.active.set(request.requestId, {
        child,
        cancel: () => {
          terminateAndReject(new AgentCliError("CANCELLED", "Agent CLI request was cancelled"));
        },
      });
      timeout = setTimeout(() => {
        terminateAndReject(new AgentCliError("TIMEOUT", "Agent CLI request timed out"));
      }, this.timeoutMs);
      child.stdin.end(request.adapter === "claude-cli" ? request.userPrompt : undefined);
    });
  }

  _spawnError(error) {
    if (error?.code === "ENOENT") {
      return new AgentCliError("NOT_FOUND", "Agent CLI executable was not found");
    }
    return new AgentCliError("SPAWN_FAILED", "Agent CLI failed to start");
  }

  _terminate(child) {
    if (!child?.pid) return Promise.resolve();
    const existing = this.terminationPromises.get(child);
    if (existing) return existing;

    const termination =
      this.platform === "win32"
        ? this._terminateWindowsTree(child.pid)
        : (async () => {
            try {
              this.killProcess(-child.pid, "SIGTERM");
            } catch {}
            await new Promise((resolve) => setTimeout(resolve, this.killGraceMs));
            try {
              this.killProcess(-child.pid, "SIGKILL");
            } catch {}
          })();
    this.terminationPromises.set(child, termination);
    return termination;
  }

  _terminateWindowsTree(pid) {
    return new Promise((resolve) => {
      let killer;
      try {
        killer = this.spawnTreeKiller("taskkill", ["/PID", String(pid), "/T", "/F"], {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        });
      } catch {
        resolve();
        return;
      }
      let settled = false;
      let timer;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      killer.once?.("close", finish);
      killer.once?.("error", finish);
      if (!settled) timer = setTimeout(finish, Math.max(this.killGraceMs, 1_000));
      killer.unref?.();
    });
  }

  cancel(requestId) {
    const active = this.active.get(requestId);
    if (active) {
      active.cancel();
      return true;
    }
    if (this.pending.has(requestId)) {
      this.pendingCancellations.add(requestId);
      return true;
    }
    return false;
  }

  killAll() {
    for (const requestId of [...this.active.keys()]) {
      this.cancel(requestId);
    }
    for (const requestId of [...this.pending]) {
      this.cancel(requestId);
    }
  }
}

module.exports = {
  AgentCliRunner,
  AgentCliError,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_OUTPUT_LIMIT,
  defaultModelForAdapter,
};
