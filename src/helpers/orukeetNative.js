// Persistent native ASR worker. GGUF is never passed to sherpa-onnx.
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");
const { getSafeTempDir } = require("./safeTempDir");
const { resolveBinaryPath, gracefulStopProcess } = require("../utils/serverUtils");
const { createAbortError } = require("./abortError");
const pidFile = require("./sidecarPidFile");
const registry = require("../models/modelRegistryData.json");
const { runtimeCandidates, chooseGPU } = require("./orukeetRuntime");
const debugLogger = require("./debugLogger");

class OrukeetNative {
  constructor() {
    this.process = null;
    this.ready = false;
    this.modelName = null;
    this.startupPromise = null;
    this.pending = new Map();
    this.serial = 0;
    this.queue = Promise.resolve();
    this.stopping = null;
    this.generation = 0;
    this.runtime = null;
    this.failedDevices = new Set();
    this.fallbacks = [];
    this.terminations = new WeakMap();
    this.probeCache = new Map();
    this.probeProcess = null;
    this.probeController = null;
  }

  getRuntimeCandidates(gpuInfo = null) {
    const options = {
      platform: process.platform,
      arch: process.arch,
      gpuInfo,
      requested: process.env.OPENWHISPR_ORUKEET_DEVICE || "auto",
    };
    if (process.env.OPENWHISPR_ORUKEET_BINARY) {
      const binary = path.resolve(process.env.OPENWHISPR_ORUKEET_BINARY);
      if (!fs.existsSync(binary)) return [];
      const receiptPath = path.resolve(path.dirname(binary), "../runtime.json");
      const staged = fs.existsSync(receiptPath)
        ? JSON.parse(fs.readFileSync(receiptPath, "utf8"))
        : {};
      const device =
        options.requested !== "auto"
          ? options.requested
          : staged.device ||
            (process.platform === "darwin" && process.arch === "arm64" ? "metal" : "cpu");
      if (!["cpu", "metal", "cuda", "vulkan"].includes(device))
        throw new Error("Invalid Orukeet device");
      return [{ binary, device }];
    }
    const root = resolveBinaryPath(`orukeet-${process.platform}-${process.arch}`);
    return root ? runtimeCandidates(root, options) : [];
  }

  getWsBinaryPath() {
    return this.getRuntimeCandidates()[0]?.binary || null;
  }

