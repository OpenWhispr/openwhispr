const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const fsPromises = fs.promises;
const path = require("path");
const http = require("http");
const debugLogger = require("./debugLogger");
const { killProcess } = require("../utils/process");
const { getCacheRoot } = require("./modelDirUtils");
const {
  getQualcommCapability,
  getQualcommNpuCapability,
} = require("./qualcommCapability");

// GenieX is Qualcomm's on-device LLM runtime for Windows on Snapdragon: a CLI
// whose `serve` command exposes an OpenAI-compatible HTTP API backed by the
// Hexagon NPU (llama.cpp runtime with Q4_0 GGUFs, or QAIRT bundles). This
// manager mirrors the subset of LlamaServerManager's interface that
// modelManagerBridge uses, so a model flagged `runtime: "geniex"` in the
// registry runs on the NPU through the same runInference path.
//
// Docs: https://geniex.aihub.qualcomm.com/en/run/cli/local-server.md
const GENIEX_PORT = 18181;
const GENIEX_INSTALLER_URL =
  "https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-geniex/geniex-cli.exe";
const GENIEX_DOCS_URL = "https://geniex.aihub.qualcomm.com/en/run/cli/install.md";
const GENIEX_MODEL_PREFIX = "openwhispr";
const STARTUP_TIMEOUT_MS = 180000;
const STARTUP_POLL_INTERVAL_MS = 500;
const PULL_TIMEOUT_MS = 300000;
const REQUEST_TIMEOUT_MS = 300000;

/**
 * The GenieX CLI is distributed as a Windows ARM64 installer, so it needs the
 * same Snapdragon gate as NPU transcription (see qualcommCapability.js).
 */
function getGeniexCapability(options) {
  return getQualcommCapability(options);
}

/** The cache name GenieX knows a pulled model by, derived from its GGUF file. */
function geniexRefForFile(fileName) {
  return `${GENIEX_MODEL_PREFIX}/${path.basename(fileName, ".gguf")}`;
}

/** argv for `geniex serve`, kept pure for tests. */
function buildServeArgs({ contextSize }) {
  // v0.7.0's serve has no --think flag: thinking is suppressed per request
  // via the `enable_think: false` body field (see inference()).
  const args = ["--skip-update", "serve", "--compute", "npu"];
  if (Number.isFinite(contextSize) && contextSize > 0) args.push("--nctx", String(contextSize));
  return args;
}

/** argv for registering a staged GGUF directory into the GenieX cache. */
function buildPullArgs(modelRef, localPath) {
  return ["pull", modelRef, "--local-path", localPath, "--model-type", "llm"];
}

let cachedBinaryPath;
let cachedBinaryMissing = false;

/**
 * Where the `geniex` CLI lives: an explicit override first, then PATH.
 * Cached because isAvailable() runs on synchronous hot paths; a miss may be
 * transient (the user installs while the app is open), so allowCacheRefresh
 * callers re-probe.
 */
function resolveGeniexBinary({ refresh = false } = {}) {
  if (!refresh && cachedBinaryPath) return cachedBinaryPath;
  if (!refresh && cachedBinaryMissing) return null;

  cachedBinaryPath = null;
  cachedBinaryMissing = false;

  const override = process.env.OPENWHISPR_GENIEX_PATH;
  if (override) {
    try {
      if (fs.existsSync(override)) cachedBinaryPath = override;
    } catch {}
  }

  if (!cachedBinaryPath) {
    try {
      const finder = process.platform === "win32" ? "where.exe" : "which";
      const found = execFileSync(finder, ["geniex"], { encoding: "utf8", timeout: 5000 })
        .split(/\r?\n/)
        .find((line) => line.trim().length > 0);
      if (found) cachedBinaryPath = found.trim();
    } catch {
      // Not on PATH
    }
  }

  if (!cachedBinaryPath) cachedBinaryMissing = true;
  return cachedBinaryPath;
}

