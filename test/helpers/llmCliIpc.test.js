const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { registerLlmCliIpc } = require("../../src/helpers/llmCli/llmCliIpc");

const ROOT = path.join(__dirname, "..", "..");

function makeIpcMain() {
  const handlers = new Map();
  return { handlers, handle: (channel, fn) => handlers.set(channel, fn) };
}

function makeDetector(overrides = {}) {
  const listeners = new Set();
  return {
    onChange: (fn) => listeners.add(fn),
    emit: (seat, state) => listeners.forEach((fn) => fn(seat, state)),
    detectAll: async () => ({ codex: { status: "installed" } }),
    testSeat: async (seat) => ({ ok: true, seat }),
    ...overrides,
  };
}

function makeSender() {
  const sent = [];
  const listeners = new Map();
  return {
    sent,
    listeners,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
    on: (name, fn) => listeners.set(name, fn),
    once: (name, fn) => listeners.set(name, fn),
    removeListener: (name) => listeners.delete(name),
  };
}

test("stream channels are registered and relay parts then done", async () => {
  const ipcMain = makeIpcMain();
  const runner = {
    runStream: async ({ onPart }) => {
      onPart({ type: "text-delta", id: "1", delta: "hi" });
      return { ok: true, text: "hi" };
    },
  };
  registerLlmCliIpc({ ipcMain, runner, detector: makeDetector() });
  assert.ok(ipcMain.handlers.has("llm-cli-stream-start"));
  assert.ok(ipcMain.handlers.has("llm-cli-stream-cancel"));

  const sender = makeSender();
  const result = await ipcMain.handlers.get("llm-cli-stream-start")(
    { sender },
    { streamId: "s1", seat: "codex", prompt: "x" }
  );
  assert.deepEqual(result, { success: true });
  assert.deepEqual(
    sender.sent.map((m) => [m.channel, m.payload.streamId, m.payload.part?.type ?? m.payload.done]),
    [
      ["llm-cli-stream-part", "s1", "text-delta"],
      ["llm-cli-stream-part", "s1", true],
    ]
  );
});

test("a failed run sends a redacted error part", async () => {
  const ipcMain = makeIpcMain();
  const runner = {
    runStream: async () => ({
      ok: false,
      code: "exit-nonzero",
      message: "bad sk-ant-oat01-abcdefghij",
    }),
  };
  registerLlmCliIpc({ ipcMain, runner, detector: makeDetector() });
  const sender = makeSender();
  const result = await ipcMain.handlers.get("llm-cli-stream-start")(
    { sender },
    { streamId: "s2", seat: "grok", prompt: "x" }
  );
  assert.equal(result.success, false);
  assert.ok(!JSON.stringify(sender.sent).includes("abcdefghij"));
  assert.equal(sender.sent[0].payload.code, "exit-nonzero");
});

test("unknown seat, oversize payload and bad ids are rejected before the runner", async () => {
  const ipcMain = makeIpcMain();
  let called = 0;
  registerLlmCliIpc({
    ipcMain,
    detector: makeDetector(),
    runner: {
      runStream: async () => {
        called += 1;
        return { ok: true };
      },
    },
  });
  const start = ipcMain.handlers.get("llm-cli-stream-start");
  const sender = makeSender();
  for (const payload of [
    { streamId: "a", seat: "gemini", prompt: "x" },
    { streamId: "", seat: "codex", prompt: "x" },
    { streamId: "a", seat: "codex", prompt: "x".repeat(1100000) },
    { streamId: "a", seat: "codex", prompt: "x", modelId: { evil: true } },
    null,
  ]) {
    const result = await start({ sender }, payload);
    assert.equal(result.code, "invalid-input");
  }
  assert.equal(called, 0);
});

test("stream-cancel aborts the in-flight run", async () => {
  const ipcMain = makeIpcMain();
  let aborted = false;
  const runner = {
    runStream: ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve({ ok: false, code: "killed", message: "cancelled" });
        });
      }),
  };
  registerLlmCliIpc({ ipcMain, runner, detector: makeDetector() });
  const sender = makeSender();
  const pending = ipcMain.handlers.get("llm-cli-stream-start")(
    { sender },
    { streamId: "s3", seat: "agy", prompt: "x" }
  );
  await ipcMain.handlers.get("llm-cli-stream-cancel")({}, "s3");
  const result = await pending;
  assert.equal(aborted, true);
  assert.equal(result.code, "killed");
});

