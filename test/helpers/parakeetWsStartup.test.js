const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");
const { PassThrough } = require("node:stream");
const { execFile: realExecFile, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const modelData = require("../../src/models/modelRegistryData.json");
const ParakeetServerManager = require("../../src/helpers/parakeetServer");
const { getSafeTempDir } = require("../../src/helpers/safeTempDir");

function loadHelper(name, mocks, appProcess = process) {
  const filename = require.resolve(`../../src/helpers/${name}`);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(filename, "utf8"),
    {
      module,
      require: (request) => mocks[request] ?? localRequire(request),
      process: appProcess,
      Buffer,
      AbortController,
      AbortSignal,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    },
    { filename }
  );
  return module.exports;
}

async function startupArgs(modelName, runtime = "offline", language = null, registry = modelData) {
  const calls = [];
  const modelInfo = loadHelper("parakeetModelInfo", {
    "../models/modelRegistryData.json": registry,
  });
  const Server = loadHelper("parakeetWsServer", {
    child_process: {
      spawn: (binary, args) => {
        calls.push({ binary, args: Array.from(args) });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        return child;
      },
    },
    "./parakeetModelInfo": modelInfo,
    "./debugLogger": { debug() {}, info() {} },
    "./sidecarPidFile": { write() {} },
    "./safeTempDir": { getSafeTempDir: () => os.tmpdir() },
    "../utils/serverUtils": {
      findAvailablePort: async () => 6006,
      getAvailableParallelism: () => 8,
    },
  });
  const server = new Server();
  server.getWsBinaryPath = (mode) => `sherpa-${mode}`;
  server._waitForReady = async () => {};
  server._startHealthCheck = () => {};
  server._warmUp = async () => {};
  await server.start(modelName, os.tmpdir(), runtime, language);
  assert.equal(calls.length, 1);
  return calls[0];
}

for (const modelName of ["parakeet-tdt-0.6b-v3", "orukeet-v0.1.0"]) {
  test(`${modelName} starts the offline server with the NeMo decoder hint`, async () => {
    const { binary, args } = await startupArgs(modelName);
    assert.equal(binary, "sherpa-offline");
    assert.deepEqual(args, [
      `--tokens=${path.join(os.tmpdir(), "tokens.txt")}`,
      `--encoder=${path.join(os.tmpdir(), "encoder.int8.onnx")}`,
      `--decoder=${path.join(os.tmpdir(), "decoder.int8.onnx")}`,
      `--joiner=${path.join(os.tmpdir(), "joiner.int8.onnx")}`,
      "--model-type=nemo_transducer",
      "--port=6006",
      "--num-threads=4",
      "--num-work-threads=3",
    ]);
  });
}

test("an unhinted offline model retains sherpa metadata detection", async () => {
  const { args } = await startupArgs("parakeet-unified-en-0.6b");
  assert.ok(!args.some((arg) => arg.startsWith("--model-type=")));
  assert.ok(args.includes(`--joiner=${path.join(os.tmpdir(), "joiner.int8.onnx")}`));
});

test("Cohere keeps its language-specific startup arguments", async () => {
  const { args } = await startupArgs("cohere-transcribe-03-2026", "offline", "fr");
  assert.deepEqual(args, [
    `--tokens=${path.join(os.tmpdir(), "tokens.txt")}`,
    `--cohere-transcribe-encoder=${path.join(os.tmpdir(), "encoder.int8.onnx")}`,
    `--cohere-transcribe-decoder=${path.join(os.tmpdir(), "decoder.int8.onnx")}`,
    "--cohere-transcribe-language=fr",
    "--port=6006",
    "--num-threads=4",
    "--num-work-threads=3",
  ]);
});

test("online startup preserves its scheduling flags and omits offline decoder hints", async () => {
  for (const modelName of ["nemotron-speech-streaming-en-0.6b", "orukeet-v0.1.0"]) {
    const { binary, args } = await startupArgs(modelName, "online");
    assert.equal(binary, "sherpa-online");
    assert.ok(!args.some((arg) => arg.startsWith("--model-type=")));
    assert.deepEqual(args.slice(-5), [
      "--num-threads=4",
      "--num-work-threads=2",
      "--loop-interval-ms=2",
      "--end-tail-padding=0.6",
      "--warm-up=0",
    ]);
  }
});