/**
 * Full NPU-readiness picture — the same shared gate the transcription side
 * uses (Snapdragon platform AND a Qualcomm processor), plus whether the CLI
 * is installed. Async because the CPU answer comes from a cached WMI query.
 */
async function getGeniexStatus() {
  const capability = await getQualcommNpuCapability();
  const binaryPath = capability.supported ? resolveGeniexBinary({ refresh: true }) : null;
  return {
    supported: capability.supported,
    platformSupported: capability.reason !== "cpu",
    cpuQualcomm: capability.reason !== "platform",
    cpuName: capability.cpuName,
    code: capability.code,
    message: capability.message,
    installed: Boolean(binaryPath),
    binaryPath,
    installerUrl: GENIEX_INSTALLER_URL,
    docsUrl: GENIEX_DOCS_URL,
  };
}

class GeniexServerManager {
  constructor({ port = GENIEX_PORT } = {}) {
    this.port = port;
    this.process = null;
    this.ready = false;
    this.modelPath = null;
    this.modelRef = null;
    this.contextSize = null;
    this.startupPromise = null;
    this.activeAbort = null;
    this.pulledRefs = new Set();
  }

  isAvailable() {
    if (!getGeniexCapability().supported) return false;
    return Boolean(resolveGeniexBinary({ refresh: cachedBinaryMissing }));
  }

  async start(modelPath, options = {}) {
    if (this.startupPromise) return this.startupPromise;

    const contextSize = options.contextSize || null;
    const modelRef = geniexRefForFile(path.basename(modelPath));
    const restartNeeded =
      !this.ready ||
      this.modelPath !== modelPath ||
      (contextSize && this.contextSize !== contextSize);

    if (!restartNeeded) return;

    this.startupPromise = this._start(modelPath, modelRef, contextSize).finally(() => {
      this.startupPromise = null;
    });
    return this.startupPromise;
  }

  async _start(modelPath, modelRef, contextSize) {
    const binaryPath = resolveGeniexBinary();
    if (!binaryPath) {
      throw new Error(
        "GenieX CLI not found. Install it from Qualcomm to run language models on the NPU."
      );
    }

    await this.stop();

    try {
      await this._ensurePulled(binaryPath, modelRef, modelPath);
    } catch (error) {
      throw new Error(`GenieX could not register the model: ${error.message}`);
    }

    const args = buildServeArgs({ contextSize });
    debugLogger.info("Starting GenieX server", { modelRef, contextSize, args });

    let child;
    try {
      child = spawn(binaryPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // v0.7.0's serve has no --think flag; the env default turns thinking
        // off for requests that omit enable_think (per-request wins where the
        // runtime supports it), so streamed chat does not burn the reply
        // budget inside reasoning_content.
        env: { ...process.env, GENIEX_THINK: "false" },
      });
    } catch (error) {
      throw new Error(`Failed to launch GenieX: ${error.message}`);
    }

    child.stdout?.on("data", (data) => {
      debugLogger.debug("geniex stdout", { text: String(data).trim() });
    });
    child.stderr?.on("data", (data) => {
      debugLogger.info("geniex stderr", { text: String(data).trim() });
    });
    child.on("error", (error) => {
      debugLogger.error("GenieX process error", { error: error.message });
      this.ready = false;
    });
    child.on("close", (code) => {
      if (this.process === child) {
        debugLogger.info("GenieX server exited", { code });
        this.process = null;
        this.ready = false;
      }
    });

    this.process = child;
    this.modelPath = modelPath;
    this.modelRef = modelRef;

    try {
      await this._waitForServer();
    } catch (error) {
      await this.stop();
      throw error;
    }