  async getGPUInfo() {
    let timer;
    try {
      const { app } = require("electron");
      if (!app?.isReady?.() || !app.getGPUInfo) return null;
      return await Promise.race([
        app.getGPUInfo("basic"),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), 2000);
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  isAvailable() {
    return !!this.getWsBinaryPath();
  }
  getStatus() {
    return {
      running: this.ready,
      starting: !!this.startupPromise,
      model: this.modelName,
      port: null,
      device: this.runtime?.device || null,
      gpuIndex: this.runtime?.gpu_index ?? null,
      gpuName: this.runtime?.gpu_name || null,
      transport: this.runtime?.protocol_version === 2 ? "pipe" : "file",
      fallbacks: this.fallbacks,
    };
  }

  async start(modelName, modelDir) {
    while (this.startupPromise) {
      await this.startupPromise;
    }
    if (this.stopping) await this.stopping;
    if (this.ready && this.modelName === modelName) return;
    const start = this._start(modelName, modelDir);
    this.startupPromise = start;
    try {
      await start;
    } finally {
      if (this.startupPromise === start) this.startupPromise = null;
    }
  }

  async _start(modelName, modelDir) {
    if (this.process) await this.stop();
    const generation = this.generation;
    this.modelDir = modelDir;
    const info = registry.parakeetModels[modelName];
    if (info?.engine !== "nemo-speech") throw new Error("Not an Orukeet native model");
    const model = path.join(modelDir, info.fileName);
    const stat = await fsp.stat(model);
    if (stat.size !== info.expectedSizeBytes)
      throw new Error("Orukeet model size mismatch; reinstall it");
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(model)) hash.update(chunk);
    if (hash.digest("hex") !== info.sha256)
      throw new Error("Orukeet model checksum mismatch; reinstall it");
    if (generation !== this.generation) throw createAbortError("Orukeet startup cancelled");
    const automatic =
      !process.env.OPENWHISPR_ORUKEET_DEVICE || process.env.OPENWHISPR_ORUKEET_DEVICE === "auto";
    const candidates = this.getRuntimeCandidates(await this.getGPUInfo()).filter(
      ({ device }) => !automatic || !this.failedDevices.has(device)
    );
    if (!candidates.length)
      throw new Error("Orukeet native runtime is missing from this app build");
    for (const candidate of candidates) {
      if (generation !== this.generation) throw createAbortError("Orukeet startup cancelled");
      try {
        const prepared = await this.prepareRuntime(candidate);
        if (generation !== this.generation) throw createAbortError("Orukeet startup cancelled");
        await this._startWorker(prepared, modelName, model);
        if (generation !== this.generation) throw createAbortError("Orukeet startup cancelled");
        // Compile the first preview graph during the app's background preload.
        // Unlike zero PCM, this exercises the GPU; its output is never displayed.
        await this.warmup();
        if (generation !== this.generation) throw createAbortError("Orukeet startup cancelled");
        return;
      } catch (error) {
        const child = this.process;
        if (child) await this.terminate(child);
        if (generation !== this.generation) throw createAbortError("Orukeet startup cancelled");
        this.fallbacks.push({ device: candidate.device, error: error.message });
        if (!automatic || candidate.device === "cpu") throw error;
        this.failedDevices.add(candidate.device);
        debugLogger.warn("Orukeet acceleration unavailable; trying the next runtime", {
          device: candidate.device,
          error: error.message,
        });
      }
    }
    throw new Error(
      "No Orukeet runtime could start: " + this.fallbacks.map((item) => item.error).join("; ")
    );
  }

  async warmup() {
    const samples = Buffer.alloc(16000 * 1.5 * 4);
    for (let i = 0; i < samples.length / 4; i++)
      samples.writeFloatLE(0.01 * Math.sin((2 * Math.PI * 220 * i) / 16000), i * 4);
    await this._transcribe(samples, 16000);
  }

  async prepareRuntime(candidate) {
    if (!["cuda", "vulkan"].includes(candidate.device)) return candidate;
    const key = `${candidate.binary}:${process.env.OPENWHISPR_ORUKEET_GPU || "auto"}`;
    if (this.probeCache.has(key)) return this.probeCache.get(key);
    const executable = path.join(
      path.dirname(candidate.binary),
      process.platform === "win32" ? "orukeet-device-info.exe" : "orukeet-device-info"
    );
    // Compatibility with earlier SDK layouts. New app bundles include doctor.
    if (!fs.existsSync(executable)) return candidate;
    this.probeController = new AbortController();
    const controller = this.probeController;
    const report = await new Promise((resolve, reject) => {
      const child = execFile(
        executable,
        ["doctor", "--json"],
        {
          timeout: 15000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          killSignal: "SIGKILL",
          signal: controller.signal,
          env: {
            ...process.env,
            GGML_BACKEND_DL_PATH: path.resolve(
              path.dirname(executable),
              process.platform === "win32" ? "." : "../lib"
            ),
          },
        },
        (error, stdout) => {
          if (error)
            return reject(new Error(`${candidate.device} device probe failed: ${error.message}`));
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error("Invalid Orukeet device report"));
          }
        }
      );
      this.probeProcess = child;
      pidFile.write("orukeet-probe", child.pid);
      child.once("close", () => {
        if (this.probeProcess === child) {
          this.probeProcess = null;
          this.probeController = null;
          pidFile.clear("orukeet-probe");
        }
      });
    });
    const gpu = chooseGPU(report.devices || [], process.env.OPENWHISPR_ORUKEET_GPU);
    const prepared = { ...candidate, gpuIndex: gpu.gpuIndex, gpuName: gpu.description || gpu.name };
    this.probeCache.set(key, prepared);
    return prepared;
  }

  async terminate(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (!this.terminations.has(child)) this.terminations.set(child, gracefulStopProcess(child));
    await this.terminations.get(child);
  }

  async _startWorker({ binary, device, gpuIndex: selectedIndex, gpuName }, modelName, model) {
    const gpuIndex = process.env.OPENWHISPR_ORUKEET_GPU || String(selectedIndex ?? 0);
    if (!/^\d{1,3}$/.test(gpuIndex) || Number(gpuIndex) > 255)
      throw new Error("Invalid Orukeet GPU index");
    const args = ["--model", model, "--device", device];
    if (process.env.OPENWHISPR_ORUKEET_GPU || selectedIndex !== undefined)
      args.push("--gpu", gpuIndex);
    const child = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
      env: { ...process.env, GGML_BACKEND_DL_PATH: path.resolve(path.dirname(binary), "../lib") },
    });
    this.process = child;
    this.modelName = modelName;
    this.runtime = null;
    pidFile.write("orukeet", child.pid);
    let buffer = "";
    let errors = "";
    let failed = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data) => {
      errors = (errors + data).slice(-3000);
    });
    child.stdout.setEncoding("utf8");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        fail(new Error("Orukeet startup timed out"));
        void this.terminate(child);
      }, 300000);
      const fail = (error) => {
        failed = true;
        error.workerFailure = true;
        clearTimeout(timer);
        reject(error);
        if (this.process !== child) return;
        this.ready = false;
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
      };
      child.once("error", fail);
      child.stdin.on("error", fail);
      child.once("close", () => {
        fail(new Error(`Orukeet worker stopped. ${errors}`));
        if (this.process === child) {
          this.process = null;
          this.ready = false;
          pidFile.clear("orukeet");
        }
      });
      child.stdout.on("data", (data) => {
        if (failed) return;
        buffer += data;
        if (buffer.length > 1024 * 1024) {
          fail(new Error("Orukeet worker response exceeds its protocol limit"));
          void this.terminate(child);
          return;
        }
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            fail(new Error("Malformed Orukeet worker response"));
            void this.terminate(child);
            return;
          }
          if (message.event === "error") {
            fail(new Error(message.error || "Orukeet startup failed"));
            void this.terminate(child);
            continue;
          }
          if (message.event === "ready") {
            if (![1, 2].includes(message.protocol_version) || message.device !== device) {
              fail(new Error("Incompatible Orukeet native runtime"));
              void this.terminate(child);
              return;
            }
            clearTimeout(timer);
            this.runtime = { ...message, gpu_name: gpuName || null };
            this.ready = true;
            resolve();
            continue;
          }
          const request = this.pending.get(message.id);
          if (!request) continue;
          this.pending.delete(message.id);
          if (message.error) {
            const error = new Error(message.error);
            error.workerFailure = message.error_kind === "runtime";
            request.reject(error);
          } else if (typeof message.result?.text !== "string")
            request.reject(new Error("Invalid Orukeet transcript"));
          else request.resolve(message.result);
        }
      });
    });
  }

  transcribe(samples, sampleRate, { signal } = {}) {
    const operation = async () => {
      const generation = this.generation;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await this._transcribe(samples, sampleRate, { signal });
        } catch (error) {
          if (signal?.aborted || generation !== this.generation)
            throw createAbortError("Orukeet transcription cancelled");
          const device = this.runtime?.device;
          const automatic =
            !process.env.OPENWHISPR_ORUKEET_DEVICE ||
            process.env.OPENWHISPR_ORUKEET_DEVICE === "auto";
          if (!automatic || !device || device === "cpu" || !error.workerFailure || attempt === 2)
            throw error;
          this.failedDevices.add(device);
          this.ready = false;
          this.fallbacks.push({ device, error: error.message, phase: "inference" });
          debugLogger.warn("Orukeet GPU decode failed; retrying with the next runtime", {
            device,
            error: error.message,
          });
          if (this.process) await this.terminate(this.process);
          if (signal?.aborted || generation !== this.generation)
            throw createAbortError("Orukeet transcription cancelled");
          await this.start(this.modelName, this.modelDir);
        }
      }
    };
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }

  async _transcribe(samples, sampleRate, { signal } = {}) {
    if (signal?.aborted) throw createAbortError("Orukeet transcription cancelled");
    if (!this.ready || !this.process) throw new Error("Orukeet worker is not loaded");
    if (
      sampleRate !== 16000 ||
      !Buffer.isBuffer(samples) ||
      samples.length % 4 ||
      samples.length > 30 * 16000 * 4
    ) {
      throw new Error("Orukeet expects at most 30 seconds of mono 16 kHz float32 PCM");
    }
    if (!samples.length) return { text: "", elapsed: 0 };
    const temp = await fsp.mkdtemp(path.join(getSafeTempDir(), "orukeet-"));
    const audio = path.join(temp, "audio.f32");
    try {
      await fsp.writeFile(audio, samples);
      if (signal?.aborted) throw createAbortError("Orukeet transcription cancelled");
      const started = performance.now();
      const result = await new Promise((resolve, reject) => {
        const id = ++this.serial;
        const abort = () => {
          done(createAbortError("Orukeet transcription cancelled"));
          void this.stop();
        };
        const timer = setTimeout(() => {
          const error = new Error("Orukeet transcription timed out");
          error.workerFailure = true;
          done(error);
          if (this.process) void this.terminate(this.process);
        }, 300000);
        const done = (error, result) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          this.pending.delete(id);
          if (error) reject(error);
          else resolve(result);
        };
        this.pending.set(id, {
          resolve: (value) => done(null, value),
          reject: (error) => done(error),
        });
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          abort();
          return;
        }
        this.process.stdin.write(
          JSON.stringify({ id, op: "transcribe", audio_path: audio }) + "\n",
          (error) => {
            if (error) done(error);
          }
        );
      });
      return { ...result, elapsed: (performance.now() - started) / 1000 };
    } finally {
      await fsp.rm(temp, { recursive: true, force: true });
    }
  }

  async stop() {
    this.generation++;
    this.probeController?.abort();
    if (this.probeProcess) await this.terminate(this.probeProcess);
    if (this.stopping) return this.stopping;
    const child = this.process;
    this.ready = false;
    for (const request of this.pending.values())
      request.reject(new Error("Orukeet worker stopped"));
    this.pending.clear();
    if (!child) return;
    this.stopping = this.terminate(child);
    try {
      await this.stopping;
    } finally {
      if (this.process === child) {
        this.process = null;
        pidFile.clear("orukeet");
      }
      this.stopping = null;
    }
  }
}
module.exports = OrukeetNative;