function channelsIn(file) {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  return new Set(text.match(/"llm-cli-[a-z-]+"/g) || []);
}

test("the llm-cli runtime is composed in main.js, never inside IPCHandlers (its tests stub electron without safeStorage)", () => {
  const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
  assert.doesNotMatch(read("src/helpers/ipcHandlers.js"), /initLlmCliIpc|llmCli\/llmCliIpc/);
  assert.match(read("main.js"), /initLlmCliIpc\(\{ logger: debugLogger \}\)/);
});

test("preload and llmCliIpc.js agree on every llm-cli channel (invoke and event)", () => {
  const ipc = channelsIn("src/helpers/llmCli/llmCliIpc.js");
  const preload = channelsIn("preload.js");
  assert.ok(ipc.size > 0);
  assert.deepEqual([...preload].sort(), [...ipc].sort());
});

test("detect and test channels delegate to the detector and validate the seat", async () => {
  const ipcMain = makeIpcMain();
  const detector = makeDetector();
  const events = [];
  registerLlmCliIpc({
    ipcMain,
    runner: {},
    detector,
    emitEvent: (event) => events.push(event),
  });
  assert.deepEqual(await ipcMain.handlers.get("llm-cli-detect")({}), {
    codex: { status: "installed" },
  });
  assert.deepEqual(await ipcMain.handlers.get("llm-cli-test")({}, "agy"), {
    ok: true,
    seat: "agy",
  });
  assert.equal((await ipcMain.handlers.get("llm-cli-test")({}, "gemini")).code, "invalid-input");
  detector.emit("codex", { status: "signed-in" });
  assert.deepEqual(events, [{ type: "state", seat: "codex", state: { status: "signed-in" } }]);
});

test("sign-in channels validate the seat, strip the done promise and emit signin-result", async () => {
  const ipcMain = makeIpcMain();
  const events = [];
  const calls = [];
  const signIn = {
    start: async ({ seat }) => ({ ok: true, done: Promise.resolve({ ok: true }), seat }),
    submitCode: (arg) => (calls.push(arg), { ok: true }),
    cancel: async (seat) => calls.push(["cancel", seat]),
    signOut: async ({ seat }) => ({ ok: true, affectsTerminalCli: seat === "codex" }),
  };
  registerLlmCliIpc({
    ipcMain,
    runner: {},
    detector: makeDetector(),
    installer: {},
    signIn,
    prefs: makePrefs({ claudeEnabled: true }),
    emitEvent: (event) => events.push(event),
  });
  const started = await ipcMain.handlers.get("llm-cli-signin-start")({}, "claude");
  assert.deepEqual(started, { ok: true, seat: "claude" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.at(-1), {
    type: "signin-result",
    seat: "claude",
    ok: true,
    code: undefined,
  });
  assert.equal(
    (await ipcMain.handlers.get("llm-cli-signin-start")({}, "bogus")).code,
    "invalid-input"
  );
  assert.deepEqual(await ipcMain.handlers.get("llm-cli-signin-submit-code")({}, "claude", "abc"), {
    ok: true,
  });
  assert.equal(
    (await ipcMain.handlers.get("llm-cli-signin-submit-code")({}, "claude", 5)).code,
    "invalid-input"
  );
  await ipcMain.handlers.get("llm-cli-signin-cancel")({}, "claude");
  assert.deepEqual(calls, [{ seat: "claude", code: "abc" }, ["cancel", "claude"]]);
  assert.deepEqual(await ipcMain.handlers.get("llm-cli-signout")({}, "codex"), {
    ok: true,
    affectsTerminalCli: true,
  });
});

test("install channels accept only a seat and a bounded url string", async () => {
  const ipcMain = makeIpcMain();
  const seen = [];
  const installer = {
    install: async (arg) => (seen.push(arg.seat), { ok: true }),
    cancel: (seat) => seen.push(["cancel", seat]),
  };
  registerLlmCliIpc({ ipcMain, runner: {}, detector: makeDetector(), installer, signIn: {} });
  const start = ipcMain.handlers.get("llm-cli-install-start");
  assert.equal((await start({}, "gemini", "https://x")).code, "invalid-input");
  assert.equal((await start({}, "codex", { url: 1 })).code, "invalid-input");
  assert.equal((await start({}, "codex", "x".repeat(3000))).code, "invalid-input");
  assert.deepEqual(await start({}, "codex", "https://chatgpt.com/codex/install.ps1"), { ok: true });
  await ipcMain.handlers.get("llm-cli-install-cancel")({}, "codex");
  assert.deepEqual(seen, ["codex", ["cancel", "codex"]]);
});

const os = require("os");
const childProcess = require("child_process");
const { createRunner } = require("../../src/helpers/llmCli/llmCliRunner");
const { createPrefs } = require("../../src/helpers/llmCli/llmCliPrefs");

function makePrefs(initial) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llm-cli-prefs-")), "p.json");
  if (initial) fs.writeFileSync(file, JSON.stringify(initial));
  return createPrefs({ file });
}

