#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT_DIR = path.join(REPOSITORY_ROOT, "artifacts", "whisper-cpu-rca");
const DEFAULT_FIXTURE = path.join(REPOSITORY_ROOT, "test", "fixtures", "whisper-cpu-rca-es.wav");
const DEFAULT_MANIFEST = path.join(REPOSITORY_ROOT, "test", "fixtures", "whisper-cpu-rca-es.json");

const SIDECARS = {
  "0.0.8": {
    asset: "whisper-server-linux-x64-cpu.zip",
    sha256: "bcf9097430df03c16f86aed5b00dec8e12d7ed6ae87f698c3b33be49f345d84e",
    binary: "whisper-server-linux-x64-cpu",
  },
  "0.0.6": {
    asset: "whisper-server-linux-x64-cpu.zip",
    sha256: "4589e862ea13ac9979dbbe658bb0cbae1d39b0b30ce200198c85cb2455335cdb",
    binary: "whisper-server-linux-x64-cpu",
  },
};

const MODEL = {
  id: "ggml-small.bin",
  repository: "ggerganov/whisper.cpp",
  revision: "5359861c739e955e79d9a303bcbc70fb988958b1",
  sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
  bytes: 487601967,
};

export function calculateDurationScaledAudioCtx(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("Fixture must have a positive duration");
  }
  const estimated = Math.ceil((durationSeconds / 30) * 1500 + 128);
  const bounded = Math.min(1500, Math.max(256, estimated));
  return Math.min(1500, Math.ceil(bounded / 64) * 64);
}

export function buildVariants(durationSeconds) {
  const baseline = { language: "auto", audioCtx: null, flashAttention: true, threads: 6 };
  return [
    { id: "baseline-start", ...baseline },
    { id: "forced-spanish", ...baseline, language: "es" },
    { id: "audio-ctx-512", ...baseline, audioCtx: 512 },
    {
      id: "audio-ctx-duration-scaled",
      ...baseline,
      audioCtx: calculateDurationScaledAudioCtx(durationSeconds),
    },
    { id: "flash-attention-off", ...baseline, flashAttention: false },
    { id: "threads-4", ...baseline, threads: 4 },
    { id: "threads-8", ...baseline, threads: 8 },
    { id: "baseline-end", ...baseline },
  ];
}

export function buildServerArgs(variant, modelPath, port) {
  const args = [
    "--model",
    modelPath,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--threads",
    String(variant.threads),
    "--language",
    "auto",
    "--no-timestamps",
  ];
  if (!variant.flashAttention) args.push("--no-flash-attn");
  return args;
}

export function buildInferenceFields(variant) {
  const fields = {
    language: variant.language,
    entropy_thold: "2.8",
    logprob_thold: "-1.25",
    response_format: "json",
  };
  if (variant.audioCtx !== null && variant.audioCtx !== undefined) {
    fields.audio_ctx = String(variant.audioCtx);
  }
  return fields;
}

export function parseWhisperDiagnostics(stderr) {
  const languageMatches = parseLanguageDetections(stderr);
  const language = languageMatches.at(-1);
  const timingsMs = {};
  for (const stage of ["load", "sample", "encode", "decode", "total"]) {
    const expression = new RegExp(
      `whisper_print_timings:\\s+${stage} time\\s*=\\s*([\\d.]+) ms`,
      "gi"
    );
    const matches = [...stderr.matchAll(expression)];
    if (matches.length) timingsMs[stage] = Number(matches.at(-1)[1]);
  }
  return {
    detectedLanguage: language?.language ?? null,
    detectedLanguageProbability: language?.probability ?? null,
    timingsMs,
  };
}

function parseLanguageDetections(stderr) {
  return [...stderr.matchAll(/auto-detected language:\s*([\w-]+)\s*\(p\s*=\s*([\d.]+)\)/gi)].map(
    (match) => ({ language: match[1], probability: Number(match[2]) })
  );
}