test("invalid or incompatible registry hints cannot select a different decoder", async () => {
  for (const entry of [
    { sherpaModelType: "transducer" },
    { sherpaModelType: "nemo_transducer", runtime: "online" },
    { sherpaModelType: "nemo_transducer", modelType: "cohere-transcribe" },
  ]) {
    const { args } = await startupArgs("fixture", "offline", "en", {
      parakeetModels: { fixture: entry },
    });
    assert.ok(!args.some((arg) => arg.startsWith("--model-type=")));
  }
});

const ORUKEET_HOTWORDS = { score: 2, words: ["Schellhas", "Kisfeld"] };

// A running server whose spawns are recorded, with the hotwords file each one
// was given read at spawn time (the server deletes it once it is ready).
function hotwordsServer({
  withBpeVocab = true,
  failReadyWhen = () => false,
  controlledStartup = false,
  onSpawn = () => {},
  fileSystem = fs,
  execFile,
  platform = process.platform,
  testContext,
} = {}) {
  const modelRoot = fs.mkdtempSync(path.join(os.tmpdir(), "parakeet-model-"));
  const modelDir = path.join(modelRoot, "orukeet-v0.1.0");
  fs.mkdirSync(modelDir);
  const tempDir = fs.mkdtempSync(path.join(getSafeTempDir(), "parakeet-temp-"));
  testContext.after(() => {
    fs.rmSync(modelRoot, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  if (withBpeVocab) fs.writeFileSync(path.join(modelDir, "bpe.vocab"), "▁s\t-1.0\n");
  const spawns = [];
  const appProcess = { platform, arch: process.arch, env: process.env };
  const mocks = {
    fs: fileSystem,
    child_process: {
      execFile: execFile ?? realExecFile,
      spawn: (binary, args) => {
        const hotwordsArg = args.find((arg) => arg.startsWith("--hotwords-file="));
        const hotwordsFile = hotwordsArg?.slice("--hotwords-file=".length);
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        spawns.push({
          child,
          args: Array.from(args),
          hotwordsFile,
          hotwordsContent: hotwordsFile ? fs.readFileSync(hotwordsFile, "utf8") : null,
          fileMode: hotwordsFile ? fs.statSync(hotwordsFile).mode & 0o777 : null,
          dirMode: hotwordsFile ? fs.statSync(path.dirname(hotwordsFile)).mode & 0o777 : null,
        });
        onSpawn(spawns.at(-1), spawns.length);
        return child;
      },
    },
    "./debugLogger": { debug() {}, info() {}, warn() {}, error() {} },
    "./sidecarPidFile": { write() {}, clear() {} },
    "./safeTempDir": { getSafeTempDir: () => tempDir },
    "../utils/serverUtils": {
      findAvailablePort: async () => 6006,
      getAvailableParallelism: () => 8,
      gracefulStopProcess: async (child) => {
        child.stopping = true;
        await new Promise(setImmediate);
        child.emit("close", null);
      },
    },
  };
  const Server = loadHelper("parakeetWsServer", mocks, appProcess);
  const server = new Server();
  server.getWsBinaryPath = (mode) => `sherpa-${mode}`;
  server._waitForReady = async function (readyFromStderr) {
    if (controlledStartup && !(await readyFromStderr))
      throw new Error("parakeet-ws process died during startup");
    if (failReadyWhen(spawns.at(-1))) throw new Error("parakeet-ws process died during startup");
    this.ready = true;
  };
  server._startHealthCheck = () => {};
  server._warmUp = async () => {};
  const start = (hotwords) => server.start("orukeet-v0.1.0", modelDir, "offline", null, hotwords);
  return { server, spawns, start, modelDir, tempDir };
}

test("dictionary hotwords switch Orukeet to beam search with the words as a file", async (t) => {
  const { spawns, start, modelDir, tempDir } = hotwordsServer({ testContext: t });
  await start(ORUKEET_HOTWORDS);

  assert.equal(spawns.length, 1);
  const { args, hotwordsFile, hotwordsContent } = spawns[0];
  assert.deepEqual(args.slice(-5), [
    "--decoding-method=modified_beam_search",
    `--hotwords-file=${hotwordsFile}`,
    "--hotwords-score=2",
    "--modeling-unit=bpe",
    `--bpe-vocab=${path.join(modelDir, "bpe.vocab")}`,
  ]);
  assert.equal(hotwordsContent, "Schellhas\nKisfeld\n");
  // sherpa reads the file once at startup; the words do not stay on disk.
  assert.equal(fs.existsSync(path.dirname(hotwordsFile)), false);
  assert.deepEqual(fs.readdirSync(tempDir), []);
});

test("the hotwords file sits in a folder of its own that only this user can open", async (t) => {
  const { spawns, start, tempDir } = hotwordsServer({ testContext: t });
  await start(ORUKEET_HOTWORDS);
  await start({ score: 2, words: ["Quillfeather"] });

  const [first, second] = spawns;
  const firstDir = path.dirname(first.hotwordsFile);
  // A fresh, randomly named folder per start, so no planted file or link is in the way.
  assert.equal(path.dirname(firstDir), tempDir);
  assert.match(path.basename(firstDir), /^openwhispr-hotwords-/);
  assert.notEqual(path.dirname(second.hotwordsFile), firstDir);
  if (process.platform !== "win32") {
    assert.equal(first.dirMode, 0o700);
    assert.equal(first.fileMode, 0o600);
  }
});

test("a model directory without bpe.vocab starts without hotwords", async (t) => {
  const { spawns, start } = hotwordsServer({ withBpeVocab: false, testContext: t });
  await start(ORUKEET_HOTWORDS);
  assert.ok(!spawns[0].args.some((arg) => arg.startsWith("--hotwords")));
  assert.ok(!spawns[0].args.includes("--decoding-method=modified_beam_search"));
});

test("the same dictionary keeps the server, a changed one restarts it", async (t) => {
  const { spawns, start } = hotwordsServer({ testContext: t });
  await start(ORUKEET_HOTWORDS);
  await start({ ...ORUKEET_HOTWORDS, words: [...ORUKEET_HOTWORDS.words] });
  assert.equal(spawns.length, 1);

  await start({ score: 2, words: ["Schellhas", "Kisfeld", "Quillfeather"] });
  assert.equal(spawns.length, 2);
  assert.equal(spawns[1].hotwordsContent, "Schellhas\nKisfeld\nQuillfeather\n");

  await start(null);
  assert.equal(spawns.length, 3);
  assert.ok(!spawns[2].args.some((arg) => arg.startsWith("--hotwords")));
});

test("a changed dictionary never cuts off a decode in flight", async (t) => {
  const { server, spawns, start } = hotwordsServer({ testContext: t });
  await start(ORUKEET_HOTWORDS);
  let release;
  server._transcribeOffline = () => new Promise((resolve) => (release = resolve));
  const decode = server.transcribe(Buffer.alloc(4), 16000);

  await start({ score: 2, words: ["Quillfeather"] });
  assert.equal(spawns.length, 1);

  release({ text: "ok", elapsed: 1 });
  assert.deepEqual(await decode, { text: "ok", elapsed: 1 });
  await start({ score: 2, words: ["Quillfeather"] });
  assert.equal(spawns.length, 2);
});

test("a startup that fails with hotwords retries once without them", async (t) => {
  const { spawns, start } = hotwordsServer({
    testContext: t,
    failReadyWhen: (spawn) => Boolean(spawn.hotwordsFile),
  });
  await start(ORUKEET_HOTWORDS);

  assert.equal(spawns.length, 2);
  assert.ok(spawns[0].hotwordsFile);
  assert.equal(fs.existsSync(spawns[0].hotwordsFile), false);
  assert.ok(!spawns[1].args.some((arg) => arg.startsWith("--hotwords")));

  // The same dictionary is not retried on every decode.
  await start(ORUKEET_HOTWORDS);
  assert.equal(spawns.length, 2);
});

const nextTurn = () => new Promise(setImmediate);

function sayReady(spawn) {
  spawn.child.stderr.emit("data", Buffer.from("Listening on:"));
}

function managerFor({ server, modelDir }) {
  const manager = new ParakeetServerManager();
  manager.wsServer = server;
  manager.isModelDownloaded = () => true;
  manager.getModelsDir = () => path.dirname(modelDir);
  return manager;
}

test("a dictionary edit during a cold start preserves both transcriptions", async (t) => {
  const fixture = hotwordsServer({
    controlledStartup: true,
    platform: "linux",
    testContext: t,
    onSpawn(spawn, count) {
      if (count > 1) setImmediate(() => sayReady(spawn));
    },
  });
  const { server, spawns } = fixture;
  const manager = managerFor(fixture);
  server._transcribeOffline = async () => {
    if (server.process.stopping) throw new Error("decode used a stopping child");
    return { text: "ok", elapsed: 1 };
  };
  let words = ["Schellhas"];
  manager.setDictionaryProvider(() => words);

  const wavBuffer = Buffer.alloc(44 + 32000);
  wavBuffer.write("RIFF", 0);
  wavBuffer.writeUInt32LE(wavBuffer.length - 8, 4);
  wavBuffer.write("WAVEfmt ", 8);
  wavBuffer.writeUInt32LE(16, 16);
  wavBuffer.writeUInt16LE(1, 20);
  wavBuffer.writeUInt16LE(1, 22);
  wavBuffer.writeUInt32LE(16000, 24);
  wavBuffer.writeUInt32LE(32000, 28);
  wavBuffer.writeUInt16LE(2, 32);
  wavBuffer.writeUInt16LE(16, 34);
  wavBuffer.write("data", 36);
  wavBuffer.writeUInt32LE(32000, 40);
  for (let offset = 44; offset < wavBuffer.length; offset += 2)
    wavBuffer.writeInt16LE(7000, offset);
  const transcribe = () => manager.transcribe(wavBuffer, { modelName: "orukeet-v0.1.0" });
  const first = transcribe();
  const firstOutcome = first.catch((error) => ({ text: error.message }));
  await nextTurn();
  words = ["Quillfeather"];
  const second = transcribe();
  const secondOutcome = second.catch((error) => ({ text: error.message }));
  await nextTurn();
  sayReady(spawns[0]);
  assert.deepEqual([(await firstOutcome).text, (await secondOutcome).text], ["ok", "ok"]);
  assert.equal(spawns.length, 1);

  assert.equal((await transcribe()).text, "ok");
  assert.equal(spawns[1].hotwordsContent, "Quillfeather\n");
});

test("an explicit stop during biased startup prevents the fallback from respawning", async (t) => {
  const { server, spawns, start, tempDir } = hotwordsServer({
    controlledStartup: true,
    platform: "linux",
    testContext: t,
  });
  const started = start(ORUKEET_HOTWORDS);
  const outcome = started.then(
    () => "ready",
    (error) => error.name
  );
  await nextTurn();
  assert.ok(spawns[0].hotwordsFile);
  await server.stop();
  await nextTurn();
  for (const spawn of spawns.slice(1)) sayReady(spawn);

  assert.equal(await outcome, "AbortError");
  assert.equal(spawns.length, 1);
  assert.equal(server.getStatus().running, false);
  assert.deepEqual(fs.readdirSync(tempDir), []);

  const restarted = start(ORUKEET_HOTWORDS);
  await nextTurn();
  sayReady(spawns[1]);
  await restarted;
  assert.equal(server.getStatus().running, true);
});

test("a refresh waiting on policy cannot restart a stopped server", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = hotwordsServer({ platform: "linux", testContext: t });
  const { server, spawns, start } = fixture;
  const manager = managerFor(fixture);
  await start(null);
  manager.setDictionaryProvider(() => ORUKEET_HOTWORDS.words);

  let allowRefresh;
  server.localModelPolicy = {
    authorize: () => new Promise((resolve) => (allowRefresh = resolve)),
    assertCurrent() {},
    release() {},
  };
  manager.refreshHotwordsSoon();
  t.mock.timers.tick(5000);
  await nextTurn();

  await manager.stopServer();
  allowRefresh({ signal: new AbortController().signal });
  await nextTurn();

  assert.equal(spawns.length, 1);
  assert.equal(server.getStatus().running, false);
});

test("a partial hotwords write is deleted before the unbiased fallback", async (t) => {
  const { spawns, start, tempDir } = hotwordsServer({
    platform: "linux",
    testContext: t,
    fileSystem: {
      ...fs,
      writeFileSync(file, content, options) {
        fs.writeFileSync(file, content.slice(0, 2), options);
        throw Object.assign(new Error("no space on device"), { code: "ENOSPC" });
      },
    },
  });
  await start(ORUKEET_HOTWORDS);

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].hotwordsFile, undefined);
  assert.deepEqual(fs.readdirSync(tempDir), []);
});

