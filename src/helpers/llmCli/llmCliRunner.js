// Streamed prompt runner for the subscription-CLI seats. Electron-free: every
// side effect (spawn, fs, tree kill, exe resolution, token lookup) is injected,
// so tests drive it with a fake CLI. Decisions (argv, env, parsers, timeouts,
// redaction) come from ../llmCliProviders.
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const nodeFs = require("fs");
const { spawn: nodeSpawn } = require("child_process");
const policy = require("../llmCliProviders");

const STDOUT_CAP = 2 * 1024 * 1024;
const STDERR_CAP = 8 * 1024;
const MESSAGE_CAP = 500;

// Windows: taskkill /T /F reaps the whole tree (the CLIs spawn children). It is
// awaited and child.kill() is not called first: killing the parent first makes
// taskkill fail with "process not found" and leaves descendants alive.
// POSIX: the child leads its own process group (detached), so a negative pid
// kills the group.
function defaultKillTree(child, { platform = process.platform, spawn = nodeSpawn } = {}) {
  if (!child || !child.pid) return Promise.resolve();
  if (platform === "win32") {
    return new Promise((resolve) => {
      try {
        const killer = spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
          windowsHide: true,
          shell: false,
          stdio: "ignore",
        });
        killer.on("error", () => resolve());
        killer.on("exit", () => resolve());
      } catch {
        resolve();
      }
    });
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Group already gone.
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Already exited.
  }
  return Promise.resolve();
}

const CLOSE_WAIT_MS = 5000;

function appendCapped(current, chunk, cap) {
  const next = current + chunk;
  return next.length > cap ? next.slice(next.length - cap) : next;
}