function attachRequestLanguageEvidence(result, requestedLanguage, stderr) {
  const languageDetections = parseLanguageDetections(stderr);
  const requests = [...result.warmup, ...result.requests];
  for (const [index, request] of requests.entries()) {
    const detection = requestedLanguage === "auto" ? languageDetections[index] : null;
    request.requestedLanguage = requestedLanguage;
    request.detectedLanguage = detection?.language ?? null;
    request.detectedLanguageProbability = detection?.probability ?? null;
  }
}

function quantile(sorted, fraction) {
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

export function summarizeDurations(durations) {
  if (!durations.length) throw new Error("Cannot summarize an empty duration set");
  const sorted = durations.toSorted((left, right) => left - right);
  const p25 = quantile(sorted, 0.25);
  const p75 = quantile(sorted, 0.75);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return {
    count: sorted.length,
    minMs: sorted[0],
    p25Ms: p25,
    medianMs: median,
    p75Ms: p75,
    maxMs: sorted.at(-1),
    iqrMs: p75 - p25,
  };
}

export function evaluateBaselineDrift(startMedianMs, endMedianMs) {
  const changePercent = ((endMedianMs - startMedianMs) / startMedianMs) * 100;
  return {
    startMedianMs,
    endMedianMs,
    changePercent: Number(changePercent.toFixed(2)),
    thresholdPercent: 15,
    stable: Math.abs(changePercent) <= 15,
  };
}

export async function executeVariant(variant, operations, { warmups = 1, measuredRuns = 10 } = {}) {
  const result = { ...variant, status: "failed", warmup: [], requests: [] };
  let started;
  try {
    started = await operations.start(variant);
    result.readyMs = started.readyMs;
    for (let index = 0; index < warmups; index += 1) {
      result.warmup.push(await operations.request(started, variant, index));
    }
    for (let index = 0; index < measuredRuns; index += 1) {
      result.requests.push(await operations.request(started, variant, index));
    }
    result.summary = summarizeDurations(result.requests.map((request) => request.durationMs));
    result.status = "passed";
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    if (error && typeof error === "object" && error.variantResult) {
      Object.assign(result, error.variantResult);
    }
  } finally {
    if (started) {
      try {
        Object.assign(result, await operations.stop(started, variant));
      } catch (error) {
        result.stopError = error instanceof Error ? error.message : String(error);
        result.status = "failed";
      }
    }
  }
  attachRequestLanguageEvidence(result, variant.language, result.stderr ?? "");
  if (result.stderr !== undefined) result.diagnostics = parseWhisperDiagnostics(result.stderr);
  return result;
}

export function createReport(parts) {
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), ...parts };
}

