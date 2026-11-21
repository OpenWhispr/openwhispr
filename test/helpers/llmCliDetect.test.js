const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { EventEmitter } = require("events");

const { createDetector } = require("../../src/helpers/llmCli/llmCliDetect");

const W = path.win32;
const norm = (p) => p.replace(/\//g, "\\").toLowerCase();

// Minimal in-memory fs: files only, directories derived from file paths.
function makeFs(files) {
  const fileSet = new Set();
  const children = new Map(); // normDir -> Map(name -> "file" | "dir")
  const readCalls = [];
  const addChild = (dir, name, kind) => {
    const key = norm(dir);
    if (!children.has(key)) children.set(key, new Map());
    children.get(key).set(name, kind);
  };
  const add = (file) => {
    fileSet.add(norm(file));
    let current = file;
    let kind = "file";
    for (;;) {
      const parent = W.dirname(current);
      if (parent === current) break;
      addChild(parent, W.basename(current), kind);
      current = parent;
      kind = "dir";
    }
  };
  files.forEach(add);
  return {
    add,
    remove: (file) => {
      fileSet.delete(norm(file));
      children.get(norm(W.dirname(file)))?.delete(W.basename(file));
    },
    readCalls,
    statSync(p) {
      if (!fileSet.has(norm(p))) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { isFile: () => true };
    },
    readdirSync(dir) {
      const map = children.get(norm(dir));
      if (!map) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return [...map].map(([name, kind]) => ({
        name,
        isFile: () => kind === "file",
        isDirectory: () => kind === "dir",
        isSymbolicLink: () => false,
      }));
    },
    readFileSync(p) {
      readCalls.push(p);
      throw new Error("credential files must never be read");
    },
  };
}

// Scripted fake spawn: key is "<exe basename> <args joined>".
function makeSpawn(script, calls = []) {
  return (exe, args, options) => {
    calls.push({ exe, args, options });
    const key = `${W.basename(exe).toLowerCase()} ${args.join(" ")}`;
    const entry = script[key] ?? { code: 1, stdout: "", stderr: "" };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4242;
    child.kill = () => {};
    setImmediate(() => {
      entry.sideEffect?.();
      if (entry.stdout) child.stdout.emit("data", Buffer.from(entry.stdout));
      if (entry.stderr) child.stderr.emit("data", Buffer.from(entry.stderr));
      child.emit("close", entry.code ?? 0);
    });
    return child;
  };
}

const ENV = {
  Path: "C:\\bin;D:\\tools",
  USERPROFILE: "C:\\Users\\u",
  APPDATA: "C:\\Users\\u\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
};

const FLAGS = {
  claude:
    "--output-format --include-partial-messages --tools --strict-mcp-config --no-session-persistence --permission-mode",
  codex:
    "--sandbox --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules --output-last-message",
  grok: "--prompt-file --output-format --permission-mode --no-subagents --max-turns",
  agy: "--print --output-format --print-timeout --model",
};

function seatScript(seat, exeName, extra = {}) {
  const version = {
    claude: "2.1.330 (Claude Code)",
    codex: "codex-cli 0.157.0",
    grok: "grok 1.0.70",
    agy: "1.5.13",
  }[seat];
  const helpArgs = seat === "codex" ? "exec --help" : "--help";
  return {
    [`${exeName} --version`]: { code: 0, stdout: version },
    [`${exeName} ${helpArgs}`]: { code: 0, stdout: FLAGS[seat] },
    ...extra,
  };
}

function makeDetector({ files, script, tokenStore, env = ENV, runner } = {}) {
  const fs = makeFs(files);
  const calls = [];
  const detector = createDetector({
    fs,
    spawn: makeSpawn(script, calls),
    env,
    platform: "win32",
    tokenStore,
    runner,
    timeouts: { versionMs: 500, helpMs: 500, statusMs: 500 },
  });
  return { detector, fs, calls };
}

const CODEX_NATIVE_TAIL =
  "node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";

test("a seat found only in its known per-user dir (not on PATH) is detected", async () => {
  const exe = "C:\\Users\\u\\.local\\bin\\claude.exe";
  const { detector, calls } = makeDetector({
    files: [exe],
    script: seatScript("claude", "claude.exe"),
    tokenStore: { has: () => false },
  });
  const state = await detector.detectOne("claude");
  assert.equal(state.status, "signed-out");
  assert.equal(state.version, "2.1.330");
  assert.equal(state.path, exe);
  assert.ok(calls.every((c) => W.isAbsolute(c.exe)));
  assert.ok(calls.every((c) => c.options.windowsHide === true && c.options.shell === false));
});

test("claude is signed-in only when the token store holds a token", async () => {
  const exe = "C:\\Users\\u\\.local\\bin\\claude.exe";
  const { detector } = makeDetector({
    files: [exe],
    script: seatScript("claude", "claude.exe"),
    tokenStore: { has: () => true },
  });
  assert.equal((await detector.detectOne("claude")).status, "signed-in");
});

test("a PATH hit is resolved by its absolute path", async () => {
  const exe = "D:\\tools\\grok.exe";
  const { detector, calls } = makeDetector({
    files: [exe],
    script: seatScript("grok", "grok.exe"),
  });
  await detector.detectOne("grok");
  assert.equal(calls[0].exe, exe);
});

test("a codex .cmd shim on PATH resolves to the native exe by bounded search; the shim is never spawned", async () => {
  const native = `D:\\tools\\${CODEX_NATIVE_TAIL}`;
  const { detector, calls } = makeDetector({
    files: ["D:\\tools\\codex.cmd", native],
    script: seatScript("codex", "codex.exe", {
      "codex.exe login status": { code: 0, stdout: "Logged in using ChatGPT" },
    }),
  });
  const state = await detector.detectOne("codex");
  assert.equal(state.path, native);
  assert.equal(state.status, "signed-in");
  assert.ok(calls.every((c) => !/\.(cmd|bat|ps1)$/i.test(c.exe)));
});

test("the native search is depth bounded: depth 6 is found, deeper is not", () => {
  const root = "D:\\tools\\node_modules\\@openai\\codex";
  const tooDeep = `${root}\\a\\b\\c\\d\\e\\f\\g\\codex.exe`;
  const a = makeDetector({ files: ["D:\\tools\\codex.cmd", tooDeep], script: {} });
  assert.equal(a.detector.resolveExe("codex"), null);
  const atSix = `${root}\\a\\b\\c\\d\\e\\f\\codex.exe`;
  const b = makeDetector({ files: ["D:\\tools\\codex.cmd", atSix], script: {} });
  assert.equal(b.detector.resolveExe("codex"), atSix);
});

test("version probe printing nothing is error; a vanished file is quarantined-or-missing", async () => {
  const exe = "C:\\Users\\u\\.local\\bin\\claude.exe";
  const holder = { fs: null };
  const script = {
    "claude.exe --version": { code: 0, stdout: "", sideEffect: () => holder.fs.remove(exe) },
  };
  const gone = makeDetector({ files: [exe], script });
  holder.fs = gone.fs;
  const state = await gone.detector.detectOne("claude");
  assert.equal(state.status, "error");
  assert.equal(state.errorCode, "quarantined-or-missing");

  const plain = makeDetector({
    files: [exe],
    script: { "claude.exe --version": { code: 1, stdout: "" } },
  });
  assert.equal((await plain.detector.detectOne("claude")).errorCode, "exit-nonzero");
});

test("an exe seen on a previous detect and gone now is quarantined-or-missing", async () => {
  const exe = "C:\\Users\\u\\.local\\bin\\claude.exe";
  const { detector, fs } = makeDetector({
    files: [exe],
    script: seatScript("claude", "claude.exe"),
    tokenStore: { has: () => false },
  });
  await detector.detectOne("claude");
  fs.remove(exe);
  assert.equal((await detector.detectOne("claude")).errorCode, "quarantined-or-missing");
});

test("a seat whose help text lacks a required flag is outdated", async () => {
  const script = seatScript("grok", "grok.exe");
  script["grok.exe --help"] = { code: 0, stdout: "--prompt-file --output-format" };
  const { detector } = makeDetector({ files: ["D:\\tools\\grok.exe"], script });
  const state = await detector.detectOne("grok");
  assert.equal(state.status, "outdated");
  assert.ok(state.missingFlags.includes("--max-turns"));
});

test("codex auth probe classifies login status output", async () => {
  const native = `C:\\Users\\u\\AppData\\Roaming\\npm\\${CODEX_NATIVE_TAIL}`;
  const make = (statusEntry) =>
    makeDetector({
      files: [native],
      script: seatScript("codex", "codex.exe", { "codex.exe login status": statusEntry }),
    }).detector;
  const signedIn = await make({ code: 0, stdout: "Logged in using ChatGPT" }).detectOne("codex");
  assert.equal(signedIn.status, "signed-in");
  const signedOut = await make({ code: 1, stderr: "Not logged in" }).detectOne("codex");
  assert.equal(signedOut.status, "signed-out");
  const apiKey = await make({ code: 0, stdout: "Logged in using an API key" }).detectOne("codex");
  assert.equal(apiKey.status, "signed-out");
});

test("grok auth checks the credential file exists, honors GROK_HOME, never reads it", async () => {
  const exe = "C:\\Users\\u\\.grok\\bin\\grok.exe";
  const a = makeDetector({
    files: [exe, "C:\\Users\\u\\.grok\\auth.json"],
    script: seatScript("grok", "grok.exe"),
  });
  assert.equal((await a.detector.detectOne("grok")).status, "signed-in");
  assert.deepEqual(a.fs.readCalls, []);

  const b = makeDetector({ files: [exe], script: seatScript("grok", "grok.exe") });
  assert.equal((await b.detector.detectOne("grok")).status, "signed-out");

  const c = makeDetector({
    files: [exe, "E:\\groks\\auth.json"],
    script: seatScript("grok", "grok.exe"),
    env: { ...ENV, GROK_HOME: "E:\\groks" },
  });
  assert.equal((await c.detector.detectOne("grok")).status, "signed-in");
});

test("agy is installed with authKnown false until a successful Test", async () => {
  const exe = "C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe";
  let outcome = { ok: false, code: "not-signed-in" };
  const runner = { runStream: async () => outcome };
  const { detector } = makeDetector({
    files: [exe],
    script: seatScript("agy", "agy.exe"),
    runner,
  });
  const first = await detector.detectOne("agy");
  assert.equal(first.status, "installed");
  assert.equal(first.authKnown, false);

  assert.deepEqual(await detector.testSeat("agy"), { ok: false, code: "not-signed-in" });
  assert.equal(detector.getState("agy").status, "signed-out");

  outcome = { ok: true, text: "OK" };
  assert.deepEqual(await detector.testSeat("agy"), { ok: true });
  assert.equal(detector.getState("agy").status, "signed-in");
  assert.equal(detector.getState("agy").authKnown, true);
});

test("Re-detect re-runs everything and emits state changes", async () => {
  const { detector, fs } = makeDetector({
    files: ["D:\\tools\\grok.exe"],
    script: seatScript("grok", "grok.exe"),
  });
  const seen = [];
  detector.onChange((seat, state) => seen.push([seat, state.status]));
  const first = await detector.detectAll();
  assert.equal(first.grok.status, "signed-out");
  assert.equal(first.codex.status, "missing");
  fs.add("C:\\Users\\u\\.grok\\auth.json");
  const second = await detector.detectAll();
  assert.equal(second.grok.status, "signed-in");
  assert.ok(seen.filter(([seat]) => seat === "grok").length >= 3);
});
