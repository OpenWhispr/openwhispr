#!/usr/bin/env node
"use strict";

/**
 * Isolated-profile E2E for the CLI audio-import bridge (see
 * src/helpers/cliAudioImportBridge.js / src/services/cliAudioImport.ts).
 *
 * Launches the REAL desktop app — built renderer, real WhisperManager, real
 * SQLite notes DB — under a throwaway HOME/userData profile that never
 * touches the real user's OpenWhispr install, then drives the real
 * `openwhispr --local transcribe <path> --wait` CLI command against it and
 * verifies a real `note_type=upload` note was created with the expected
 * transcript.
 *
 * Isolation:
 *   - HOME is redirected to .e2e/home for both the app and the CLI, so every
 *     os.homedir()-based path (~/.openwhispr/cli-bridge.json,
 *     ~/.cache/openwhispr/*) resolves under .e2e/, never the real profile.
 *   - --user-data-dir points Electron's app.getPath("userData") (settings,
 *     the notes SQLite DB, localStorage) at .e2e/user-data.
 *   - OPENWHISPR_CHANNEL=production so the app loads the pre-built
 *     src/dist bundle instead of expecting a dev server.
 *
 * Prerequisites (never fetched automatically beyond the pinned model below,
 * to keep provenance explicit — run these once, see README):
 *   - `node node_modules/electron/install.js` (or a plain `npm install`)
 *   - `npm run download:whisper-cpp` (pinned OpenWhispr/whisper.cpp release)
 *   - `npm run build:renderer`
 *   - the CLI worktree built (`npm test` or `npm run build` there)
 *
 * Usage: node scripts/e2e-audio-import.js
 */

const path = require("path");
const fs = require("fs");
const { spawn, execFileSync } = require("child_process");
const http = require("http");

const REPO_ROOT = path.join(__dirname, "..");
const E2E_ROOT = path.join(REPO_ROOT, ".e2e");
const HOME_DIR = path.join(E2E_ROOT, "home");
const USER_DATA_DIR = path.join(E2E_ROOT, "user-data");
const AUDIO_DIR = path.join(E2E_ROOT, "audio");
const EVIDENCE_DIR = path.join(E2E_ROOT, "evidence");
const CLI_REPO = path.join(REPO_ROOT, "..", "openwhispr-cli.poc-local-cli-transcription");
const CLI_ENTRY = path.join(CLI_REPO, "dist", "index.js");

const MODEL_FILE = "ggml-tiny.bin";
// Same registry entry / source the app itself downloads from for the "tiny"
// model (src/models/modelRegistryData.json) — fetched once here rather than
// driven through the download UI, purely to avoid automating clicks.
const modelRegistry = require(path.join(REPO_ROOT, "src/models/modelRegistryData.json"));
const MODEL_URL = modelRegistry.whisperModels.tiny.downloadUrl;

const SYNTHETIC_SENTENCE =
  "The quick brown fox jumps over the lazy dog for a synthetic transcription test.";