function gateHarness(prefs) {
  const ipcMain = makeIpcMain();
  const hits = { stream: 0, test: 0, signin: 0 };
  registerLlmCliIpc({
    ipcMain,
    runner: {
      runStream: async () => (hits.stream++, { ok: true }),
      cancel: () => {},
    },
    detector: makeDetector({ testSeat: async () => (hits.test++, { ok: true }) }),
    installer: {},
    signIn: { start: async () => (hits.signin++, { ok: true }), cancel: async () => {} },
    prefs,
  });
  return { ipcMain, hits };
}

test("prefs: fresh profile is claudeEnabled false; only claudeEnabled boolean is accepted", async () => {
  const { ipcMain } = gateHarness(makePrefs());
  assert.deepEqual(await ipcMain.handlers.get("llm-cli-get-prefs")({}), { claudeEnabled: false });
  const set = ipcMain.handlers.get("llm-cli-set-pref");
  assert.equal((await set({}, "other", true)).code, "invalid-input");
  assert.equal((await set({}, "claudeEnabled", "yes")).code, "invalid-input");
  assert.equal((await set({}, "__proto__", true)).code, "invalid-input");
  assert.deepEqual(await set({}, "claudeEnabled", true), {
    success: true,
    prefs: { claudeEnabled: true },
  });
  assert.deepEqual(await ipcMain.handlers.get("llm-cli-get-prefs")({}), { claudeEnabled: true });
});

test("prefs persist to the file and a corrupt file reads as defaults", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llm-cli-prefs-")), "p.json");
  createPrefs({ file }).set("claudeEnabled", true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).claudeEnabled, true);
  assert.equal(createPrefs({ file }).get().claudeEnabled, true);
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(createPrefs({ file }).get(), { claudeEnabled: false });
});

test("claude gate: stream, test and signin-start return claude-disabled when the pref is off", async () => {
  const off = gateHarness(makePrefs());
  const sender = makeSender();
  const stream = await off.ipcMain.handlers.get("llm-cli-stream-start")(
    { sender },
    { streamId: "g1", seat: "claude", prompt: "x" }
  );
  assert.equal(stream.code, "claude-disabled");
  assert.equal(sender.sent[0].payload.code, "claude-disabled");
  assert.equal(
    (await off.ipcMain.handlers.get("llm-cli-test")({}, "claude")).code,
    "claude-disabled"
  );
  assert.equal(
    (await off.ipcMain.handlers.get("llm-cli-signin-start")({}, "claude")).code,
    "claude-disabled"
  );
  assert.deepEqual(off.hits, { stream: 0, test: 0, signin: 0 });
  // Other seats are never gated.
  assert.equal((await off.ipcMain.handlers.get("llm-cli-test")({}, "codex")).ok, true);

  const on = gateHarness(makePrefs({ claudeEnabled: true }));
  await on.ipcMain.handlers.get("llm-cli-stream-start")(
    { sender: makeSender() },
    { streamId: "g2", seat: "claude", prompt: "x" }
  );
  await on.ipcMain.handlers.get("llm-cli-test")({}, "claude");
  await on.ipcMain.handlers.get("llm-cli-signin-start")({}, "claude");
  assert.deepEqual(on.hits, { stream: 1, test: 1, signin: 1 });
});

