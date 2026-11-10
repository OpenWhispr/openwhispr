const {
  runLocalModelOperation,
  assertLocalModelOperation,
  localModelOperationSignal,
  isLocalModelPolicyRefusal,
} = require("./localModelPolicyGate");
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const debugLogger = require("./debugLogger");
const {
  findAvailablePort,
  resolveBinaryPath,
  gracefulStopProcess,
  getAvailableParallelism,
} = require("../utils/serverUtils");
const { getSafeTempDir } = require("./safeTempDir");
const { createAbortError } = require("./abortError");
const sidecarPidFile = require("./sidecarPidFile");
const { parseOfflineMessage, createOnlineAccumulator } = require("./parakeetWsResult");
const { getModelType, getSherpaModelType } = require("./parakeetModelInfo");
const { pcm16ToFloat32 } = require("../utils/audioUtils");
const {
  computeTranscriptionTimeoutMs,
  TRANSCRIPTION_TIMEOUT_FLOOR_MS,
} = require("./transcriptionTimeout");

const PORT_RANGE_START = 6006;
const PORT_RANGE_END = 6029;
const STARTUP_TIMEOUT_MS = 60000;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const FLOAT32_BYTES_PER_SAMPLE = 4;
const ONLINE_CHUNK_BYTES = 8000 * FLOAT32_BYTES_PER_SAMPLE;
const FLOAT32_BYTES_PER_SECOND = 16000 * FLOAT32_BYTES_PER_SAMPLE;
// Streaming decodes as the audio drains, so its hard cap is tighter than the offline budget.
const ONLINE_TIMEOUT_PER_AUDIO_SECOND_MS = 2000;
// After "Done" is sent, give up only after this long without any result message.
const ONLINE_FINISH_IDLE_TIMEOUT_MS = 10000;
// Must cover the model's 560ms chunk so the flush decodes the final words.
const ONLINE_END_TAIL_PADDING_S = 0.6;
const AVAILABLE_CPUS = getAvailableParallelism();
// ONNX intra-op threads for one decode; the cap of four dates from #1131.
const INTRA_OP_THREADS = Math.max(1, Math.min(4, Math.floor(AVAILABLE_CPUS * 0.75)));
// sherpa-onnx's offline server decodes each connection on its own work thread.
const OFFLINE_WORK_THREADS = 3;
// How many segments the manager may hand the offline server at once: one per
// work thread, but never so many that the intra-op pools oversubscribe the cores.
const OFFLINE_DECODE_CONCURRENCY = Math.max(
  1,
  Math.min(OFFLINE_WORK_THREADS, Math.floor(AVAILABLE_CPUS / INTRA_OP_THREADS))
);