function normalizeToWords(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// A real local Whisper pass over SYNTHETIC_SENTENCE may drop/alter a word or
// two (e.g. punctuation-driven ASR quirks), so this checks substantive
// overlap rather than an exact string match: most of the sentence's distinct
// words must reappear in the transcript for it to count as a genuine
// transcription of the audio actually spoken, not an unrelated placeholder.
function transcriptSubstantiallyMatchesSynthetic(transcriptText) {
  const expectedWords = [...new Set(normalizeToWords(SYNTHETIC_SENTENCE))];
  const actualWords = new Set(normalizeToWords(transcriptText));
  if (actualWords.size === 0 || expectedWords.length === 0) return false;
  const matched = expectedWords.filter((w) => actualWords.has(w)).length;
  return matched / expectedWords.length >= 0.6;
}

function log(...args) {
  console.log("[e2e]", ...args);
}

const CACHE_ROOT = path.join(HOME_DIR, ".cache", "openwhispr");
// Must exactly match modelDirUtils.js's RELOCATED_SUBDIRS. Pre-creating all
// of them (even empty) is required so getCacheRoot()'s legacy-migration
// step no-ops via its `fs.existsSync(to)` skip check for every one of them —
// see the isolation note by OPENWHISPR_CACHE_ROOT below for why this matters.
const RELOCATED_MODEL_SUBDIRS = [
  "whisper-models",
  "parakeet-models",
  "diarization-models",
  "models",
];

function ensureDirs() {
  for (const d of [
    ...RELOCATED_MODEL_SUBDIRS.map((s) => path.join(CACHE_ROOT, s)),
    USER_DATA_DIR,
    AUDIO_DIR,
    EVIDENCE_DIR,
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

async function ensureModel() {
  const modelPath = path.join(CACHE_ROOT, "whisper-models", MODEL_FILE);
  if (fs.existsSync(modelPath) && fs.statSync(modelPath).size > 1_000_000) {
    log("model already provisioned:", modelPath);
    return modelPath;
  }
  log("downloading model from", MODEL_URL);
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
  fs.writeFileSync(modelPath, Buffer.from(await res.arrayBuffer()));
  log("model saved:", modelPath, `(${fs.statSync(modelPath).size} bytes)`);
  return modelPath;
}

function ensureWhisperServerBinary() {
  const binPath = path.join(REPO_ROOT, "resources", "bin", "whisper-server-darwin-arm64");
  if (!fs.existsSync(binPath)) {
    throw new Error(
      `whisper-server binary missing at ${binPath}; run "npm run download:whisper-cpp" first`
    );
  }
  return binPath;
}

function ensureElectronBinary() {
  const electronPath = require("electron");
  if (typeof electronPath !== "string" || !fs.existsSync(electronPath)) {
    throw new Error("electron binary missing; run `node node_modules/electron/install.js` first");
  }
  return electronPath;
}

function ensureRendererBuilt() {
  const indexHtml = path.join(REPO_ROOT, "src", "dist", "index.html");
  if (!fs.existsSync(indexHtml)) {
    throw new Error(`renderer not built; run "npm run build:renderer" first`);
  }
  return indexHtml;
}

function ensureCliBuilt() {
  if (!fs.existsSync(CLI_ENTRY)) {
    throw new Error(`CLI not built; run "npm run build" in ${CLI_REPO} first`);
  }
  return CLI_ENTRY;
}

function resolveFfmpeg() {
  const candidates = [
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
    (() => {
      try {
        return require("ffmpeg-static");
      } catch {
        return null;
      }
    })(),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("no ffmpeg binary found (checked system paths and ffmpeg-static)");
}

function generateSyntheticAudio() {
  const mp3Path = path.join(AUDIO_DIR, "synthetic-speech.mp3");
  if (fs.existsSync(mp3Path)) {
    log("synthetic audio already generated:", mp3Path);
    return mp3Path;
  }
  const aiffPath = path.join(AUDIO_DIR, "synthetic-speech.aiff");
  // macOS's built-in offline TTS — no network, no dependency on real user audio.
  execFileSync("say", ["-o", aiffPath, SYNTHETIC_SENTENCE]);
  const ffmpeg = resolveFfmpeg();
  execFileSync(ffmpeg, [
    "-y",
    "-i",
    aiffPath,
    "-ar",
    "44100",
    "-ac",
    "1",
    "-codec:a",
    "libmp3lame",
    "-qscale:a",
    "4",
    mp3Path,
  ]);
  fs.unlinkSync(aiffPath);
  log("synthetic audio generated:", mp3Path);
  return mp3Path;
}

function waitFor(predicate, { timeoutMs, intervalMs = 250, label }) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      let result;
      try {
        result = await predicate();
      } catch {
        result = false;
      }
      if (result) return resolve(result);
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for: ${label}`));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function bridgeFilePath() {
  return path.join(HOME_DIR, ".openwhispr", "cli-bridge.json");
}

function readBridgeFile() {
  if (!fs.existsSync(bridgeFilePath())) return null;
  try {
    return JSON.parse(fs.readFileSync(bridgeFilePath(), "utf8"));
  } catch {
    return null;
  }
}

function httpJson(options) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// --- Chrome DevTools Protocol client (built-in WebSocket, no new deps) ---
class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.eventListeners = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        const listeners = this.eventListeners.get(msg.method) || [];
        for (const fn of listeners) fn(msg.params);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.eventListeners.has(method)) this.eventListeners.set(method, []);
    this.eventListeners.get(method).push(fn);
  }

  static async connect(cdpPort) {
    const { body: targets } = await httpJson({
      hostname: "127.0.0.1",
      port: cdpPort,
      path: "/json/list",
      method: "GET",
    });
    // Window creation tags the control panel with ?panel=true (see
    // src/utils/windowContext.ts); the dictation panel loads the same
    // index.html without that flag, so filtering on it (not just
    // "index.html") is required to target the right renderer.
    const target = targets.find((t) => t.type === "page" && t.url.includes("panel=true"));
    if (!target) throw new Error("no control-panel page target found via CDP");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    const session = new CdpSession(ws);
    await session.send("Runtime.enable");
    await session.send("Network.enable");
    return session;
  }
}

async function main() {
  ensureDirs();
  const electronPath = ensureElectronBinary();
  ensureWhisperServerBinary();
  ensureRendererBuilt();
  ensureCliBuilt();
  await ensureModel();
  const audioPath = generateSyntheticAudio();

  const cdpPort = 19222; // arbitrary, well outside the app's own 8200-8219 CLI-bridge range
  const env = {
    ...process.env,
    HOME: HOME_DIR,
    OPENWHISPR_CHANNEL: "production",
    NODE_ENV: "production",
    LOCAL_WHISPER_MODEL: "tiny",
    LOCAL_TRANSCRIPTION_PROVIDER: "whisper",
    OPENWHISPR_AUTH_BRIDGE_PORT: "15199", // avoid colliding with any real instance
    // REQUIRED isolation, not an optimization: Electron's app.getPath("home")
    // reads the OS user record directly on macOS and ignores the HOME env
    // var entirely (unlike Node's os.homedir()), so without this override
    // getCacheRoot() (src/helpers/modelDirUtils.js) would silently resolve
    // to the REAL ~/.cache/openwhispr. This takes precedence unconditionally
    // in getPreferredCacheRoot(). ensureDirs() above pre-creates every
    // RELOCATED_MODEL_SUBDIRS entry at CACHE_ROOT so the legacy-migration
    // step in getCacheRoot() no-ops (its per-subdir `fs.existsSync(to)` skip
    // check) instead of moving anything from the real cache root.
    OPENWHISPR_CACHE_ROOT: CACHE_ROOT,
  };
  delete env.VITE_OPENWHISPR_CHANNEL;

  log("spawning isolated Electron app", { HOME: HOME_DIR, USER_DATA_DIR, CACHE_ROOT });
  const child = spawn(
    electronPath,
    [
      REPO_ROOT,
      `--user-data-dir=${USER_DATA_DIR}`,
      `--remote-debugging-port=${cdpPort}`,
      "--no-sandbox",
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] }
  );
  const appLog = fs.createWriteStream(path.join(EVIDENCE_DIR, "app-stdout.log"));
  child.stdout.pipe(appLog);
  child.stderr.pipe(appLog);

  const networkRequests = [];
  let cdp;
  try {
    await waitFor(() => readBridgeFile() !== null, {
      timeoutMs: 60_000,
      label: "cli-bridge.json to appear",
    });
    const bridge = readBridgeFile();
    log("bridge ready", { port: bridge.port });

    cdp = await waitFor(() => CdpSession.connect(cdpPort), {
      timeoutMs: 30_000,
      label: "CDP control-panel target",
    });
    log("CDP attached");

    cdp.on("Network.requestWillBeSent", (params) => {
      networkRequests.push({ url: params.request.url, method: params.request.method });
    });

    // A brand-new isolated profile has no onboardingCompleted/auth localStorage
    // flags, so AppRouter renders the OnboardingFlow (or a reauth screen)
    // instead of ControlPanel, and useCliAudioImportHost() never mounts. Mark
    // onboarding/auth as already-settled via the same localStorage flags the
    // real onboarding flow itself writes on completion, then reload so
    // AppRouter re-evaluates with ControlPanel as the result.
    //
    // The reload must wait for the window's *initial* navigation to finish
    // first: main.js's did-fail-load handler on the dictation panel treats
    // any aborted main-frame load at startup as fatal (shows a dialog and
    // tears the app down), so reloading mid-navigation is not safe.
    await cdp.send("Page.enable");
    await waitFor(
      async () => {
        const { result } = await cdp.send("Runtime.evaluate", {
          expression: "document.readyState",
          returnByValue: true,
        });
        return result.value === "complete";
      },
      { timeoutMs: 30_000, label: "initial control-panel page load" }
    );
    const loadEventFired = new Promise((resolve) => cdp.on("Page.loadEventFired", resolve));
    await cdp.send("Runtime.evaluate", {
      expression: `
        localStorage.setItem("onboardingCompleted", "true");
        localStorage.setItem("authenticationSkipped", "true");
        localStorage.setItem("skipAuth", "true");
      `,
    });
    await cdp.send("Page.reload");
    await waitFor(() => loadEventFired.then(() => true), {
      timeoutMs: 30_000,
      label: "page reload after onboarding bypass",
    });
    await new Promise((r) => setTimeout(r, 500)); // let ControlPanel's own effects settle

    // Configure the isolated renderer's upload-transcription setting to local
    // Whisper/tiny, the same fields the Settings UI's local-mode toggle
    // writes (src/stores/settingsStore.ts setUploadUseLocalWhisper /
    // setUploadWhisperModel / setUploadLocalTranscriptionProvider /
    // setUploadTranscriptionMode) — invoked directly against the live store
    // singleton rather than simulating clicks, since no click-driver exists
    // in this repo.
    const assetsDir = path.join(REPO_ROOT, "src", "dist", "assets");
    const settingsChunk = fs.readdirSync(assetsDir).find((f) => /^settingsStore-.*\.js$/.test(f));
    if (!settingsChunk) throw new Error("could not locate built settingsStore chunk");

    const configureExpr = `
      (async () => {
        const mod = await import(new URL(${JSON.stringify(`assets/${settingsChunk}`)}, document.baseURI).href);
        // Export names are minified/aliased per-build by Vite; find the
        // Zustand store hook by shape (a function carrying .getState/
        // .setState/.subscribe, per Zustand's create() API) instead of by a
        // guessed literal export name.
        const storeHook = Object.values(mod).find(
          (v) =>
            typeof v === "function" &&
            typeof v.getState === "function" &&
            typeof v.setState === "function" &&
            typeof v.getState().setUploadUseLocalWhisper === "function"
        );
        if (!storeHook) {
          throw new Error("no matching zustand settings store export found: keys=" + Object.keys(mod).join(","));
        }
        const state = storeHook.getState();
        state.setUploadUseLocalWhisper(true);
        state.setUploadLocalTranscriptionProvider("whisper");
        state.setUploadWhisperModel("tiny");
        state.setUploadTranscriptionMode("local");
        const after = storeHook.getState();
        return {
          uploadUseLocalWhisper: after.uploadUseLocalWhisper,
          uploadWhisperModel: after.uploadWhisperModel,
          uploadLocalTranscriptionProvider: after.uploadLocalTranscriptionProvider,
        };
      })()
    `;
    const configResult = await cdp.send("Runtime.evaluate", {
      expression: configureExpr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (configResult.exceptionDetails) {
      throw new Error(
        `renderer settings configuration failed: ${JSON.stringify(configResult.exceptionDetails)}`
      );
    }
    log("renderer upload settings configured:", configResult.result.value);

    // Give the renderer's cliAudioImportHostReady() a moment to register.
    await new Promise((r) => setTimeout(r, 500));

    // Reset the network log right before the real transcribe call so the
    // "no remote request during import" check only covers the import window.
    networkRequests.length = 0;

    log("running: openwhispr --local transcribe", audioPath, "--wait --format json");
    const cliOutput = execFileSync(
      process.execPath,
      [CLI_ENTRY, "--local", "transcribe", audioPath, "--wait", "--format", "json"],
      { env: { ...process.env, HOME: HOME_DIR }, encoding: "utf8" }
    );
    const job = JSON.parse(cliOutput);
    log("CLI job result:", job);

    if (job.status !== "completed" || !job.result?.note_id) {
      throw new Error(`job did not complete with a note_id: ${JSON.stringify(job)}`);
    }

    // Verify via the CLI's own notes commands (real HTTP round trip through
    // the same authenticated bridge, not a DB read) that the note is really
    // there and visible in the ordinary notes list.
    const noteJson = execFileSync(
      process.execPath,
      [CLI_ENTRY, "--local", "notes", "get", job.result.note_id, "--format", "json"],
      { env: { ...process.env, HOME: HOME_DIR }, encoding: "utf8" }
    );
    const note = JSON.parse(noteJson);

    const listJson = execFileSync(
      process.execPath,
      [CLI_ENTRY, "--local", "notes", "list", "--format", "json"],
      { env: { ...process.env, HOME: HOME_DIR }, encoding: "utf8" }
    );
    const notesList = JSON.parse(listJson);
    const visibleInList = notesList.some((n) => String(n.id) === String(job.result.note_id));

    const PLACEHOLDER_STRINGS = [
      "can you sent me the report by friday",
      "whats the capital of france",
    ];
    const transcriptText = job.result.text || note.content || note.transcript || "";
    const transcriptLower = transcriptText.toLowerCase();
    const looksLikePlaceholder = PLACEHOLDER_STRINGS.some((p) => transcriptLower.includes(p));
    const isNonEmptyTranscript = transcriptText.trim().length > 0;
    const matchesSyntheticSentence = transcriptSubstantiallyMatchesSynthetic(transcriptText);

    const externalRequests = networkRequests.filter((r) => {
      try {
        const u = new URL(r.url);
        return !["127.0.0.1", "localhost", "::1"].includes(u.hostname) && u.protocol !== "file:";
      } catch {
        return false;
      }
    });

    const evidence = {
      timestamp: new Date().toISOString(),
      audio_source_filename: path.basename(audioPath),
      synthetic_sentence: SYNTHETIC_SENTENCE,
      job,
      note_id: job.result.note_id,
      note_type: note.note_type,
      note_title: note.title,
      note_source_file: note.source_file,
      transcript_excerpt: transcriptText.slice(0, 300),
      visible_in_notes_list: visibleInList,
      matches_known_placeholder: looksLikePlaceholder,
      transcript_nonempty: isNonEmptyTranscript,
      matches_synthetic_sentence: matchesSyntheticSentence,
      network_requests_during_import: networkRequests.length,
      external_requests_during_import: externalRequests,
    };
    fs.writeFileSync(path.join(EVIDENCE_DIR, "evidence.json"), JSON.stringify(evidence, null, 2));
    log("evidence written:", path.join(EVIDENCE_DIR, "evidence.json"));

    const failures = [];
    if (note.note_type !== "upload")
      failures.push(`note_type is "${note.note_type}", expected "upload"`);
    if (!visibleInList) failures.push("note not present in notes list");
    if (looksLikePlaceholder) failures.push("transcript matches a known placeholder string");
    if (!isNonEmptyTranscript) failures.push("transcript is empty");
    if (!matchesSyntheticSentence)
      failures.push(
        "transcript does not substantively match the synthetic sentence spoken in the source audio"
      );
    if (externalRequests.length > 0)
      failures.push(`${externalRequests.length} non-local network request(s) during import`);

    if (failures.length > 0) {
      throw new Error(`E2E verification failed:\n - ${failures.join("\n - ")}`);
    }

    log("PASS: real upload note created, verified local-only, no external requests during import.");
  } finally {
    if (cdp) {
      try {
        cdp.ws.close();
      } catch {}
    }
    child.kill("SIGTERM");
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, {
      timeoutMs: 10_000,
      label: "app process exit",
    }).catch(() => child.kill("SIGKILL"));
  }
}

main().catch((err) => {
  console.error("[e2e] FAILED:", err.message);
  process.exit(1);
});