test("Windows does not write hotwords when private file creation fails", async (t) => {
  let calledPowerShell = false;
  const { spawns, start, tempDir } = hotwordsServer({
    platform: "win32",
    testContext: t,
    execFile(binary, args, options, callback) {
      calledPowerShell = true;
      assert.match(binary, /powershell\.exe$/i);
      assert.ok(args.includes("-EncodedCommand"));
      assert.ok(!JSON.stringify({ args, options }).includes("Schellhas"));
      setImmediate(() => callback(new Error("access denied")));
      return { stdin: new PassThrough() };
    },
  });
  await start(ORUKEET_HOTWORDS);

  assert.equal(calledPowerShell, true);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].hotwordsFile, undefined);
  assert.deepEqual(fs.readdirSync(tempDir), []);
});

test("an explicit stop clears a refresh scheduled for the previous server", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = hotwordsServer({ platform: "linux", testContext: t });
  const { spawns, start } = fixture;
  const manager = managerFor(fixture);
  await start(null);
  manager.setDictionaryProvider(() => ORUKEET_HOTWORDS.words);
  manager.refreshHotwordsSoon();

  await manager.stopServer();
  await start(null);
  t.mock.timers.tick(5000);
  await nextTurn();

  assert.equal(spawns.length, 2);
  assert.ok(spawns.every((spawn) => !spawn.hotwordsFile));
});