function parseArguments(argv) {
  const options = {
    sidecarVersion: "0.0.8",
    outputDir: DEFAULT_OUTPUT_DIR,
    fixturePath: DEFAULT_FIXTURE,
    manifestPath: DEFAULT_MANIFEST,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    switch (argv[index]) {
      case "--sidecar-version":
        options.sidecarVersion = value;
        index += 1;
        break;
      case "--output-dir":
        options.outputDir = path.resolve(value);
        index += 1;
        break;
      case "--fixture":
        options.fixturePath = path.resolve(value);
        index += 1;
        break;
      case "--manifest":
        options.manifestPath = path.resolve(value);
        index += 1;
        break;
      default:
        throw new Error(`Unknown or incomplete option: ${argv[index]}`);
    }
  }
  if (!SIDECARS[options.sidecarVersion]) {
    throw new Error(`Unsupported sidecar version: ${options.sidecarVersion}`);
  }
  return options;
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function verifyFile(filePath, expectedHash, expectedBytes) {
  const details = await stat(filePath);
  if (expectedBytes !== undefined && details.size !== expectedBytes) {
    throw new Error(`${path.basename(filePath)} size mismatch: ${details.size}`);
  }
  const actualHash = await sha256(filePath);
  if (actualHash !== expectedHash) {
    throw new Error(`${path.basename(filePath)} SHA-256 mismatch: ${actualHash}`);
  }
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

async function prepareDependencies(version, workingDirectory) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Phase-one harness supports linux-x64 only");
  }
  const sidecar = SIDECARS[version];
  const archivePath = path.join(workingDirectory, sidecar.asset);
  const extractDirectory = path.join(workingDirectory, "sidecar");
  await mkdir(extractDirectory, { recursive: true });
  await download(
    `https://github.com/OpenWhispr/whisper.cpp/releases/download/${version}/${sidecar.asset}`,
    archivePath
  );
  await verifyFile(archivePath, sidecar.sha256);
  const unzip = spawnSync("unzip", ["-q", archivePath, "-d", extractDirectory], {
    encoding: "utf8",
  });
  if (unzip.status !== 0) throw new Error(`unzip failed: ${unzip.stderr.trim()}`);
  const entries = await readdir(extractDirectory, { recursive: true });
  const binaryRelativePath = entries.find((entry) => path.basename(entry) === sidecar.binary);
  if (!binaryRelativePath) throw new Error(`Archive did not contain ${sidecar.binary}`);
  const binaryPath = path.join(extractDirectory, binaryRelativePath);
  await chmod(binaryPath, 0o755);
  const binarySha256 = await sha256(binaryPath);

  const modelPath = path.join(workingDirectory, MODEL.id);
  await download(
    `https://huggingface.co/${MODEL.repository}/resolve/${MODEL.revision}/${MODEL.id}`,
    modelPath
  );
  await verifyFile(modelPath, MODEL.sha256, MODEL.bytes);
  return { binaryPath, binarySha256, modelPath, sidecar };
}

function parseWav(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Fixture is not a RIFF/WAVE file");
  }
  let offset = 12;
  let format;
  let dataBytes;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      format = {
        audioFormat: buffer.readUInt16LE(offset + 8),
        channels: buffer.readUInt16LE(offset + 10),
        sampleRateHz: buffer.readUInt32LE(offset + 12),
        byteRate: buffer.readUInt32LE(offset + 16),
        bitsPerSample: buffer.readUInt16LE(offset + 22),
      };
    }
    if (id === "data") dataBytes = size;
    offset += 8 + size + (size % 2);
  }
  if (!format || dataBytes === undefined) throw new Error("Fixture lacks WAV format or data chunk");
  return { ...format, dataBytes, durationSeconds: dataBytes / format.byteRate };
}