function createRunner({
  spawn = nodeSpawn,
  fs = nodeFs,
  tmpDir = path.join(os.tmpdir(), "openwhispr-llm-cli"),
  log = () => {},
  killTree = defaultKillTree,
  platform = process.platform,
  env = process.env,
  resolveExe,
  getClaudeToken = async () => null,
  timeouts = {},
} = {}) {
  if (typeof resolveExe !== "function") throw new Error("resolveExe is required");
  const limits = { ...policy.TIMEOUTS, ...timeouts };
  const active = new Map(); // seat -> run

  function fail(code, message = "") {
    return { ok: false, code, message };
  }

  async function runStream({ seat, modelId, prompt, onPart = () => {}, signal, totalMs } = {}) {
    const runLimits =
      Number.isFinite(totalMs) && totalMs > 0
        ? { ...limits, totalMs: Math.min(limits.totalMs, totalMs) }
        : limits;
    const provider = policy.getProvider(seat);
    if (!provider) return fail("invalid-input", "unknown seat");

    let promptText;
    try {
      promptText = policy.assertPromptOk(policy.flattenPromptToText(prompt));
    } catch (error) {
      return fail(error.code || "invalid-input", error.message);
    }
    if (active.has(seat)) return fail("busy", "a run is already active for this seat");
    if (signal?.aborted) return fail("killed", "cancelled before start");

    // A cancel can arrive while the exe or token is still resolving, before there
    // is a child to kill. Record it now; the spawn path checks the flag.
    let cancelled = false;
    const run = {
      seat,
      child: null,
      terminated: null,
      cancel: () => {
        cancelled = true;
      },
    };
    active.set(seat, run);

    let runDir = null;
    let token = null;
    const timers = [];
    const onAbort = () => run.cancel();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      const resolved = await resolveExe(seat);
      const exe = typeof resolved === "string" ? resolved : resolved?.exe;
      const prefixArgs = typeof resolved === "object" && resolved ? resolved.args || [] : [];
      if (!exe || !path.isAbsolute(exe)) return fail("not-installed", "executable not found");

      if (seat === "claude") {
        token = await getClaudeToken();
        if (!token) return fail("not-signed-in", "no stored claude token");
      }
      // Last checkpoint before the synchronous path to spawn().
      if (cancelled) return fail("killed", "cancelled");

      fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
      runDir = fs.mkdtempSync(path.join(tmpDir, "run-"));
      const argvOpts = { model: modelId, prompt: promptText };
      let outputFile = null;
      if (seat === "codex") {
        outputFile = path.join(runDir, "last-message.txt");
        argvOpts.outputFile = outputFile;
      }
      if (seat === "grok") {
        argvOpts.promptFile = path.join(runDir, `prompt-${crypto.randomUUID()}.txt`);
        fs.writeFileSync(argvOpts.promptFile, promptText, { mode: 0o600 });
      }
      let argv;
      try {
        argv = policy.buildRunArgv(seat, argvOpts);
      } catch (error) {
        return fail(error.code || "invalid-input", error.message);
      }
      const childEnv = policy.buildChildEnv(seat, env, { oauthToken: token });
      const literals = token ? [token] : [];

      return await new Promise((resolve) => {
        let child;
        try {
          child = spawn(exe, [...prefixArgs, ...argv], {
            cwd: runDir,
            env: childEnv,
            windowsHide: true,
            shell: false,
            detached: platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch (error) {
          resolve(fail("exit-nonzero", policy.redactSecrets(String(error.message), literals)));
          return;
        }
        run.child = child;
        // Decode with the stream's own incremental decoder so a multibyte
        // character split across chunks is not corrupted.
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");

        let settled = false;
        let stdoutText = "";
        let stderrTail = "";
        let lineBuf = "";
        let textId = null;
        let gotDelta = false;
        let finalText = null;
        let parsedError = null;

        const clearTimers = () => {
          for (const t of timers.splice(0)) clearTimeout(t);
        };
        const settle = (result) => {
          if (settled) return;
          settled = true;
          clearTimers();
          resolve(result);
        };
        let markClosed;
        const closed = new Promise((resolve) => {
          markClosed = resolve;
        });
        const terminate = (code, message) => {
          if (run.terminated) return;
          run.terminated = code;
          clearTimers();
          // Resolve only after the tree-kill finished and the child closed, so the
          // run dir is no longer held. The wait is bounded so a stuck pipe cannot
          // hold the caller forever.
          Promise.resolve(killTree(child))
            .catch(() => {})
            .then(() =>
              Promise.race([
                closed,
                new Promise((resolve) => timers.push(setTimeout(resolve, CLOSE_WAIT_MS))),
              ])
            )
            .then(() => settle(fail(code, message)));
        };
        run.cancel = () => terminate("killed", "cancelled");

        const emitDelta = (text) => {
          if (!text) return;
          if (textId === null) {
            textId = crypto.randomUUID();
            onPart({ type: "text-start", id: textId });
          }
          gotDelta = true;
          onPart({ type: "text-delta", id: textId, delta: text });
        };

        let firstOutputSeen = false;
        const armIdle = () => {
          const id = setTimeout(
            () => terminate("timeout", "no output within the idle limit"),
            firstOutputSeen ? runLimits.idleMs : runLimits.firstOutputMs
          );
          timers.push(id);
          return id;
        };
        let idleTimer = armIdle();
        const touch = () => {
          clearTimeout(idleTimer);
          firstOutputSeen = true;
          idleTimer = armIdle();
        };
        timers.push(setTimeout(() => terminate("timeout", "total time limit"), runLimits.totalMs));

        const handleClaudeLine = (line) => {
          const event = policy.parseClaudeStreamLine(line);
          if (!event) return;
          if (event.type === "text-delta") emitDelta(event.text);
          else if (event.type === "final") finalText = event.text;
          else if (event.type === "error") parsedError = event.code;
        };

        child.stdout.on("data", (chunk) => {
          touch();
          const text = chunk;
          if (seat === "claude") {
            lineBuf += text;
            if (lineBuf.length > STDOUT_CAP) lineBuf = "";
            let idx;
            while ((idx = lineBuf.indexOf("\n")) !== -1) {
              handleClaudeLine(lineBuf.slice(0, idx));
              lineBuf = lineBuf.slice(idx + 1);
            }
          } else if (stdoutText.length < STDOUT_CAP) {
            stdoutText += text.slice(0, STDOUT_CAP - stdoutText.length);
          }
        });
        child.stderr.on("data", (chunk) => {
          touch();
          stderrTail = appendCapped(stderrTail, chunk, STDERR_CAP);
        });
        // A CLI that exits before reading stdin raises EPIPE; the exit code
        // decides the outcome.
        child.stdin.on("error", () => {});
        child.on("error", (error) => {
          const code = error && error.code === "ENOENT" ? "not-installed" : "exit-nonzero";
          settle(fail(code, policy.redactSecrets(String(error && error.message), literals)));
        });

        child.on("close", (exitCode) => {
          markClosed();
          if (settled || run.terminated) return;
          if (seat === "claude" && lineBuf.trim()) handleClaudeLine(lineBuf);
          const classifyText = `${stderrTail}\n${seat === "claude" ? "" : stdoutText.slice(-STDERR_CAP)}`;
          const failure = (code) =>
            fail(code, policy.redactSecrets(stderrTail.slice(-MESSAGE_CAP), literals));
          let outcome = null; // { text } | { code }

          if (seat === "claude") {
            if (parsedError) outcome = { code: parsedError };
            else if (exitCode !== 0 && finalText === null)
              outcome = { code: policy.classifyStderr(seat, classifyText) || "exit-nonzero" };
            else if (finalText === null && !gotDelta) outcome = { code: "parse-failed" };
            else outcome = { text: finalText };
          } else if (exitCode !== 0) {
            outcome = { code: policy.classifyStderr(seat, classifyText) || "exit-nonzero" };
          } else if (seat === "codex") {
            let fileText = "";
            try {
              fileText = fs.readFileSync(outputFile, "utf8");
            } catch {
              // Missing file falls through to parseCodexFinal's classification.
            }
            const parsed = policy.parseCodexFinal({ fileText, stderrText: stderrTail });
            outcome = parsed.type === "final" ? { text: parsed.text } : { code: parsed.code };
          } else {
            const parsed = policy.parseJsonResult(seat, stdoutText);
            outcome = parsed.type === "final" ? { text: parsed.text } : { code: parsed.code };
          }

          if (outcome.code) {
            settle(failure(outcome.code));
            return;
          }
          if (!gotDelta) emitDelta(outcome.text);
          if (textId !== null) onPart({ type: "text-end", id: textId });
          onPart({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: undefined, noCache: undefined },
              outputTokens: { total: undefined, text: undefined },
            },
          });
          settle({ ok: true, text: outcome.text });
        });

        try {
          if (seat === "claude" || seat === "codex") child.stdin.write(promptText);
          child.stdin.end();
        } catch {
          // Child already gone; close handles the outcome.
        }
      });
    } finally {
      for (const t of timers.splice(0)) clearTimeout(t);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (runDir) {
        try {
          await fs.promises.rm(runDir, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 100,
          });
        } catch (error) {
          log("llm-cli run dir cleanup failed", error && error.code);
        }
      }
      token = null;
      active.delete(seat);
    }
  }

  function cancel(seat) {
    active.get(seat)?.cancel?.();
  }

  function cancelAll() {
    for (const run of active.values()) run.cancel?.();
  }

  return { runStream, cancel, cancelAll, isBusy: (seat) => active.has(seat) };
}

module.exports = { createRunner, defaultKillTree };