test("Windows passes UTF-8 hotwords to the private writer before spawning sherpa", async (t) => {
  const contents = "Ämber Königs\n";
  const { spawns, start, tempDir } = hotwordsServer({
    platform: "win32",
    testContext: t,
    execFile(_binary, args, options, callback) {
      const file = options.env.OW_HOTWORDS_FILE;
      assert.equal(path.dirname(path.dirname(file)), tempDir);
      assert.equal(fs.existsSync(file), false);
      assert.ok(!JSON.stringify({ args, options }).includes("Königs"));
      const stdin = new PassThrough();
      const chunks = [];
      stdin.on("data", (chunk) => chunks.push(chunk));
      stdin.on("end", () => {
        assert.equal(spawns.length, 0);
        const bytes = Buffer.concat(chunks);
        assert.deepEqual(bytes, Buffer.from(contents, "utf8"));
        fs.writeFileSync(file, bytes, { flag: "wx" });
        callback(null);
      });
      return { stdin };
    },
  });
  await start({ score: 2, words: ["Ämber Königs"] });

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].hotwordsContent, contents);
  assert.deepEqual(fs.readdirSync(tempDir), []);
});

test(
  "Windows creates the real hotwords directory and file with a current-user-only ACL",
  { skip: process.platform !== "win32" },
  async (t) => {
    const inspectAcl = `
$ErrorActionPreference = 'Stop'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sid = [System.Security.Principal.SecurityIdentifier]
$file = $env:OW_TEST_HOTWORDS_FILE
foreach ($entry in @($file, [System.IO.Path]::GetDirectoryName($file))) {
  $acl = Get-Acl -LiteralPath $entry
  $rules = @($acl.GetAccessRules($true, $true, $sid))
  if (!$acl.AreAccessRulesProtected -or $rules.Count -ne 1 -or
      $rules[0].IdentityReference.Value -ne $user -or
      $rules[0].AccessControlType -ne 'Allow') { exit 1 }
}
`;
    const { spawns, start, tempDir } = hotwordsServer({
      testContext: t,
      onSpawn({ hotwordsFile }) {
        assert.ok(hotwordsFile, "expected protected hotwords rather than an unbiased fallback");
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(inspectAcl, "utf16le").toString("base64"),
          ],
          {
            windowsHide: true,
            timeout: 10000,
            env: { ...process.env, OW_TEST_HOTWORDS_FILE: hotwordsFile },
          }
        );
      },
    });
    await start({ score: 2, words: ["Ämber Königs"] });

    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].hotwordsContent, "Ämber Königs\n");
    assert.deepEqual(fs.readdirSync(tempDir), []);
  }
);