async function fixtureProvenance(fixturePath, manifestPath) {
  const [buffer, manifestText] = await Promise.all([
    readFile(fixturePath),
    readFile(manifestPath, "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const wav = parseWav(buffer);
  const actualHash = createHash("sha256").update(buffer).digest("hex");
  if (actualHash !== manifest.sha256) throw new Error("Fixture SHA-256 does not match manifest");
  for (const [key, value] of [
    ["sampleRateHz", 16000],
    ["channels", 1],
    ["bitsPerSample", 16],
    ["audioFormat", 1],
  ]) {
    if (wav[key] !== value) throw new Error(`Fixture ${key} must be ${value}, got ${wav[key]}`);
  }
  if (Math.abs(wav.durationSeconds - manifest.durationSeconds) > 0.001) {
    throw new Error("Fixture duration does not match manifest");
  }
  return { ...manifest, ...wav, path: path.relative(REPOSITORY_ROOT, fixturePath) };
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForReady(port, child, stderr, timeoutMs = 120000) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited during startup (${child.exitCode}): ${stderr().slice(-1000)}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(1000),
      });
      await response.body?.cancel();
      return Number((performance.now() - startedAt).toFixed(2));
    } catch {
      // Loading the model can take tens of seconds; keep polling until the bounded timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server shutdown timed out")), timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function operationsFor({ binaryPath, modelPath, fixturePath, stderrDirectory }) {
  return {
    async start(variant) {
      const port = await availablePort();
      const args = buildServerArgs(variant, modelPath, port);
      const child = spawn(binaryPath, args, {
        cwd: path.dirname(binaryPath),
        env: { ...process.env, PATH: `${path.dirname(binaryPath)}:${process.env.PATH ?? ""}` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      let stdout = "";
      child.once("error", (error) => {
        stderr += `\nnode spawn error: ${error.stack ?? error.message}\n`;
      });
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.stdout.on("data", (chunk) => (stdout += chunk));
      try {
        const readyMs = await waitForReady(port, child, () => stderr);
        return { port, child, args, readyMs, stderr: () => stderr, stdout: () => stdout };
      } catch (error) {
        child.kill("SIGTERM");
        try {
          await waitForExit(child, 5000);
        } catch {
          child.kill("SIGKILL");
        }
        const stderrPath = path.join(stderrDirectory, `${variant.id}.log`);
        await writeFile(stderrPath, stderr);
        const startupError = error instanceof Error ? error : new Error(String(error));
        startupError.variantResult = {
          exitCode: child.exitCode,
          stderr,
          stderrFile: path.relative(path.dirname(stderrDirectory), stderrPath),
          serverArgs: args,
          inferenceFields: buildInferenceFields(variant),
        };
        throw startupError;
      }
    },
    async request(server, variant, index) {
      const form = new FormData();
      const fixture = await readFile(fixturePath);
      form.append("file", new Blob([fixture], { type: "audio/wav" }), path.basename(fixturePath));
      const fields = buildInferenceFields(variant);
      for (const [key, value] of Object.entries(fields)) form.append(key, value);
      const startedAt = performance.now();
      const response = await fetch(`http://127.0.0.1:${server.port}/inference`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(120000),
      });
      const durationMs = Number((performance.now() - startedAt).toFixed(2));
      const body = await response.text();
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = { raw: body };
      }
      if (!response.ok) throw new Error(`Inference ${response.status}: ${body.slice(0, 500)}`);
      return {
        index: index + 1,
        durationMs,
        status: response.status,
        transcript: parsed.text ?? null,
      };
    },
    async stop(server, variant) {
      server.child.kill("SIGTERM");
      let exitCode;
      try {
        exitCode = await waitForExit(server.child, 10000);
      } catch {
        server.child.kill("SIGKILL");
        exitCode = await waitForExit(server.child, 5000);
      }
      const stderr = server.stderr();
      const stderrPath = path.join(stderrDirectory, `${variant.id}.log`);
      await writeFile(stderrPath, stderr);
      return {
        exitCode,
        stderr,
        stderrFile: path.relative(path.dirname(stderrDirectory), stderrPath),
        serverArgs: server.args,
        inferenceFields: buildInferenceFields(variant),
      };
    },
  };
}

async function readTextIfPresent(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function gitSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function environmentProvenance() {
  const cpu = os.cpus()[0];
  return {
    os: process.platform,
    release: os.release(),
    architecture: process.arch,
    cpuModel: cpu?.model ?? null,
    logicalCpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    node: process.version,
    runner: {
      name: process.env.RUNNER_NAME ?? null,
      os: process.env.RUNNER_OS ?? null,
      architecture: process.env.RUNNER_ARCH ?? null,
      imageOS: process.env.ImageOS ?? null,
      imageVersion: process.env.ImageVersion ?? null,
    },
    github: {
      repository: process.env.GITHUB_REPOSITORY ?? null,
      workflow: process.env.GITHUB_WORKFLOW ?? null,
      job: process.env.GITHUB_JOB ?? null,
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      ref: process.env.GITHUB_REF ?? null,
    },
    osRelease: await readTextIfPresent("/etc/os-release"),
    cpuInfo: await readTextIfPresent("/proc/cpuinfo"),
  };
}

export function renderMarkdown(report) {
  const fixtureDuration = Number.isFinite(report.fixture.durationSeconds)
    ? `${report.fixture.durationSeconds.toFixed(3)}s`
    : "unavailable";
  const lines = [
    "# DES-165 whisper.cpp CPU diagnostic benchmark",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Commit: ${report.repository.sha}`,
    `- Runner: ${report.environment.runner.imageOS ?? report.environment.os} ${report.environment.runner.imageVersion ?? report.environment.release}`,
    `- Sidecar: ${report.sidecar.version} (${report.sidecar.sha256})`,
    `- Model: ${report.model.id} (${report.model.sha256})`,
    `- Fixture: ${report.fixture.path} (${fixtureDuration})`,
    `- Baseline drift: ${report.baselineDrift?.changePercent ?? "n/a"}% (${report.baselineDrift?.stable ? "stable" : "unstable"})`,
    "",
    "| Variant | Status | Ready ms | Median ms | IQR ms | Detected language |",
    "|---|---:|---:|---:|---:|---|",
  ];
  for (const result of report.results) {
    lines.push(
      `| ${result.id} | ${result.status} | ${result.readyMs ?? ""} | ${result.summary?.medianMs ?? ""} | ${result.summary?.iqrMs ?? ""} | ${result.diagnostics?.detectedLanguage ?? ""} |`
    );
  }
  if (report.fatalError) lines.push("", `Fatal error: ${report.fatalError}`);
  lines.push(
    "",
    "The full per-request timings, transcripts, arguments, fields, environment, and native diagnostics are in `report.json` and `stderr/*.log`.",
    ""
  );
  return lines.join("\n");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const outputDirectory = options.outputDir;
  const stderrDirectory = path.join(outputDirectory, "stderr");
  const workingDirectory = process.env.RUNNER_TEMP
    ? path.join(process.env.RUNNER_TEMP, `whisper-cpu-rca-${process.pid}`)
    : path.join(os.tmpdir(), `whisper-cpu-rca-${process.pid}`);
  await Promise.all([
    mkdir(stderrDirectory, { recursive: true }),
    mkdir(workingDirectory, { recursive: true }),
  ]);

  let report;
  try {
    const fixture = await fixtureProvenance(options.fixturePath, options.manifestPath);
    const dependencies = await prepareDependencies(options.sidecarVersion, workingDirectory);
    const operations = operationsFor({
      ...dependencies,
      fixturePath: options.fixturePath,
      stderrDirectory,
    });
    const results = [];
    for (const variant of buildVariants(fixture.durationSeconds)) {
      console.log(`Running ${variant.id}...`);
      results.push(await executeVariant(variant, operations));
    }
    const start = results.find((result) => result.id === "baseline-start");
    const end = results.find((result) => result.id === "baseline-end");
    const baselineDrift =
      start?.summary && end?.summary
        ? evaluateBaselineDrift(start.summary.medianMs, end.summary.medianMs)
        : { stable: false, error: "Both baseline summaries are required" };
    report = createReport({
      repository: { sha: gitSha() },
      environment: await environmentProvenance(),
      sidecar: {
        version: options.sidecarVersion,
        asset: dependencies.sidecar.asset,
        sha256: dependencies.sidecar.sha256,
        archiveSha256: dependencies.sidecar.sha256,
        binarySha256: dependencies.binarySha256,
      },
      model: MODEL,
      fixture,
      configuration: {
        warmups: 1,
        measuredRuns: 10,
        freshServerPerVariant: true,
        durationScaledAudioCtxFormula:
          "ceil-to-64(clamp(ceil(duration_seconds / 30 * 1500 + 128), 256, 1500))",
        durationScaledAudioCtxWarning:
          "Values below 512 are experimental and may be unstable or reduce accuracy.",
      },
      results,
      baselineDrift,
    });
  } catch (error) {
    report = createReport({
      repository: { sha: gitSha() },
      environment: await environmentProvenance(),
      sidecar: { version: options.sidecarVersion, ...SIDECARS[options.sidecarVersion] },
      model: MODEL,
      fixture: { path: path.relative(REPOSITORY_ROOT, options.fixturePath) },
      results: [],
      baselineDrift: { stable: false },
      fatalError: error instanceof Error ? error.stack : String(error),
    });
  }

  await Promise.all([
    writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(path.join(outputDirectory, "report.md"), renderMarkdown(report)),
  ]);
  if (
    report.fatalError ||
    !report.baselineDrift.stable ||
    report.results.some((row) => row.status !== "passed")
  ) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
