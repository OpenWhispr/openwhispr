const {
  runLocalModelOperation,
  assertLocalModelOperation,
  localModelOperationSignal,
} = require("./localModelPolicyGate");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const debugLogger = require("./debugLogger");
const { killProcess } = require("../utils/process");
const { isPortAvailable } = require("../utils/serverUtils");
const { getSafeTempDir } = require("./safeTempDir");
const { app } = require("electron");
const sidecarPidFile = require("./sidecarPidFile");
const { BIN_SUBDIR: LLAMA_VULKAN_BIN_SUBDIR } = require("./llamaVulkanManager");
const { BASELINE_CONTEXT_SIZE } = require("./llamaContextPolicy");

// Range kept clear of cliBridge (8200-8219) to avoid port-bind collisions.
const PORT_RANGE_START = 8221;
const PORT_RANGE_END = 8240;
const STARTUP_TIMEOUT_MS = 120000;
const VULKAN_STARTUP_TIMEOUT_MS = 120000;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const HEALTH_CHECK_TIMEOUT_MS = 2000;
const STARTUP_POLL_INTERVAL_MS = 500;
const HEALTH_CHECK_FAILURE_THRESHOLD = 3;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
// A restart waits this long for an answer in progress, unless the caller says otherwise.
const DEFAULT_BUSY_WAIT_MS = 60000;
const BUSY_WAIT_POLL_MS = 200;
const MIN_SLOTS_READ_MS = 250;
// How long a caller told "ready" has to get its request to the server. /slots
// reads idle until then, and streaming chat connects from the renderer.
const HANDOFF_GRACE_MS = 1000;
const SLOTS_UNANSWERED = Symbol("slots-unanswered");
const DEFAULT_CONTEXT_SIZE = 4096;
const PREFLIGHT_TIMEOUT_MS = 10000;
const SLOT_POLL_INTERVAL_MS = 1000;

/**
 * llama-server reports a prompt that overflows the context as a 400 whose body
 * is a JSON blob. Surfacing that verbatim is how customers ended up reading
 * llama.cpp internals in a toast (#2142), so it becomes a typed error carrying
 * the two numbers callers actually need.
 */
/** Same argv with --ctx-size rewritten; used by the context step-down rung. */
function withContextSize(args, contextSize) {
  const index = args.indexOf("--ctx-size");
  if (index === -1) return args;
  const copy = [...args];
  copy[index + 1] = String(contextSize);
  return copy;
}

// Whether a server started with `server`'s settings can take `request` without
// a restart: the same model and drafter, and a context at least as large. The context
// only grows, so a short request never shrinks a window a long one opened.
function servesRequest(server, request) {
  return (
    server.modelPath === request.modelPath &&
    server.draftModelPath === request.draftModelPath &&
    request.contextSize <= (server.contextSize || 0)
  );
}

function modelBusyError() {
  return Object.assign(new Error("The local model is still working on another request."), {
    code: "LOCAL_MODEL_BUSY",
  });
}