    this.ready = true;
    this.contextSize = contextSize;
    debugLogger.info("GenieX server ready", { modelRef, port: this.port });
  }

  /**
   * `geniex serve` only serves cached models, and `pull --local-path` imports
   * from a DIRECTORY (v0.7.0 rejects a bare .gguf file), so the downloaded
   * file is staged into its own directory first — hardlinked when the models
   * dir is on the same volume, copied otherwise. Both steps are skipped when
   * `geniex list` already shows the ref, so a model load costs no repeated
   * multi-GB copies.
   */
  async _ensurePulled(binaryPath, modelRef, modelPath) {
    if (this.pulledRefs.has(modelRef)) return;

    const listed = await this._runCommand(
      binaryPath,
      ["--skip-update", "list"],
      PULL_TIMEOUT_MS
    ).catch(() => null);
    if (listed && listed.split(/\r?\n/).some((line) => line.includes(modelRef))) {
      this.pulledRefs.add(modelRef);
      return;
    }

    const stageDir = path.join(getCacheRoot(), "geniex-import", path.basename(modelPath, ".gguf"));
    await fsPromises.mkdir(stageDir, { recursive: true });
    const stagedPath = path.join(stageDir, path.basename(modelPath));
    await fsPromises.unlink(stagedPath).catch(() => {});
    try {
      await fsPromises.link(modelPath, stagedPath);
      debugLogger.info("Hardlinked model into the GenieX import directory", { stagedPath });
    } catch {
      // Cross-volume (or link unsupported): a real copy still works.
      await fsPromises.copyFile(modelPath, stagedPath);
      debugLogger.info("Copied model into the GenieX import directory", { stagedPath });
    }

    debugLogger.info("Registering model with GenieX", { modelRef, stageDir });
    try {
      await this._runCommand(
        binaryPath,
        ["--skip-update", ...buildPullArgs(modelRef, stageDir)],
        PULL_TIMEOUT_MS,
        "GenieX model registration failed"
      );
    } catch (error) {
      // The pull's own copy may have finished despite a nonzero exit; a listed
      // ref is the ground truth, so only an absent one is a real failure.
      const after = await this._runCommand(
        binaryPath,
        ["--skip-update", "list"],
        PULL_TIMEOUT_MS
      ).catch(() => "");
      if (!(after || "").split(/\r?\n/).some((line) => line.includes(modelRef))) {
        throw error;
      }
    }
    this.pulledRefs.add(modelRef);
  }

  _runCommand(binaryPath, args, timeoutMs, failureLabel = "GenieX command failed") {
    return new Promise((resolve, reject) => {
      const child = spawn(binaryPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let output = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killProcess(child, "SIGKILL");
        reject(new Error(`${failureLabel}: timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout?.on("data", (data) => {
        output += String(data);
      });
      child.stderr?.on("data", (data) => {
        output += String(data);
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`${failureLabel}: ${error.message}`));
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve(output);
        else reject(new Error(`${failureLabel} (exit ${code}): ${output.trim().slice(-2000)}`));
      });
    });
  }

  _waitForServer() {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const poll = async () => {
        if (Date.now() > deadline) {
          reject(new Error("GenieX server did not become ready in time"));
          return;
        }
        if (!this.process) {
          reject(new Error("GenieX server exited during startup"));
          return;
        }
        const models = await this._requestJson("/v1/models", null, 2000);
        // Local pulls register verbatim, but HF-cached models carry a
        // ":PRECISION" suffix — match the ref by prefix so a future version
        // that suffixes local pulls still resolves.
        const served = models?.data?.find(
          (m) => m.id === this.modelRef || m.id.startsWith(`${this.modelRef}:`)
        );
        if (served) {
          // Request the id the server actually knows, not the ref we asked for.
          this.modelRef = served.id;
          resolve();
          return;
        }
        setTimeout(poll, STARTUP_POLL_INTERVAL_MS);
      };
      poll();
    });
  }

  /** Resolve null on any failure — these calls only sharpen a decision. */
  _requestJson(requestPath, body = null, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve) => {
      const payload = body === null ? null : JSON.stringify(body);
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: requestPath,
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
        req.destroy();
        resolve(null);
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  async usableContextSize() {
    if (!this.ready || !this.process) return null;
    return this.contextSize;
  }

  // GenieX documents no tokenize endpoint, so the preflight falls back to the
  // estimate — the same degradation an unreachable llama-server gets.
  async countPromptTokens() {
    return null;
  }

  async inference(messages, options = {}) {
    if (!this.ready || !this.process) {
      throw new Error("GenieX server is not running");
    }

    const requestBody = {
      model: this.modelRef,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.max_tokens ?? 512,
      stream: false,
    };
    if (options.responseFormat) requestBody.response_format = options.responseFormat;
    // GenieX's field for Qwen thinking suppression — the llama.cpp
    // `chat_template_kwargs` dialect is not shared across the two runtimes.
    if (options.disableThinking !== false) requestBody.enable_think = false;

    const body = JSON.stringify(requestBody);
    const controller = new AbortController();
    this.activeAbort = controller;

    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });

      const data = await response.text();
      if (!response.ok) {
        throw this._buildResponseError(response.status, data);
      }

      const parsed = JSON.parse(data);
      const choice = parsed.choices?.[0];
      const message = choice?.message;
      const truncated = ["length", "max_tokens"].includes(choice?.finish_reason);
      if (truncated && (options.requireCompleteOutput || !message?.content?.trim())) {
        throw Object.assign(new Error("Model output was truncated"), { code: "OUTPUT_TRUNCATED" });
      }
      const text = message?.content || message?.reasoning_content || "";
      return text.trim();
    } finally {
      if (this.activeAbort === controller) this.activeAbort = null;
    }
  }

  _buildResponseError(statusCode, body) {
    let detail = body;
    try {
      detail = JSON.parse(body)?.error?.message || body;
    } catch {}
    const error = new Error(`GenieX server returned status ${statusCode}: ${detail}`);
    if (statusCode === 400) {
      error.code = "CONTEXT_TOO_LARGE";
      error.neededTokens = null;
      error.maxContextTokens = this.contextSize;
    }
    return error;
  }

  cancelInference() {
    this.activeAbort?.abort(new Error("cancelled"));
    this.activeAbort = null;
  }

  async stop() {
    if (!this.process) {
      this.ready = false;
      this.contextSize = null;
      return;
    }

    debugLogger.debug("Stopping GenieX server");
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
      debugLogger.error("Error stopping GenieX server", { error: error.message });
    }

    this.process = null;
    this.ready = false;
    this.modelPath = null;
    this.modelRef = null;
    this.contextSize = null;
  }

  /** Best-effort cache cleanup alongside the app's own copy of the GGUF. */
  async removeModel(fileName) {
    const binaryPath = resolveGeniexBinary();
    if (!binaryPath) return;
    try {
      // -y: the confirmation prompt would hang a stdio-ignored child.
      await this._runCommand(
        binaryPath,
        ["--skip-update", "remove", geniexRefForFile(fileName), "--yes"],
        60000
      );
    } catch (error) {
      debugLogger.warn("GenieX cache cleanup failed", { error: error.message });
    }
  }

  getStatus() {
    return {
      available: this.isAvailable(),
      running: this.ready && this.process !== null,
      port: this.port,
      modelPath: this.modelPath,
      modelName: this.modelPath ? path.basename(this.modelPath, ".gguf") : null,
      backend: "npu",
      gpuAccelerated: true,
      runtime: "geniex",
    };
  }
}

module.exports = {
  GENIEX_PORT,
  GENIEX_INSTALLER_URL,
  GENIEX_DOCS_URL,
  GENIEX_MODEL_PREFIX,
  GeniexServerManager,
  buildPullArgs,
  buildServeArgs,
  geniexRefForFile,
  getGeniexCapability,
  getGeniexStatus,
  resolveGeniexBinary,
};
