const { spawn } = require("child_process");
const { SECRET_ENV_KEYS } = require("../../config/secretKeys");

// Strip BYOK/enterprise secrets so they never leak into the CLI's env — e.g.
// Claude Code prefers ANTHROPIC_API_KEY over subscription auth when present.
function buildChildEnv() {
  const env = { ...process.env };
  for (const key of SECRET_ENV_KEYS) delete env[key];
  return env;
}

class CliAgentError extends Error {
  constructor(message, code, stderr = "") {
    super(message);
    this.name = "CliAgentError";
    this.code = code;
    this.stderr = stderr;
  }
}

class BaseCliAdapter {
  // Subclasses implement: get id(), get binaryName(), buildArgs(request),
  // mapEvent(json), isUnknownSessionError(stderrText).

  run(request, { onEvent = () => {}, signal, spawnFn = spawn } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stderrText = "";
      let lineBuffer = "";
      let sessionId = request.resumeSessionId || null;
      let result = null;
      let timeoutHandle = null;

      const child = spawnFn(request.commandPath, this.buildArgs(request), {
        cwd: request.cwd,
        env: buildChildEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      // Kill the whole process group (bash/MCP subprocesses the agent spawned),
      // not just the direct child, since child is spawned detached on non-Windows.
      const killChild = () => {
        if (child.pid && process.platform !== "win32") {
          try {
            process.kill(-child.pid, "SIGKILL");
            return;
          } catch {
            /* process group already gone; fall back to direct kill */
          }
        }
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      };

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener("abort", onAbort);
        child.stdout.removeListener("data", onStdoutData);
        child.stderr.removeListener("data", onStderrData);
        fn(value);
      };

      const killAndReject = (code, message) => {
        finish(reject, new CliAgentError(message, code, stderrText));
        killChild();
      };

      const onAbort = () => killAndReject("cancelled", "CLI agent run cancelled");
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }

      timeoutHandle = setTimeout(
        () => killAndReject("timeout", `CLI agent timed out after ${request.timeoutMs}ms`),
        request.timeoutMs
      );
      timeoutHandle.unref?.();

      const handleNormalized = (evt) => {
        if (!evt) return;
        if (Array.isArray(evt)) return evt.forEach(handleNormalized);
        if (evt.type === "init" && evt.sessionId) sessionId = evt.sessionId;
        else if (evt.type === "result") result = evt;
        onEvent(evt);
      };

      const consumeLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let json;
        try {
          json = JSON.parse(trimmed);
        } catch {
          return; // non-JSON noise is never fatal
        }
        handleNormalized(this.mapEvent(json));
      };

      const onStdoutData = (chunk) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop();
        lines.forEach(consumeLine);
      };
      const onStderrData = (chunk) => {
        stderrText += chunk.toString();
      };
      child.stdout.on("data", onStdoutData);
      child.stderr.on("data", onStderrData);
      child.on("error", (err) =>
        finish(reject, new CliAgentError(err.message, "spawn", stderrText))
      );
      child.on("close", () => {
        if (lineBuffer) consumeLine(lineBuffer);
        if (!result) {
          return finish(
            reject,
            new CliAgentError("CLI exited without a result event", "no_result", stderrText)
          );
        }
        if (result.isError) {
          return finish(
            reject,
            new CliAgentError(result.text || "CLI agent reported an error", "cli_error", stderrText)
          );
        }
        finish(resolve, {
          text: result.text,
          sessionId,
          permissionDenials: result.permissionDenials || [],
        });
      });
    });
  }
}

module.exports = { BaseCliAdapter, CliAgentError };