// Windows ignores POSIX file modes. Protect both the directory and the file
// before writing any words, even when the native-compatible temp root is shared.
const WINDOWS_HOTWORDS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$file = $env:OW_HOTWORDS_FILE
$dir = [System.IO.DirectoryInfo]::new([System.IO.Path]::GetDirectoryName($file))
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$user = $identity.User
if ($dir.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { exit 1 }
$owner = $dir.GetAccessControl().GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if ($owner -ne $user.Value) {
  # An elevated token can create directories owned by the built-in Administrators group.
  $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
  if ($owner -ne 'S-1-5-32-544' -or
      !$principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 1 }
}
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($user, 'FullControl', 'Allow')
$dirAcl = [System.Security.AccessControl.DirectorySecurity]::new()
$dirAcl.SetAccessRuleProtection($true, $false)
$dirAcl.AddAccessRule($rule)
$dir.SetAccessControl($dirAcl)
$fileAcl = [System.Security.AccessControl.FileSecurity]::new()
$fileAcl.SetAccessRuleProtection($true, $false)
$fileAcl.AddAccessRule($rule)
$stream = [System.IO.FileStream]::new($file, 'CreateNew', 'Write', 'None', 4096, 'None', $fileAcl)
try { [Console]::OpenStandardInput().CopyTo($stream) } finally { $stream.Dispose() }
`;

function writeWindowsHotwordsFile(file, content) {
  if (!/^[\x21-\x7E]+$/.test(file)) {
    throw new Error("No native-compatible path for the private hotwords file");
  }
  const powershell = path.win32.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  return new Promise((resolve, reject) => {
    const child = execFile(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(WINDOWS_HOTWORDS_SCRIPT, "utf16le").toString("base64"),
      ],
      { windowsHide: true, timeout: 10000, env: { ...process.env, OW_HOTWORDS_FILE: file } },
      (error) =>
        error ? reject(new Error("Could not create private Windows hotwords file")) : resolve()
    );
    // The raw UTF-8 bytes stay off the command line and bypass the console encoding.
    child.stdin.on("error", () => {}); // Early script failure is reported by execFile.
    child.stdin.end(content, "utf8");
  });
}

class ParakeetWsServer {
  constructor() {
    this.process = null;
    this.port = null;
    this.ready = false;
    this.modelName = null;
    this.modelDir = null;
    this.modelRuntime = "offline";
    // Only set for models started for a single language (Cohere Transcribe);
    // part of the server identity, so a language change restarts the server.
    this.language = null;
    // The dictionary hotwords the server was asked for (see sherpaHotwords),
    // also part of the identity.
    this.hotwordsKey = null;
    this.startupPromise = null;
    this.starting = null;
    this.stoppingPromise = null;
    this.stopController = new AbortController();
    this.activeTranscriptions = new Set();
    this.activeDecodes = 0;
    this.healthCheckInterval = null;
    this.cachedBinaryPaths = {};
  }

  getWsBinaryPath(runtime = "offline") {
    if (this.cachedBinaryPaths[runtime]) return this.cachedBinaryPaths[runtime];

    const platformArch = `${process.platform}-${process.arch}`;
    const prefix = runtime === "online" ? "sherpa-onnx-online-ws" : "sherpa-onnx-ws";
    const binaryName =
      process.platform === "win32" ? `${prefix}-${platformArch}.exe` : `${prefix}-${platformArch}`;

    const resolved = resolveBinaryPath(binaryName);
    if (resolved) this.cachedBinaryPaths[runtime] = resolved;
    return resolved;
  }

  isAvailable(runtime = "offline") {
    return this.getWsBinaryPath(runtime) !== null;
  }

  hasAnyWsBinary() {
    return this.isAvailable("offline") || this.isAvailable("online");
  }

  get stopSignal() {
    return this.stopController.signal;
  }

  reserveTranscription() {
    const release = () => this.activeTranscriptions.delete(release);
    this.activeTranscriptions.add(release);
    return release;
  }

  // hotwords: { score, words } from sherpaHotwords, or null to decode without the dictionary.
  async start(
    modelName,
    modelDir,
    runtime = "offline",
    language = null,
    hotwords = null,
    { transcription } = {}
  ) {
    const stopSignal = this.stopSignal;
    return runLocalModelOperation(
      this,
      "transcription",
      this.localModelIdForPath ? this.localModelIdForPath(modelDir, modelName) : modelName,
      () =>
        this._policyAllowedStart(modelName, modelDir, runtime, language, hotwords, {
          stopSignal,
          transcription,
        }),
      { onAbort: () => !stopSignal.aborted && this.stop() }
    );
  }

  async _policyAllowedStart(
    modelName,
    modelDir,
    runtime,
    language,
    hotwords,
    { stopSignal, transcription }
  ) {
    stopSignal.throwIfAborted();
    const hotwordsKey = hotwords ? JSON.stringify(hotwords) : null;
    // Serialize with any in-flight startup; join it only when it's for the same server.
    while (this.startupPromise || this.stoppingPromise) {
      if (
        this.starting?.stopSignal === stopSignal &&
        this.starting.modelName === modelName &&
        this.starting.modelDir === modelDir &&
        this.starting.runtime === runtime &&
        this.starting.language === language &&
        this.starting.hotwordsKey === hotwordsKey
      ) {
        await this.startupPromise;
        stopSignal.throwIfAborted();
        return;
      }
      await (this.startupPromise ?? this.stoppingPromise).catch(() => {});
      stopSignal.throwIfAborted();
    }
    if (
      this.ready &&
      this.modelName === modelName &&
      this.modelDir === modelDir &&
      this.modelRuntime === runtime &&
      this.language === language
    ) {
      if (this.hotwordsKey === hotwordsKey) return;
      // A transcription may still be converting audio or awaiting startup.
      // A sole request can reload before it uses the server.
      const ownReservation = this.activeTranscriptions.has(transcription) ? 1 : 0;
      if (this.activeDecodes > 0 || this.activeTranscriptions.size > ownReservation) return false;
    }

    this.starting = { modelName, modelDir, runtime, language, hotwordsKey, stopSignal };
    // Assigned before any await so concurrent callers can never double-spawn.
    this.startupPromise = (async () => {
      try {
        if (this.process) await this._stopProcess();
        stopSignal.throwIfAborted();
        try {
          await this._doStart(modelName, modelDir, runtime, language, hotwords, stopSignal);
        } catch (error) {
          stopSignal.throwIfAborted();
          if (!hotwords || isLocalModelPolicyRefusal(error)) throw error;
          // A dictionary sherpa cannot read must not cost local transcription.
          debugLogger.warn("parakeet-ws failed to start with hotwords, starting without them", {
            error: error.message,
          });
          await this._stopProcess();
          stopSignal.throwIfAborted();
          await this._doStart(modelName, modelDir, runtime, language, null, stopSignal);
        }
        stopSignal.throwIfAborted();
        // The requested words, even after the fallback, so they are not retried every decode.
        this.hotwordsKey = hotwordsKey;
      } finally {
        this.startupPromise = null;
        this.starting = null;
      }
    })();
    return this.startupPromise;
  }

  async _doStart(modelName, modelDir, runtime, language, hotwords, stopSignal) {
    const wsBinary = this.getWsBinaryPath(runtime);
    if (!wsBinary) throw new Error(`sherpa-onnx ${runtime} WS server binary not found`);
    if (!fs.existsSync(modelDir)) throw new Error(`Model directory not found: ${modelDir}`);

    const port = await findAvailablePort(PORT_RANGE_START, PORT_RANGE_END);
    stopSignal.throwIfAborted();
    this.port = port;
    this.modelName = modelName;
    this.modelDir = modelDir;
    this.modelRuntime = runtime;
    this.language = language;

    const modelArgs =
      getModelType(modelName) === "cohere-transcribe"
        ? [
            `--cohere-transcribe-encoder=${path.join(modelDir, "encoder.int8.onnx")}`,
            `--cohere-transcribe-decoder=${path.join(modelDir, "decoder.int8.onnx")}`,
            `--cohere-transcribe-language=${language}`,
          ]
        : [
            `--encoder=${path.join(modelDir, "encoder.int8.onnx")}`,
            `--decoder=${path.join(modelDir, "decoder.int8.onnx")}`,
            `--joiner=${path.join(modelDir, "joiner.int8.onnx")}`,
          ];
    const sherpaModelType = getSherpaModelType(modelName);
    // sherpa encodes hotwords with the model's sentencepiece vocabulary.
    const bpeVocab = path.join(modelDir, "bpe.vocab");
    const useHotwords = Boolean(hotwords) && fs.existsSync(bpeVocab);
    if (hotwords && !useHotwords) {
      debugLogger.warn("parakeet-ws model has no bpe.vocab; starting without hotwords", {
        modelName,
      });
    }
    const args = [
      `--tokens=${path.join(modelDir, "tokens.txt")}`,
      ...modelArgs,
      ...(runtime === "offline" && sherpaModelType ? [`--model-type=${sherpaModelType}`] : []),
      `--port=${this.port}`,
      ...(runtime === "online"
        ? [
            // --num-threads is ONNX intra-op parallelism for the single dictation
            // stream; --num-work-threads only spreads across concurrent streams.
            `--num-threads=${INTRA_OP_THREADS}`,
            "--num-work-threads=2",
            // Default 10ms decode-loop tick adds idle time to faster-than-realtime decode.
            "--loop-interval-ms=2",
            `--end-tail-padding=${ONLINE_END_TAIL_PADDING_S}`,
            // Nonzero --warm-up aborts startup for non-zipformer2 models; _warmUp()
            // covers it app-side.
            "--warm-up=0",
          ]
        : [`--num-threads=${INTRA_OP_THREADS}`, `--num-work-threads=${OFFLINE_WORK_THREADS}`]),
    ];

    let hotwordsDir = null;
    try {
      assertLocalModelOperation(this);
      if (useHotwords) {
        hotwordsDir = fs.mkdtempSync(path.join(getSafeTempDir(), "openwhispr-hotwords-"));
        const hotwordsFile = path.join(hotwordsDir, "hotwords.txt");
        const content = hotwords.words.map((word) => `${word}\n`).join("");
        if (process.platform === "win32") {
          await writeWindowsHotwordsFile(hotwordsFile, content);
          stopSignal.throwIfAborted();
          assertLocalModelOperation(this);
        } else {
          fs.writeFileSync(hotwordsFile, content, { flag: "wx", mode: 0o600 });
        }
        args.push(
          "--decoding-method=modified_beam_search",
          `--hotwords-file=${hotwordsFile}`,
          `--hotwords-score=${hotwords.score}`,
          "--modeling-unit=bpe",
          `--bpe-vocab=${bpeVocab}`
        );
      }

      debugLogger.debug("Starting parakeet WS server", {
        port: this.port,
        modelName,
        runtime,
        args,
        hotwordCount: hotwordsDir ? hotwords.words.length : 0,
      });

      const child = spawn(wsBinary, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        cwd: getSafeTempDir(),
        detached: process.platform !== "win32",
      });
      this.process = child;
      sidecarPidFile.write("parakeet", child.pid);

      let stderrBuffer = "";
      let exitCode = null;
      let readyResolve = null;
      const readyFromStderr = new Promise((resolve) => {
        readyResolve = resolve;
      });

      child.stdout.on("data", (data) => {
        debugLogger.debug("parakeet-ws stdout", { data: data.toString().trim() });
      });

      child.stderr.on("data", (data) => {
        stderrBuffer += data.toString();
        debugLogger.debug("parakeet-ws stderr", { data: data.toString().trim() });
        if (data.toString().includes("Listening on:")) {
          readyResolve(true);
        }
      });

      child.on("error", (error) => {
        debugLogger.error("parakeet-ws process error", { error: error.message });
        if (this.process === child) this.ready = false;
        readyResolve(false);
      });

      child.on("close", (code) => {
        exitCode = code;
        debugLogger.debug("parakeet-ws process exited", { code });
        // A superseded child must not clobber the state of its replacement.
        if (this.process === child) {
          this.ready = false;
          this.process = null;
          this.stopHealthCheck();
          sidecarPidFile.clear("parakeet");
        }
        readyResolve(false);
      });

      await this._waitForReady(
        readyFromStderr,
        () => ({ stderr: stderrBuffer, exitCode }),
        stopSignal
      );
      stopSignal.throwIfAborted();
    } finally {
      // sherpa loads the words once. Remove the directory even if writing or spawning failed.
      if (hotwordsDir) fs.rmSync(hotwordsDir, { recursive: true, force: true, maxRetries: 2 });
    }
    this._startHealthCheck();

    debugLogger.info("parakeet-ws server started successfully", {
      port: this.port,
      model: modelName,
      runtime,
    });

    await this._warmUp(stopSignal);
  }

  async _warmUp(signal) {
    try {
      const sampleRate = 16000;
      const numSamples = sampleRate;
      const silentSamples = Buffer.alloc(numSamples * 4);
      await this.transcribe(silentSamples, sampleRate, { signal });
      debugLogger.debug("parakeet-ws warm-up inference complete");
    } catch (err) {
      debugLogger.warn("parakeet-ws warm-up failed (non-fatal)", {
        error: err.message,
      });
    }
  }

  async _waitForReady(readySignal, getProcessInfo, stopSignal) {
    const startTime = Date.now();
    let timeout;
    let onStop;
    const startupDeadline = new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`parakeet-ws failed to start within ${STARTUP_TIMEOUT_MS}ms`)),
        STARTUP_TIMEOUT_MS
      );
      onStop = () => reject(stopSignal.reason);
      stopSignal.addEventListener("abort", onStop, { once: true });
    });
    const ready = await Promise.race([readySignal, startupDeadline]).finally(() => {
      clearTimeout(timeout);
      stopSignal.removeEventListener("abort", onStop);
    });
    stopSignal.throwIfAborted();

    if (!ready) {
      const info = getProcessInfo ? getProcessInfo() : {};
      const stderr = info.stderr ? info.stderr.trim().slice(0, 200) : "";
      const details = stderr || (info.exitCode !== null ? `exit code: ${info.exitCode}` : "");
      throw new Error(`parakeet-ws process died during startup${details ? `: ${details}` : ""}`);
    }

    this.ready = true;
    debugLogger.debug("parakeet-ws ready", { startupTimeMs: Date.now() - startTime });
  }

  _isProcessAlive() {
    if (!this.process || this.process.killed) return false;
    try {
      process.kill(this.process.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  _startHealthCheck() {
    this.stopHealthCheck();
    this.healthCheckInterval = setInterval(() => {
      if (!this.process) {
        this.stopHealthCheck();
        return;
      }

      if (!this._isProcessAlive()) {
        debugLogger.warn("parakeet-ws health check failed: process not alive");
        this.ready = false;
        this.stopHealthCheck();
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  // The online runtime is a single stream and takes segments in order.
  get maxConcurrentDecodes() {
    return this.modelRuntime === "online" ? 1 : OFFLINE_DECODE_CONCURRENCY;
  }

  // The optional signal cancels pending transcription when its caller stops.
  async transcribe(samplesBuffer, sampleRate, { signal } = {}) {
    // Nothing to authorize once stopped, which clears the model: that's the
    // ordinary not-running error, not a refusal of a model nobody named.
    if (!this.ready || !this.process)
      return this._policyAllowedTranscribe(samplesBuffer, sampleRate, { signal });
    return runLocalModelOperation(
      this,
      "transcription",
      this.modelName,
      () =>
        this._policyAllowedTranscribe(samplesBuffer, sampleRate, {
          signal: localModelOperationSignal(this, signal),
        }),
      { onAbort: () => this.stop() }
    );
  }

  async _policyAllowedTranscribe(samplesBuffer, sampleRate, { signal } = {}) {
    if (!this.ready || !this.process) {
      throw new Error("parakeet-ws server is not running");
    }

    // Counted so a dictionary change waits for the decodes in flight.
    this.activeDecodes++;
    try {
      return this.modelRuntime === "online"
        ? await this._transcribeOnline(samplesBuffer, signal)
        : await this._transcribeOffline(samplesBuffer, sampleRate, signal);
    } finally {
      this.activeDecodes--;
    }
  }

  _transcribeOffline(samplesBuffer, sampleRate, signal) {
    const timeoutMs = computeTranscriptionTimeoutMs(
      samplesBuffer.length / FLOAT32_BYTES_PER_SAMPLE / sampleRate
    );

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError("parakeet-ws transcription cancelled"));
        return;
      }

      const startTime = Date.now();
      let result = "";

      const timeout = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error("parakeet-ws transcription timed out"));
      }, timeoutMs);

      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);

      // Closing the socket drops this request; the server finishes its
      // in-flight decode of the segment on its own (bounded by the 15s cap).
      const onAbort = () => {
        clearTimeout(timeout);
        try {
          ws.close();
        } catch {}
        reject(createAbortError("parakeet-ws transcription cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      ws.on("open", () => {
        // sherpa-onnx offline WS binary protocol:
        // [int32LE sample_rate][int32LE num_audio_bytes][float32 samples...]
        const message = Buffer.alloc(8 + samplesBuffer.length);
        message.writeInt32LE(sampleRate, 0);
        message.writeInt32LE(samplesBuffer.length, 4);
        samplesBuffer.copy(message, 8);

        debugLogger.debug("parakeet-ws sending audio", {
          samplesBytes: samplesBuffer.length,
          sampleRate,
        });

        ws.send(message, (err) => {
          if (err) {
            debugLogger.error("parakeet-ws send error", { error: err.message });
          }
        });
      });

      ws.on("message", (data) => {
        result += data.toString();
        ws.send("Done");
      });

      ws.on("close", (code) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        const elapsed = Date.now() - startTime;

        // The offline server always sends one result message (even for silence),
        // so closing without one means the server died or was stopped mid-request.
        if (!result) {
          reject(new Error("parakeet-ws connection closed before transcription completed"));
          return;
        }

        debugLogger.debug("parakeet-ws transcription completed", {
          elapsed,
          code,
          resultLength: result.length,
          resultPreview: result.slice(0, 200),
        });

        resolve({ text: parseOfflineMessage(result), elapsed });
      });

      ws.on("error", (error) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`parakeet-ws transcription failed: ${error.message}`));
      });
    });
  }

  // samplesBuffer must already be 16kHz float32.
  async _transcribeOnline(samplesBuffer, signal) {
    if (signal?.aborted) throw createAbortError("parakeet-ws transcription cancelled");

    const startTime = Date.now();
    let streamError = null;
    let timedOut = false;

    const stream = this.createOnlineStream({
      onError: (error) => {
        streamError = error;
      },
    });

    debugLogger.debug("parakeet-ws sending streaming audio", {
      samplesBytes: samplesBuffer.length,
    });
    for (let offset = 0; offset < samplesBuffer.length; offset += ONLINE_CHUNK_BYTES) {
      stream.sendFloat32(samplesBuffer.subarray(offset, offset + ONLINE_CHUNK_BYTES));
    }

    // Blasted audio drains faster than real time but not instantly; scale both
    // the hard cap and the quiet-period allowance with the audio length.
    const audioSeconds = samplesBuffer.length / FLOAT32_BYTES_PER_SECOND;
    const timeout = setTimeout(
      () => {
        timedOut = true;
        stream.abort();
      },
      Math.max(TRANSCRIPTION_TIMEOUT_FLOOR_MS, audioSeconds * ONLINE_TIMEOUT_PER_AUDIO_SECOND_MS)
    );
    const onAbort = () => stream.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const idleTimeoutMs = Math.max(ONLINE_FINISH_IDLE_TIMEOUT_MS, audioSeconds * 500);
      const { text, truncated } = await stream.finish({ idleTimeoutMs });
      if (signal?.aborted) throw createAbortError("parakeet-ws transcription cancelled");
      if (timedOut) throw new Error("parakeet-ws transcription timed out");
      if (streamError) {
        throw new Error(`parakeet-ws transcription failed: ${streamError.message}`);
      }

      const elapsed = Date.now() - startTime;
      debugLogger.debug("parakeet-ws streaming transcription completed", {
        elapsed,
        truncated,
        resultLength: text.length,
        resultPreview: text.slice(0, 200),
      });
      return truncated ? { text, elapsed, truncated } : { text, elapsed };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  createOnlineStream({ onUpdate, onError } = {}) {
    if (!this.ready || !this.process) {
      throw new Error("parakeet-ws server is not running");
    }
    if (this.modelRuntime !== "online") {
      throw new Error("createOnlineStream requires an online-runtime model");
    }

    const policyLease = this.localModelPolicy?.authorizeCached("transcription", this.modelName);
    const checkPolicy = () => {
      if (policyLease) this.localModelPolicy.assertCurrent(policyLease);
    };

    const results = createOnlineAccumulator();
    const pendingChunks = [];
    let finishResolve = null;
    let finishPromise = null;
    let idleTimeoutMs = ONLINE_FINISH_IDLE_TIMEOUT_MS;
    let idleTimer = null;
    let closed = false;
    let aborted = false;
    let serverDone = false;
    let truncated = false;
    let lastEmitted = "";

    const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);

    const clearIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const settle = () => {
      if (closed) return;
      closed = true;
      if (policyLease) {
        policyLease.signal.removeEventListener("abort", onPolicyAbort);
        this.localModelPolicy.release(policyLease);
      }
      clearIdleTimer();
      if (finishResolve) finishResolve({ text: results.text(), truncated });
    };

    // Backstop for a server that goes quiet after "Done": while results keep
    // arriving the deadline keeps extending; only true silence is a truncation.
    const armIdleTimer = () => {
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        if (closed) return;
        truncated = true;
        debugLogger.warn("parakeet-ws online finish timed out; result may be truncated");
        try {
          ws.close();
        } catch {}
        settle();
      }, idleTimeoutMs);
      idleTimer.unref?.();
    };

    const onPolicyAbort = () => {
      aborted = true;
      onError?.(policyLease.signal.reason);
      ws.close();
      settle();
    };
    policyLease?.signal.addEventListener("abort", onPolicyAbort, { once: true });

    const sendFloat32 = (float32Samples) => {
      checkPolicy();
      if (closed) return;
      // A chunk after finish() means the renderer flushed late (contract broke) so the
      // tail is lost; when only closed is set, settle already happened and a plain drop is fine.
      if (finishResolve) {
        truncated = true;
        return;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(float32Samples, (err) => {
          if (err) {
            truncated = true;
            debugLogger.error("parakeet-ws online stream send error", { error: err.message });
          }
        });
      } else {
        pendingChunks.push(float32Samples);
      }
    };

    ws.on("open", () => {
      if (policyLease?.signal.aborted) return onPolicyAbort();
      for (const chunk of pendingChunks) {
        ws.send(chunk, (err) => {
          if (err) {
            truncated = true;
            debugLogger.error("parakeet-ws online stream send error", { error: err.message });
          }
        });
      }
      pendingChunks.length = 0;
      if (finishResolve) ws.send("Done");
    });

    ws.on("message", (data) => {
      const message = data.toString();
      if (finishResolve) armIdleTimer();
      if (message === "Done!") {
        serverDone = true;
        ws.close();
        return;
      }
      const text = results.push(message);
      if (!closed && !policyLease?.signal.aborted && text && text !== lastEmitted) {
        lastEmitted = text;
        onUpdate?.(text);
      }
    });

    ws.on("close", () => {
      if (!serverDone && !aborted && !closed) {
        truncated = true;
        onError?.(new Error("connection closed before transcription completed"));
      }
      settle();
    });

    ws.on("error", (error) => {
      debugLogger.warn("parakeet-ws online stream error", { error: error.message });
      if (!serverDone && !aborted) truncated = true;
      onError?.(error);
      settle();
    });

    return {
      sendFloat32,
      sendPcm16: (pcmBuffer) => sendFloat32(pcm16ToFloat32(pcmBuffer)),
      finish: (options = {}) => {
        checkPolicy();
        if (finishPromise) return finishPromise;
        if (options.idleTimeoutMs) idleTimeoutMs = options.idleTimeoutMs;
        finishPromise = new Promise((resolve) => {
          if (closed) {
            resolve({ text: results.text(), truncated });
            return;
          }
          finishResolve = resolve;
          if (ws.readyState === WebSocket.OPEN) ws.send("Done");
          armIdleTimer();
        }).then((result) => {
          checkPolicy();
          return result;
        });
        return finishPromise;
      },
      abort: () => {
        aborted = true;
        try {
          ws.close();
        } catch {}
        settle();
      },
    };
  }

  async stop() {
    const startup = this.startupPromise;
    this.stopController.abort(createAbortError("parakeet-ws server stopped"));
    this.stopController = new AbortController();
    this.activeTranscriptions.clear();
    await this._stopProcess();
    await startup?.catch(() => {});
  }

  _stopProcess() {
    this.stopHealthCheck();
    this.ready = false;
    if (this.stoppingPromise) return this.stoppingPromise;

    const child = this.process;
    this.process = null;
    this.port = null;
    this.modelName = null;
    this.modelDir = null;
    this.modelRuntime = "offline";
    this.language = null;
    this.hotwordsKey = null;
    if (!child) return;

    debugLogger.debug("Stopping parakeet-ws server");
    this.stoppingPromise = gracefulStopProcess(child)
      .catch((error) => {
        debugLogger.error("Error stopping parakeet-ws server", { error: error.message });
      })
      .finally(() => {
        sidecarPidFile.clear("parakeet");
        this.stoppingPromise = null;
      });
    return this.stoppingPromise;
  }

  getStatus() {
    return {
      available: this.hasAnyWsBinary(),
      running: this.ready && this.process !== null,
      starting: this.startupPromise !== null,
      port: this.port,
      modelName: this.modelName || this.starting?.modelName || null,
    };
  }
}

module.exports = ParakeetWsServer;