test("quit hook cancels a hung run and the child process is gone", async () => {
  const fake = path.join(__dirname, "..", "fixtures", "llm-cli", "fake-cli.js");
  const children = [];
  const runner = createRunner({
    spawn: (...args) => {
      const child = childProcess.spawn(...args);
      children.push(child);
      return child;
    },
    tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "llm-cli-quit-")),
    env: { ...process.env, FAKE_CLI_MODE: "hang" },
    resolveExe: async () => ({ exe: process.execPath, args: [fake] }),
  });
  const ipcMain = makeIpcMain();
  let quit = null;
  const calls = [];
  registerLlmCliIpc({
    ipcMain,
    runner,
    detector: makeDetector(),
    installer: { cancelAll: () => calls.push("installer") },
    signIn: { cancelAll: async () => calls.push("signIn") },
    prefs: makePrefs(),
    onQuit: (fn) => (quit = fn),
  });
  const pending = ipcMain.handlers.get("llm-cli-stream-start")(
    { sender: makeSender() },
    { streamId: "q1", seat: "codex", prompt: "hello" }
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  quit();
  const result = await pending;
  assert.equal(result.code, "killed");
  assert.deepEqual(calls.sort(), ["installer", "signIn"]);
  const child = children[0];
  // A POSIX SIGKILL leaves exitCode null and sets signalCode; the exit event
  // has already fired by the time the run resolves, so it must be read here.
  const gone =
    child.exitCode !== null ||
    child.signalCode !== null ||
    (await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 8000);
      child.once("exit", () => (clearTimeout(timer), resolve(true)));
    }));
  assert.equal(gone, true);
});

// ---- End to end: real modules, fake process boundary, codex seat ----
const { EventEmitter } = require("events");
const { createDetector } = require("../../src/helpers/llmCli/llmCliDetect");
const { createInstaller } = require("../../src/helpers/llmCli/llmCliInstaller");
const { createSignIn } = require("../../src/helpers/llmCli/llmCliSignIn");

