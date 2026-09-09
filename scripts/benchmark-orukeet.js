// Native model regression and timing checks. Exercises the real main-process manager under Node.
// Electron's path API is stubbed; no microphone, UI, hotkey or paste is simulated.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const Module = require("node:module");
const os = require("node:os");
const { performance } = require("node:perf_hooks");
// Electron retains platform flags in argv, so locate named options explicitly.
const args = {};
for (const name of ["model", "audio", "output"]) {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1) args[name] = process.argv[index + 1];
}
// A command-line error should fail CI instead of opening Electron's error dialog.
process.on("uncaughtException", (error) => {
  console.error(error);
  process.exit(1);
});
assert(args.audio && args.output);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-orukeet-"));
process.env.OPENWHISPR_CACHE_ROOT = path.join(profile, "model-cache");
if (args.model) process.env.OPENWHISPR_ORUKEET_MODEL = path.resolve(args.model);
else delete process.env.OPENWHISPR_ORUKEET_MODEL;
const electronModule = process.versions.electron ? require("electron") : null;
const realElectron = electronModule?.app ? electronModule : null;
if (realElectron) {
  const electronProfile = path.join(profile, "electron-user-data");
  fs.mkdirSync(electronProfile);
  realElectron.app.setPath("userData", electronProfile);
}
const load = Module._load;
Module._load = function (id, parent, main) {
  if (id === "electron" && !realElectron)
    return {
      app: { getPath: () => profile, isReady: () => false },
      powerMonitor: { on() {}, removeListener() {} },
    };
  return load.call(this, id, parent, main);
};
const ParakeetManager = require("../src/helpers/parakeet");
Module._load = load;
const manager = new ParakeetManager();
const model = "orukeet-v0.1.0-q8";
const audio = fs.readFileSync(args.audio);
const calls = [];
const checks = [];
const receipt = {
  upstream: "OpenWhispr/openwhispr",
  base: "main after v1.9.2",
  base_commit: "a2d0ab2769f34f5ef87216cbd085968656e4c3ca",
  scope: `Real OpenWhispr ParakeetManager backend under ${realElectron ? "Electron " + process.versions.electron : "Node with Electron path API stubbed"}. Decode/normalization, main-process dispatch, temporary PCM, worker IPC and native inference included. Model install/load excluded from warm timing. No GUI/microphone/hotkey/paste.`,
  model,
  hardware: {
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0].model,
    logical_cpus: os.cpus().length,
    memory_bytes: os.totalmem(),
  },
  checks,
  calls,
};
async function transcribe() {
  const start = performance.now();
  const result = await manager.transcribeLocalParakeet(audio, { model });
  assert(result.success);
  assert.match(result.text.toLowerCase(), /ask not what your country/);
  return { ms: performance.now() - start, text: result.text };
}
(async () => {
  try {
    if (realElectron) await realElectron.app.whenReady();
    await manager.downloadParakeetModel(model);
    checks.push("verified model installation");
    const cold = performance.now();
    const start = await manager.startServer(model);
    assert(start.success, start.reason);
    receipt.startup_ms = performance.now() - cold;
    const child = manager.serverManager.nativeServer.process;
    await transcribe();
    for (let i = 0; i < 10; i++) calls.push(await transcribe());
    assert.equal(manager.serverManager.nativeServer.process, child);
    checks.push("ten identical warm transcriptions reuse one worker");
    const ordered = calls.map((x) => x.ms).sort((a, b) => a - b);
    receipt.median_ms = (ordered[4] + ordered[5]) / 2;
    const concurrent = await Promise.all([transcribe(), transcribe()]);
    assert.equal(concurrent[0].text, concurrent[1].text);
    checks.push("concurrent app calls are serialized without changing transcript");
    const silence = Buffer.from(audio);
    for (let i = 44; i < silence.length; i++) silence[i] = 0;
    const quiet = await manager.transcribeLocalParakeet(silence, { model });
    assert.equal(quiet.success, false);
    assert.equal(quiet.message, "No audio detected");
    checks.push("silence returns the app no-audio result");
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(manager.transcribeLocalParakeet(audio, { model, signal: abort.signal }), {
      name: "AbortError",
    });
    checks.push("already-cancelled app call skips inference");
    const cancelling = new AbortController();
    const active = manager.transcribeLocalParakeet(audio, { model, signal: cancelling.signal });
    setTimeout(() => cancelling.abort(), 15);
    await assert.rejects(active, { name: "AbortError" });
    await transcribe();
    checks.push("in-flight cancellation kills worker and next call reloads");
    await manager.stopServer();
    assert.equal(manager.serverManager.nativeServer.process, null);
    checks.push("explicit shutdown leaves no native child");
    receipt.success = true;
  } finally {
    await manager.stopServer();
    fs.writeFileSync(args.output, JSON.stringify(receipt, null, 2) + "\n");
    // Chromium holds the Electron profile open on Windows until app exit.
    // Remove the model cache now; the runner owns the remaining temporary profile.
    fs.rmSync(
      realElectron && process.platform === "win32" ? path.join(profile, "model-cache") : profile,
      {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      }
    );
    if (realElectron) realElectron.app.quit();
  }
})().catch((error) => {
  console.error(error);
  if (realElectron) realElectron.app.exit(1);
  else process.exitCode = 1;
});