function cancelledError() {
  return Object.assign(new Error("cancelled"), { code: "LOCAL_MODEL_CANCELLED" });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildResponseError(statusCode, body) {
  if (statusCode === 400) {
    try {
      const parsed = JSON.parse(body)?.error;
      const isOverflow =
        parsed?.type === "exceed_context_size_error" ||
        /exceeds the available context size/i.test(parsed?.message || "");

      if (isOverflow) {
        const neededTokens = Number(parsed.n_prompt_tokens) || null;
        const maxContextTokens = Number(parsed.n_ctx) || null;
        const error = new Error(
          neededTokens && maxContextTokens
            ? `The request needs ${neededTokens} tokens of context but the model is running with ${maxContextTokens}.`
            : "The request is longer than the context this model is running with."
        );
        error.code = "CONTEXT_TOO_LARGE";
        error.neededTokens = neededTokens;
        error.maxContextTokens = maxContextTokens;
        return error;
      }
    } catch {
      // Not JSON, or not the shape we expect: fall through to the generic error.
    }
  }

  return new Error(`llama-server returned status ${statusCode}: ${body}`);
}

class LlamaServerManager {
  constructor() {
    this.keepResident = false;
    this.process = null;
    this.port = null;
    this.ready = false;
    this.activeRequest = null;
    this.modelPath = null;
    // draftModelPath is the REQUESTED drafter (stable across identical requests, drives
    // the start() restart check); activeDraftModelPath is the one that actually loaded.
    this.draftModelPath = null;
    this.activeDraftModelPath = null;
    // The context that actually loaded, which the GPU ladder may step down
    // below the requested one.
    this.activeContextSize = null;
    // The context the running server was started with. Grows on demand and is
    // only reset by stop(), so a short request cannot shrink a window a long
    // one just paid to open. See #2142.
    this.contextSize = null;
    this.startupPromise = null;
    // What the in-flight startup was asked for, so start() can tell whether
    // joining it would serve another caller's request.
    this.startingRequest = null;
    this.stopPromise = null;
    this.deferredStop = null;
    this.handoffUntil = 0;
    // Counts handoffs, so a /slots read can tell one happened while it was out.
    this.handoffs = 0;
    this.healthCheckInterval = null;
    this.healthCheckFailures = 0;
    this.cachedServerBinaryPaths = null;
    this.activeBackend = null;
    this.idleTimer = null;
  }

  getServerBinaryPaths() {
    if (this.cachedServerBinaryPaths) return this.cachedServerBinaryPaths;

    const platform = process.platform;
    const arch = process.arch;
    const platformArch = `${platform}-${arch}`;
    const ext = platform === "win32" ? ".exe" : "";

    const resolveBinary = (name) => {
      const candidates = [];
      if (process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, "bin", name));
      }
      candidates.push(path.join(__dirname, "..", "..", "resources", "bin", name));

      for (const candidate of candidates) {
        try {
          if (fs.existsSync(candidate)) {
            fs.statSync(candidate);
            return candidate;
          }
        } catch {
          // Can't access binary
        }
      }
      return null;
    };

    let paths;

    if (platform === "darwin") {
      const defaultBin =
        resolveBinary(`llama-server-${platformArch}`) || resolveBinary(`llama-server${ext}`);
      paths = defaultBin ? { default: defaultBin } : {};
    } else {
      const vulkanName = `llama-server-vulkan${ext}`;
      let vulkanBin = null;
      try {
        // Installed by LlamaVulkanManager into its own pack directory
        const vulkanPath = path.join(
          app.getPath("userData"),
          "bin",
          LLAMA_VULKAN_BIN_SUBDIR,
          vulkanName
        );
        if (fs.existsSync(vulkanPath)) vulkanBin = vulkanPath;
      } catch {}

      const cpuBin =
        resolveBinary(`llama-server-${platformArch}-cpu${ext}`) ||
        resolveBinary(`llama-server-${platformArch}${ext}`) ||
        resolveBinary(`llama-server${ext}`);

      paths = {};
      if (vulkanBin) paths.vulkan = vulkanBin;
      if (cpuBin) paths.cpu = cpuBin;
    }

    // Only cache hits: a miss may be transient (binary downloaded after
    // startup), and caching it would require an app restart to recover.
    if (Object.keys(paths).length > 0) {
      this.cachedServerBinaryPaths = paths;
    }
    return paths;
  }

  isAvailable() {
    const paths = this.getServerBinaryPaths();
    return Object.keys(paths).length > 0;
  }

  async findAvailablePort() {
    for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
      if (await isPortAvailable(port)) return port;
    }
    throw new Error(`No available ports in range ${PORT_RANGE_START}-${PORT_RANGE_END}`);
  }

  async start(modelPath, options = {}) {
    return runLocalModelOperation(
      this,
      "llm",
      this.localModelIdForPath?.(modelPath),
      // A revoked model ends its own wait through the lease's signal. The start
      // may be waiting behind another model's answer, so the server is stopped
      // only when it is, or is becoming, the revoked model.
      () =>
        this._policyAllowedStart(modelPath, {
          ...options,
          signal: localModelOperationSignal(this, options.signal),
        }),
      { onAbort: () => this._stopIfServing(modelPath) }
    );
  }

  _stopIfServing(modelPath) {
    if (this.modelPath === modelPath || this.startingRequest?.modelPath === modelPath) {
      return this.stop();
    }
  }

  _handOff() {
    this.handoffUntil = Date.now() + HANDOFF_GRACE_MS;
    this.handoffs += 1;
  }

  async _policyAllowedStart(modelPath, options = {}) {
    if (this.stopPromise) await this.stopPromise;
    this.cancelDeferredStop();

    const request = {
      modelPath,
      // A change in drafter presence for the same model must still restart the
      // server so the new speculative-decoding flags take effect.
      draftModelPath: options.draftModelPath || null,
      contextSize: options.contextSize || DEFAULT_CONTEXT_SIZE,
    };

    const busyDeadline = Date.now() + (options.busyWaitMs ?? DEFAULT_BUSY_WAIT_MS);
    // A caller that gives up during the wait must not still swap the model in.
    const { signal } = options;

    for (;;) {
      if (signal?.aborted) throw cancelledError();
      // Serialize with any in-flight startup; join it only when it will serve
      // this request. Callers record the model they asked for as loaded once
      // this resolves, so it must never resolve on a startup for another one.
      while (this.startupPromise) {
        if (servesRequest(this.startingRequest, request)) return this.startupPromise;
        await this._waitFor(
          this.startupPromise.catch(() => {}),
          {
            deadline: busyDeadline,
            signal,
          }
        );
      }

      if (this.ready && servesRequest(this, request)) {
        // Streaming chat reaches the port directly and never goes through
        // inference(), so asking for the running server is its only activity.
        this.resetIdleTimer();
        this._handOff();
        return;
      }

      // A server that failed its health check has no answer left to protect.
      if (!this.process || !this.ready) break;

      // Restarting kills whatever the server is generating. The wait stays out
      // of startupPromise so the running model keeps serving meanwhile.
      const server = this.process;
      const busy = await this._waitFor(this._isBusy(busyDeadline - Date.now()), { signal });
      if (this.startupPromise || this.process !== server) continue;
      if (!busy) break;
      const remaining = busyDeadline - Date.now();
      if (remaining <= 0) throw modelBusyError();
      await this._waitFor(sleep(Math.min(remaining, BUSY_WAIT_POLL_MS)), { signal });
    }

    this.startingRequest = request;
    // Assigned before any await so waiters woken by the same startup cannot
    // both spawn.
    this.startupPromise = (async () => {
      try {
        if (this.process) await this.stop();
        // Residency may have been turned off while the old server stopped.
        this.clearIdleTimer();
        await this._doStart(modelPath, options);
        // The ladder may have stepped the context down to get a GPU rung to
        // start; record what loaded, not what was asked for.
        this.contextSize = this.activeContextSize ?? request.contextSize;
        this._handOff();
      } finally {
        this.startupPromise = null;
        this.startingRequest = null;
      }
    })();
    return this.startupPromise;
  }

  // Settles with the promise, unless the deadline passes first (busy) or the
  // caller gives up (cancelled).
  async _waitFor(promise, { deadline = Infinity, signal } = {}) {
    if (signal?.aborted) throw cancelledError();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw modelBusyError();
    let timer;
    let onAbort;
    const interrupted = new Promise((_, reject) => {
      if (remaining !== Infinity) timer = setTimeout(() => reject(modelBusyError()), remaining);
      onAbort = () => reject(cancelledError());
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([promise, interrupted]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  // Whether a restart now would cut off work. A failed read says nothing, so it
  // can't hold a restart up; but llama-server answers /slots between batches, so
  // one that goes unanswered is usually still evaluating a long prompt.
  async _isBusy(budgetMs) {
    if (this.activeRequest || Date.now() < this.handoffUntil) return true;
    const handoffs = this.handoffs;
    const slots = await this._requestJson(
      "/slots",
      null,
      Math.min(PREFLIGHT_TIMEOUT_MS, Math.max(MIN_SLOTS_READ_MS, budgetMs)),
      SLOTS_UNANSWERED
    );
    // Work handed out while the read was out is newer than its answer.
    if (this.activeRequest || this.handoffs !== handoffs) return true;
    if (slots === SLOTS_UNANSWERED) return true;
    return Array.isArray(slots) && slots.some((slot) => slot.is_processing);
  }

  _buildBaseArgs(modelPath, port, options = {}) {
    const args = [
      "--model",
      modelPath,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--threads",
      String(options.threads || 4),
      // Unset, this defaults to the model's full trained context (128K+),
      // whose KV cache can exceed total RAM with --fit disabled. See #1203.
      // Sized per request against a memory budget by llamaContextPolicy.
      "--ctx-size",
      String(options.contextSize || DEFAULT_CONTEXT_SIZE),
      "--jinja",
    ];

    // llama-server otherwise reserves 8192 MiB of host RAM for the prompt
    // cache, on top of the KV cache, which would undo the memory budget. Cap
    // it rather than disabling it: 0 forces a full re-prefill every request.
    if (options.cacheRamMiB) args.push("--cache-ram", String(options.cacheRamMiB));

    return args;
  }

  async _doStart(modelPath, options = {}) {
    const binaryPaths = this.getServerBinaryPaths();
    if (Object.keys(binaryPaths).length === 0) throw new Error("llama-server binary not found");
    if (!fs.existsSync(modelPath)) throw new Error(`Model file not found: ${modelPath}`);

    this.port = await this.findAvailablePort();
    this.modelPath = modelPath;
    // Store the REQUESTED drafter so start() compares against a stable value across
    // identical requests; activeDraftModelPath tracks what actually loaded (see ctor).
    this.draftModelPath = options.draftModelPath || null;
    this.activeDraftModelPath = null;

    this.activeContextSize = options.contextSize || DEFAULT_CONTEXT_SIZE;
    const baseArgs = this._buildBaseArgs(modelPath, this.port, options);

    // Draft flags stay separate from baseArgs so the fallback ladder can retry without
    // them when a stale (pre-b9763) binary rejects the MTP args at parse time.
    const draftArgs = options.draftModelPath
      ? [
          "--model-draft",
          options.draftModelPath,
          "--spec-type",
          "draft-mtp",
          "--spec-draft-n-max",
          "3",
        ]
      : [];

    if (process.platform === "darwin") {
      // The metal binary is always the bundled pin, so it never rejects the draft flags.
      const args = [...baseArgs, "--n-gpu-layers", String(options.gpuLayers ?? 99), ...draftArgs];
      await this._startWithBinary(
        binaryPaths.default,
        args,
        this._buildEnv(binaryPaths.default),
        STARTUP_TIMEOUT_MS
      );
      this.activeBackend = "metal";
      this.activeDraftModelPath = this.draftModelPath;
    } else {
      await this._startWithGpuFallback(binaryPaths, baseArgs, options, draftArgs);
    }

    this.startHealthCheck();
    this.resetIdleTimer();
    debugLogger.info("llama-server started successfully", {
      port: this.port,
      model: path.basename(modelPath),
      backend: this.activeBackend,
      mtp: this.activeDraftModelPath !== null,
    });
  }

  async _startWithGpuFallback(binaryPaths, baseArgs, options, draftArgs = []) {
    const gpuArgs = [...baseArgs, "--n-gpu-layers", String(options.gpuLayers ?? 99)];
    const cpuArgs = baseArgs;
    const hasDraft = draftArgs.length > 0;
    const requestedContext = options.contextSize || DEFAULT_CONTEXT_SIZE;

    // Degrade ladder: GPU+MTP, then GPU alone (a live GPU beats speculation), then
    // CPU+MTP (the bundled pin normally accepts the flags), then plain CPU. The
    // no-draft rungs collapse into their twins when no drafter is declared, so a
    // drafterless start keeps today's exact single vulkan->cpu fallback.
    const rungs = [
      {
        backend: "vulkan",
        name: "Vulkan",
        binary: binaryPaths.vulkan,
        args: [...gpuArgs, ...draftArgs],
        mtp: hasDraft,
        timeout: VULKAN_STARTUP_TIMEOUT_MS,
        attemptMsg: "Attempting Vulkan backend startup",
      },
      {
        backend: "vulkan",
        name: "Vulkan",
        binary: binaryPaths.vulkan,
        args: gpuArgs,
        mtp: false,
        noDraft: true,
        timeout: VULKAN_STARTUP_TIMEOUT_MS,
        attemptMsg: "Attempting Vulkan backend startup",
      },
      // A context sized against system RAM can still be too big for a
      // discrete GPU's own memory, which the app does not probe. Halving it is
      // far cheaper than the 10-30x cost of dropping to CPU, so try that
      // first. Omitted entirely when there is nothing to step down to, so a
      // baseline start keeps today's exact ladder.
      ...(requestedContext > BASELINE_CONTEXT_SIZE && binaryPaths.vulkan
        ? [
            {
              backend: "vulkan",
              name: "Vulkan (reduced context)",
              binary: binaryPaths.vulkan,
              args: withContextSize(gpuArgs, BASELINE_CONTEXT_SIZE),
              mtp: false,
              contextSize: BASELINE_CONTEXT_SIZE,
              timeout: VULKAN_STARTUP_TIMEOUT_MS,
              attemptMsg: "Attempting Vulkan backend startup with a reduced context",
            },
          ]
        : []),
      {
        backend: "cpu",
        name: "CPU",
        binary: binaryPaths.cpu,
        args: [...cpuArgs, ...draftArgs],
        mtp: hasDraft,
        timeout: STARTUP_TIMEOUT_MS,
        attemptMsg: "Starting with CPU backend",
      },
      {
        backend: "cpu",
        name: "CPU",
        binary: binaryPaths.cpu,
        args: cpuArgs,
        mtp: false,
        noDraft: true,
        timeout: STARTUP_TIMEOUT_MS,
        attemptMsg: "Starting with CPU backend",
      },
    ];

    const ladder = rungs.filter((rung) => rung.binary && !(rung.noDraft && !hasDraft));
    if (ladder.length === 0) throw new Error("No CPU llama-server binary available");

    let lastError = null;
    for (let i = 0; i < ladder.length; i++) {
      const rung = ladder[i];
      const next = ladder[i + 1];
      try {
        debugLogger.debug(rung.attemptMsg);
        await this._startWithBinary(
          rung.binary,
          rung.args,
          this._buildEnv(rung.binary),
          rung.timeout
        );
        this.activeBackend = rung.backend;
        this.activeDraftModelPath = rung.mtp ? this.draftModelPath : null;
        // Without this the preflight would believe the full context is
        // available and send a prompt the server cannot take.
        this.activeContextSize = rung.contextSize ?? requestedContext;
        this.contextSize = this.activeContextSize;
        return;
      } catch (err) {
        lastError = err;
        if (next) {
          debugLogger.warn(`${rung.name} backend failed, falling back to ${next.name}`, {
            error: err.message,
          });
          await this._killCurrentProcess();
          this.port = await this.findAvailablePort();
        }
      }
    }

    throw lastError || new Error("No CPU llama-server binary available");
  }

  _buildEnv(binaryPath) {
    const binDir = path.dirname(binaryPath);
    const env = { ...process.env };

    if (process.platform === "darwin") {
      env.DYLD_LIBRARY_PATH = binDir + (env.DYLD_LIBRARY_PATH ? `:${env.DYLD_LIBRARY_PATH}` : "");
    } else if (process.platform === "linux") {
      env.LD_LIBRARY_PATH = binDir + (env.LD_LIBRARY_PATH ? `:${env.LD_LIBRARY_PATH}` : "");
    } else if (process.platform === "win32") {
      env.PATH = binDir + (env.PATH ? `;${env.PATH}` : "");
    }

    // Select GPU by UUID + PCI_BUS_ID order so the device is unambiguous. See #531.
    env.CUDA_DEVICE_ORDER = "PCI_BUS_ID";
    if (process.env.INTELLIGENCE_GPU_UUID) {
      env.CUDA_VISIBLE_DEVICES = process.env.INTELLIGENCE_GPU_UUID;
    }

    // Disable llama.cpp auto-fit memory probing (adds ~70s to startup). Set via env
    // so builds without --fit ignore it instead of erroring. See LLAMA_ARG_FIT.
    env.LLAMA_ARG_FIT = process.env.LLAMA_ARG_FIT || "off";

    return env;
  }

  _startWithBinary(binaryPath, args, env, timeoutMs) {
    return new Promise((resolve, reject) => {
      debugLogger.debug("Spawning llama-server", { binary: binaryPath, port: this.port, args });

      assertLocalModelOperation(this);
      const child = spawn(binaryPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        cwd: getSafeTempDir(),
        env,
        detached: process.platform !== "win32",
      });
      this.process = child;
      sidecarPidFile.write("llama", child.pid);

      let stderrBuffer = "";
      let exitCode = null;
      let exitSignal = null;
      let settled = false;

      const settle = (fn) => {
        if (settled) return;
        settled = true;
        fn();
      };

      child.stdout.on("data", (data) => {
        debugLogger.debug("llama-server stdout", { data: data.toString().trim() });
      });

      child.stderr.on("data", (data) => {
        stderrBuffer += data.toString();
        debugLogger.debug("llama-server stderr", { data: data.toString().trim() });
      });

      child.on("error", (error) => {
        debugLogger.error("llama-server process error", { error: error.message });
        if (this.process === child) this.ready = false;
        settle(() => reject(new Error(`Failed to spawn llama-server: ${error.message}`)));
      });

      child.on("close", (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        debugLogger.debug("llama-server process exited", { code, signal });
        // A SIGKILLed server can exit after stop() moved on and the next one
        // spawned; losing that one's handle would orphan it.
        if (this.process !== child) return;
        this.ready = false;
        this.process = null;
        this.stopHealthCheck();
        sidecarPidFile.clear("llama");
      });

      const getProcessInfo = () => ({ stderr: stderrBuffer, exitCode, exitSignal });

      const startTime = Date.now();
      let pollCount = 0;

      const poll = async () => {
        if (settled) return;

        if (!this.process || this.process.killed) {
          const info = getProcessInfo();
          const signal = info.exitSignal;
          const diagParts = [];
          if (signal) diagParts.push(`signal: ${signal}`);
          else if (info.exitCode !== null && info.exitCode !== undefined)
            diagParts.push(`exit code: ${info.exitCode}`);
          const oomHint =
            signal === "SIGKILL"
              ? " — the process was killed by the OS, likely due to insufficient memory. Try a smaller/more quantized model, or reduce the context size."
              : "";
          const stderr = info.stderr ? info.stderr.trim().slice(-800) : "";
          const diagStr = diagParts.length ? ` (${diagParts.join(", ")})` : "";
          settle(() =>
            reject(
              new Error(
                `llama-server process died during startup${diagStr}${oomHint}${stderr ? `\nProcess output: ${stderr}` : ""}`
              )
            )
          );
          return;
        }

        pollCount++;
        if (await this.checkHealth()) {
          this.ready = true;
          debugLogger.debug("llama-server ready", {
            startupTimeMs: Date.now() - startTime,
            pollCount,
          });
          settle(() => resolve());
          return;
        }

        if (Date.now() - startTime >= timeoutMs) {
          settle(() => reject(new Error(`llama-server failed to start within ${timeoutMs}ms`)));
          return;
        }

        setTimeout(poll, STARTUP_POLL_INTERVAL_MS);
      };

      poll();
    });
  }

  async _killCurrentProcess() {
    if (!this.process) return;

    this.stopHealthCheck();

    try {
      killProcess(this.process, "SIGTERM");
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) killProcess(this.process, "SIGKILL");
          resolve();
        }, 5000);

        if (this.process) {
          this.process.once("close", () => {
            clearTimeout(timeout);
            resolve();
          });
        } else {
          clearTimeout(timeout);
          resolve();
        }
      });
    } catch (error) {
      debugLogger.error("Error killing llama-server process", { error: error.message });
    }

    this.process = null;
    this.ready = false;
  }

  checkHealth() {
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: "/health",
          method: "GET",
          timeout: HEALTH_CHECK_TIMEOUT_MS,
        },
        (res) => {
          resolve(res.statusCode === 200);
          res.resume();
        }
      );

      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  startHealthCheck() {
    this.stopHealthCheck();
    this.healthCheckFailures = 0;
    this.healthCheckInterval = setInterval(async () => {
      try {
        if (!this.process) {
          this.stopHealthCheck();
          return;
        }
        if (await this.checkHealth()) {
          this.healthCheckFailures = 0;
        } else {
          this.healthCheckFailures++;
          if (this.healthCheckFailures >= HEALTH_CHECK_FAILURE_THRESHOLD) {
            debugLogger.warn("llama-server health check failed", {
              consecutiveFailures: this.healthCheckFailures,
            });
            this.ready = false;
          }
        }
      } catch (err) {
        debugLogger.error("Health check error", { error: err.message });
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  // The "Keep model loaded" setting. Every window resends it on load and when
  // its local-model or policy inputs change, so only a change may touch the timer.
  setKeepResident(keepResident) {
    if (this.keepResident === keepResident) return;
    this.keepResident = keepResident;
    if (keepResident) this.clearIdleTimer();
    // A start in progress arms the timer itself once the server is ready.
    else if (this.process && !this.startupPromise) this.resetIdleTimer();
  }

  resetIdleTimer() {
    this.clearIdleTimer();
    // Explicit stop, model/context changes and app shutdown still release it.
    if (this.keepResident) return;
    const timer = setTimeout(async () => {
      // Streaming chat talks to the port directly, so only the server knows
      // whether an answer that outlived the timeout is still being generated.
      const busy = await this._slotsBusy();
      if (this.idleTimer !== timer) return;
      if (busy) {
        this.resetIdleTimer();
        return;
      }
      debugLogger.info("llama-server idle timeout reached, stopping to free VRAM", {
        timeoutMs: IDLE_TIMEOUT_MS,
        model: this.modelPath ? path.basename(this.modelPath) : null,
      });
      this.stop();
    }, IDLE_TIMEOUT_MS);
    // Freeing an idle server is housekeeping; it must never hold the process open.
    timer.unref();
    this.idleTimer = timer;
  }

  async _slotsBusy() {
    const slots = await this._requestJson("/slots");
    return Array.isArray(slots) && slots.some((slot) => slot.is_processing);
  }

  /** Waits for active answers; settings-driven stops can be cancelled by reuse. */
  async stopWhenIdle({ cancelOnReuse = true } = {}) {
    const request = {};
    if (cancelOnReuse) this.deferredStop = request;
    await this.startupPromise?.catch(() => {});
    const server = this.process;
    const isCurrent = () =>
      this.process === server && (!cancelOnReuse || this.deferredStop === request);
    while (server && isCurrent()) {
      if (!(await this._slotsBusy())) break;
      if (!isCurrent()) break;
      await new Promise((resolve) => setTimeout(resolve, SLOT_POLL_INTERVAL_MS).unref?.());
    }
    if (!isCurrent()) return false;
    if (cancelOnReuse) this.deferredStop = null;
    await this.stop();
    return true;
  }

  cancelDeferredStop() {
    this.deferredStop = null;
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * Small JSON round-trip against the running server.
   *
   * Resolves null on any failure rather than rejecting: these calls exist to
   * make a decision more precise, so a broken one must degrade to the estimate
   * and never fail the user's request.
   */
  _requestJson(path, body = null, timeoutMs = PREFLIGHT_TIMEOUT_MS, onTimeout = null) {
    return new Promise((resolve) => {
      const payload = body === null ? null : JSON.stringify(body);
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path,
          method: payload === null ? "GET" : "POST",
          headers: payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {},
          timeout: timeoutMs,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            if (res.statusCode !== 200) return resolve(null);
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(null);
            }
          });
        }
      );

      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        resolve(onTimeout);
        req.destroy();
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  /**
   * The context window actually in force, which the GPU startup ladder may
   * reduce below the requested size. Returns null when it cannot be read.
   */
  async usableContextSize() {
    if (!this.ready || !this.process) return null;
    const props = await this._requestJson("/props");
    const contextSize = props?.default_generation_settings?.n_ctx;
    return Number.isFinite(contextSize) && contextSize > 0 ? contextSize : null;
  }

  /**
   * Exact token count for the prompt as the server will actually see it, chat
   * template included. Roughly 15 ms for an 85 KB prompt, which is cheap
   * enough to make the difference between a right-sized window and a 400.
   */
  async countPromptTokens(messages, options = {}) {
    if (!this.ready || !this.process) return null;

    const payload = { messages };
    // Must mirror inference() exactly, or we would price a different prompt
    // than the one we go on to send.
    if (options.disableThinking !== false) {
      payload.chat_template_kwargs = { enable_thinking: false };
    }

    assertLocalModelOperation(this);
    const templated = await this._requestJson("/apply-template", payload);
    if (typeof templated?.prompt !== "string") return null;

    assertLocalModelOperation(this);
    const tokenized = await this._requestJson("/tokenize", { content: templated.prompt });
    return Array.isArray(tokenized?.tokens) ? tokenized.tokens.length : null;
  }

  async inference(messages, options = {}) {
    // Nothing to authorize once stopped, which clears the model: that's the
    // ordinary not-running error, not a refusal of a model nobody named.
    if (!this.ready || !this.process) return this._policyAllowedInference(messages, options);
    return runLocalModelOperation(
      this,
      "llm",
      this.localModelIdForPath?.(this.modelPath),
      () => this._policyAllowedInference(messages, options),
      { onAbort: () => this.cancelInference() }
    );
  }

  async _policyAllowedInference(messages, options = {}) {
    if (!this.ready || !this.process) {
      throw new Error("llama-server is not running");
    }
    // cancelInference() only reaches a request already sent; one cancelled on
    // the way here is never sent.
    if (options.signal?.aborted) throw cancelledError();

    this.clearIdleTimer();

    const requestBody = {
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.max_tokens ?? 512,
      stream: false,
    };
    if (options.responseFormat) requestBody.response_format = options.responseFormat;

    // Without this, Qwen chat templates think into `reasoning_content` first
    // and can spend the whole budget there. Non-Qwen templates ignore it.
    const suppressThinking = options.disableThinking !== false;
    if (suppressThinking) {
      requestBody.chat_template_kwargs = { enable_thinking: false };
    }

    const body = JSON.stringify(requestBody);

    let req;
    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: 300000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            debugLogger.debug("llama-server inference completed", {
              statusCode: res.statusCode,
              elapsed: Date.now() - startTime,
            });

            if (res.statusCode !== 200) {
              reject(buildResponseError(res.statusCode, data));
              return;
            }

            try {
              const response = JSON.parse(data);
              const choice = response.choices?.[0];
              const message = choice?.message;
              const truncated = ["length", "max_tokens"].includes(choice?.finish_reason);
              // A cut-off reply with no content spent its whole budget reasoning
              // (#2187): there is no answer to return, whichever field the
              // reasoning sits in. Lenient callers still accept a partial answer.
              if (truncated && (options.requireCompleteOutput || !message?.content?.trim())) {
                // The renderer maps the code to the cleanup toast's wording (#2091).
                const error = new Error("Model output was truncated");
                error.code = "OUTPUT_TRUNCATED";
                reject(error);
                return;
              }
              if (truncated) {
                debugLogger.warn("llama-server reply was cut off at max_tokens", {
                  maxTokens: requestBody.max_tokens,
                });
              }
              if (options.responseFormat) {
                if (choice?.finish_reason !== "stop") {
                  reject(
                    Object.assign(new Error("Model completion could not be verified"), {
                      code: "OUTPUT_COMPLETION_UNVERIFIED",
                    })
                  );
                  return;
                }
                resolve(typeof message?.content === "string" ? message.content : "");
                return;
              }
              // Some builds still route a suppressed-thinking answer into
              // `reasoning_content` (#809). With thinking on, that field is the
              // reasoning itself, which must never stand in for the answer.
              const text =
                message?.content || (suppressThinking && message?.reasoning_content) || "";
              resolve(text.trim());
            } catch (e) {
              reject(new Error(`Failed to parse llama-server response: ${e.message}`));
            }
          });
        }
      );

      req.on("error", (error) => {
        reject(new Error(`llama-server request failed: ${error.message}`));
      });
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("llama-server request timed out"));
      });

      this.activeRequest = req;
      req.write(body);
      req.end();
    }).finally(() => {
      if (this.activeRequest === req) this.activeRequest = null;
      this.resetIdleTimer();
    });
  }

  // Closing the connection is what makes llama-server stop generating.
  cancelInference() {
    this.activeRequest?.destroy(new Error("cancelled"));
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this._stop();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  async _stop() {
    this.ready = false;
    this.cancelDeferredStop();
    this.clearIdleTimer();
    this.stopHealthCheck();

    if (!this.process) {
      this.ready = false;
      this.contextSize = null;
      return;
    }

    debugLogger.debug("Stopping llama-server");

    try {
      killProcess(this.process, "SIGTERM");

      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) {
            killProcess(this.process, "SIGKILL");
          }
          resolve();
        }, 5000);

        if (this.process) {
          this.process.once("close", () => {
            clearTimeout(timeout);
            resolve();
          });
        } else {
          clearTimeout(timeout);
          resolve();
        }
      });
    } catch (error) {
      debugLogger.error("Error stopping llama-server", { error: error.message });
    }

    this.process = null;
    this.ready = false;
    this.port = null;
    this.modelPath = null;
    this.draftModelPath = null;
    this.activeDraftModelPath = null;
    this.activeBackend = null;
    this.contextSize = null;
    this.activeContextSize = null;
  }

  getStatus() {
    return {
      available: this.isAvailable(),
      running: this.ready && this.process !== null,
      port: this.port,
      modelPath: this.modelPath,
      modelName: this.modelPath ? path.basename(this.modelPath, ".gguf") : null,
      backend: this.activeBackend,
      gpuAccelerated: this.activeBackend === "vulkan" || this.activeBackend === "metal",
    };
  }

  resetGpuDetection() {
    this.activeBackend = null;
    this.cachedServerBinaryPaths = null;
  }
}

module.exports = LlamaServerManager;