test("e2e codex: detect, install, sign-in, stream, cancel, sign-out in order, no secret emitted", async () => {
  const CANARY = `sk-ant-api03-${"C".repeat(40)}`;
  const EXE = "C:\\bin\\codex.exe";
  const fake = path.join(__dirname, "..", "fixtures", "llm-cli", "fake-cli.js");
  const env = {
    Path: "C:\\bin",
    SystemRoot: "C:\\Windows",
    ANTHROPIC_API_KEY: CANARY,
    FAKE_CLI_MODE: "codex-ok",
  };
  let present = true;
  let signedIn = true;
  const detectorSpawn = (exe, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 1;
    child.kill = () => {};
    const key = path.win32.basename(exe).toLowerCase();
    const argLine = args.join(" ");
    let out = "";
    let code = 0;
    if (key === "powershell.exe")
      out = JSON.stringify({ Status: "Valid", Subject: 'CN="OpenAI OpCo, LLC"' });
    else if (argLine === "--version") out = "codex-cli 0.157.0";
    else if (argLine === "exec --help")
      out =
        "--sandbox --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules --output-last-message";
    else if (argLine === "login status") {
      out = signedIn ? "Logged in using ChatGPT" : "Not logged in";
      code = signedIn ? 0 : 1;
    } else if (argLine === "logout --help") out = "Remove stored authentication credentials";
    else if (argLine === "logout") signedIn = false;
    setImmediate(() => {
      if (out) child.stdout.emit("data", Buffer.from(out));
      child.emit("close", code);
    });
    return child;
  };
  const detector = createDetector({
    fs: {
      statSync: (p) => {
        if (present && p.toLowerCase() === EXE.toLowerCase()) return { isFile: () => true };
        throw new Error("ENOENT");
      },
      readdirSync: () => [],
    },
    spawn: detectorSpawn,
    env,
    platform: "win32",
    tokenStore: { has: () => false },
  });
  const runnerChildren = [];
  const runner = createRunner({
    spawn: (...args) => {
      const child = childProcess.spawn(...args);
      runnerChildren.push(child);
      return child;
    },
    tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "llm-cli-e2e-")),
    env,
    resolveExe: async () => ({ exe: process.execPath, args: [fake] }),
  });
  const flowChild = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 2;
    return child;
  };
  const installChild = flowChild();
  const installer = createInstaller({
    spawn: () => installChild,
    detector,
    platform: "win32",
    env,
  });
  const signInChild = flowChild();
  const events = [];
  const emitEvent = (event) => events.push(event);
  const signIn = createSignIn({
    spawn: () => signInChild,
    detector,
    tokenStore: { clear() {} },
    openExternal: async () => {},
    platform: "win32",
    env,
    emit: emitEvent,
    killTree: () => {},
  });
  const ipcMain = makeIpcMain();
  registerLlmCliIpc({
    ipcMain,
    runner,
    detector,
    installer,
    signIn,
    prefs: makePrefs(),
    emitEvent,
  });
  const returned = [];
  const call = async (channel, ...args) => {
    const result = await ipcMain.handlers.get(channel)({ sender: makeSender() }, ...args);
    returned.push(result);
    return result;
  };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const mark = (label) => events.push({ type: "MARK", label });

  // detect
  mark("detect");
  const detected = await call("llm-cli-detect");
  assert.equal(detected.codex.status, "signed-in");

  // install (the vendor script prints a line that contains a key; it must be redacted)
  mark("install");
  const installing = call(
    "llm-cli-install-start",
    "codex",
    "https://chatgpt.com/codex/install.ps1"
  );
  await tick();
  installChild.stdout.emit("data", Buffer.from(`using key ${CANARY}\nok\n`));
  installChild.emit("close", 0);
  assert.equal((await installing).ok, true);

  // sign-in (device auth)
  mark("signin");
  signedIn = false;
  const signing = await call("llm-cli-signin-start", "codex");
  assert.equal(signing.ok, true);
  signInChild.stdout.emit(
    "data",
    Buffer.from("Open https://auth.openai.com/codex/device code ABCD-1234\n")
  );
  signedIn = true;
  signInChild.emit("close", 0);
  await new Promise((resolve) => setTimeout(resolve, 50));

  // stream
  mark("stream");
  const sender = makeSender();
  const streamed = await ipcMain.handlers.get("llm-cli-stream-start")(
    { sender },
    { streamId: "e1", seat: "codex", prompt: "hello" }
  );
  returned.push(streamed);
  assert.equal(streamed.success, true);
  assert.equal(sender.sent.at(-1).payload.done, true);

  // cancel
  mark("cancel");
  env.FAKE_CLI_MODE = "hang";
  const hung = ipcMain.handlers.get("llm-cli-stream-start")(
    { sender: makeSender() },
    { streamId: "e2", seat: "codex", prompt: "hello" }
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  await call("llm-cli-stream-cancel", "e2");
  assert.equal((await hung).code, "killed");

  // sign-out
  mark("signout");
  const out = await call("llm-cli-signout", "codex");
  assert.deepEqual(out, { ok: true, affectsTerminalCli: true });

  const labels = events.map((e) => (e.type === "MARK" ? e.label : e.type));
  const at = (name, from = 0) => labels.indexOf(name, from);
  const installAt = at("install");
  const signinAt = at("signin");
  assert.ok(installAt > at("detect"));
  assert.ok(at("install-progress", installAt) > installAt);
  assert.ok(at("install-progress", installAt) < signinAt);
  assert.ok(at("signin-prompt", signinAt) > signinAt);
  assert.ok(at("signin-result", signinAt) > at("signin-prompt", signinAt));
  assert.ok(at("signin-result", signinAt) < at("stream"));
  const states = events.filter((e) => e.type === "state").map((e) => e.state.status);
  assert.ok(states.includes("installing"));
  assert.ok(states.includes("signing-in"));
  assert.equal(states.at(-1), "signed-out");

  const everything = JSON.stringify([events, returned]);
  assert.ok(!everything.includes(CANARY), "no key may be emitted or returned");
  assert.ok(!everything.includes("sk-ant"));
  for (const child of runnerChildren) {
    assert.ok(child.exitCode !== null || child.signalCode || child.killed);
  }
});
