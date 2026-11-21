const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("events");

const { createSignIn, agyTerminalLaunch } = require("../../src/helpers/llmCli/llmCliSignIn");

const TOKEN = `sk-ant-oat01-${"Qw3_-".repeat(24)}`; // 13 + 120 chars, valid alphabet
const ENV = { SystemRoot: "C:\\Windows", ANTHROPIC_API_KEY: "sk-ant-api03-should-be-scrubbed" };

function makeDetector({ detectState = { status: "signed-in" }, probeCodes = {} } = {}) {
  const applied = [];
  const probes = [];
  return {
    applied,
    probes,
    apply: (seat, event) => applied.push([seat, event.type, event.code]),
    resolveExe: (seat) => `C:\\bin\\${seat}.exe`,
    detectOne: async (seat) => {
      applied.push([seat, "DETECT_ONE"]);
      return detectState;
    },
    probe: async (exe, args) => {
      probes.push(args.join(" "));
      return { code: probeCodes[args.join(" ")] ?? 0, stdout: "", stderr: "" };
    },
  };
}

function makeFakePty() {
  const pty = {
    writes: [],
    killed: 0,
    dataCb: null,
    exitCb: null,
    onData: (cb) => (pty.dataCb = cb),
    onExit: (cb) => (pty.exitCb = cb),
    write: (text) => pty.writes.push(text),
    kill: () => (pty.killed += 1),
  };
  return pty;
}

function makeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 7;
  child.unref = () => {};
  return child;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function wrap(text, width) {
  const lines = [];
  for (let i = 0; i < text.length; i += width) lines.push(text.slice(i, i + width));
  return lines.join("\r\n");
}

function makeClaudeHarness(overrides = {}) {
  const pty = makeFakePty();
  const events = [];
  const logs = [];
  const opened = [];
  const saved = [];
  const ptyCalls = [];
  const detector = makeDetector();
  const signIn = createSignIn({
    ptySpawn: (file, args, options) => {
      ptyCalls.push({ file, args, options });
      return pty;
    },
    detector,
    tokenStore: {
      save: (token) => saved.push(token),
      clear: () => saved.push("CLEARED"),
    },
    openExternal: async (url) => opened.push(url),
    platform: "win32",
    env: ENV,
    log: (...args) => logs.push(args),
    emit: (event) => events.push(event),
    ...overrides,
  });
  return { signIn, pty, events, logs, opened, saved, ptyCalls, detector };
}

test("claude sign-in: allowed url opened, code written, token captured to the store only", async () => {
  const h = makeClaudeHarness();
  const started = await h.signIn.start({ seat: "claude" });
  assert.equal(started.ok, true);
  assert.equal(h.ptyCalls[0].options.cols, 4096);
  assert.deepEqual(h.ptyCalls[0].args, ["setup-token"]);
  assert.equal(h.ptyCalls[0].options.env.ANTHROPIC_API_KEY, undefined);

  h.pty.dataCb(
    "\x1b[32mhttps://claude.ai/oauth/authorize?code=true&client_id=abc\x1b[0m\r\nPaste code here\r\n"
  );
  await tick();
  assert.deepEqual(h.opened, ["https://claude.ai/oauth/authorize?code=true&client_id=abc"]);
  assert.equal(h.events[0].kind, "browser");

  assert.deepEqual(h.signIn.submitCode({ seat: "claude", code: "AUTH-CODE#state" }), { ok: true });
  assert.deepEqual(h.pty.writes, ["AUTH-CODE#state\r"]);

  h.pty.dataCb(`\x1b[1mYour token:\x1b[0m\r\n${wrap(TOKEN, 61)}\r\nStore it safely\r\n`);
  const result = await started.done;
  assert.equal(result.ok, true);
  assert.deepEqual(h.saved, [TOKEN]);
  assert.ok(h.pty.killed >= 1);
  assert.ok(h.detector.applied.some(([, type]) => type === "SIGNIN_DONE"));

  // Canary: the token appears in no event, no log call, no returned payload.
  const surfaces = JSON.stringify([h.events, h.logs, started.ok, result]);
  assert.ok(!surfaces.includes(TOKEN));
  assert.ok(!surfaces.includes("sk-ant-oat01"));
});

test("claude sign-in: a token split across pty chunks at every boundary is saved whole", async () => {
  for (let split = 90; split <= 130; split += 1) {
    const h = makeClaudeHarness();
    const started = await h.signIn.start({ seat: "claude" });
    h.pty.dataCb(`Your token:\r\n${TOKEN.slice(0, split)}`);
    await tick();
    assert.deepEqual(h.saved, [], `saved a truncated token at split ${split}`);
    h.pty.dataCb(`${TOKEN.slice(split)}\r\nStore it safely\r\n`);
    const result = await started.done;
    assert.equal(result.ok, true);
    assert.deepEqual(h.saved, [TOKEN], `split ${split}`);
    assert.ok(!JSON.stringify([h.events, h.logs, result]).includes("sk-ant-oat01"));
  }
});

test("claude sign-in: a wrapped token, split at every chunk boundary, is saved whole and never as a prefix", async () => {
  for (const width of [80, 100]) {
    const text = `Your token:\r\n${wrap(TOKEN, width)}\r\n\r\nStore it safely\r\n`;
    for (let split = 1; split < text.length; split += 1) {
      const h = makeClaudeHarness();
      const started = await h.signIn.start({ seat: "claude" });
      h.pty.dataCb(text.slice(0, split));
      await tick();
      const where = `width ${width} split ${split}`;
      assert.ok(h.saved.length === 0 || h.saved[0] === TOKEN, `prefix saved: ${where}`);
      h.pty.dataCb(text.slice(split));
      const result = await started.done;
      assert.equal(result.ok, true, where);
      assert.deepEqual(h.saved, [TOKEN], where);
    }
  }
});

test("claude sign-in: a wrapped token followed only by a line break is completed on pty exit, whole", async () => {
  const h = makeClaudeHarness();
  const started = await h.signIn.start({ seat: "claude" });
  h.pty.dataCb(`Your token:\r\n${wrap(TOKEN, 100)}\r\n`);
  await tick();
  assert.deepEqual(h.saved, []);
  h.pty.exitCb({ exitCode: 0 });
  assert.equal((await started.done).ok, true);
  assert.deepEqual(h.saved, [TOKEN]);
});

test("claude sign-in: an undelimited token is accepted when the pty exits", async () => {
  const h = makeClaudeHarness();
  const started = await h.signIn.start({ seat: "claude" });
  h.pty.dataCb(`Your token:\r\n${TOKEN}`);
  await tick();
  assert.deepEqual(h.saved, []);
  h.pty.exitCb({ exitCode: 0 });
  const result = await started.done;
  assert.equal(result.ok, true);
  assert.deepEqual(h.saved, [TOKEN]);
});

test("claude sign-in never opens a disallowed url", async () => {
  const h = makeClaudeHarness();
  await h.signIn.start({ seat: "claude" });
  h.pty.dataCb("Open https://claude.ai.evil.example/login now\r\n");
  await tick();
  assert.deepEqual(h.opened, []);
  assert.equal(h.events.length, 0);
  await h.signIn.cancel("claude");
});

test("claude: a pty that exits without a token is not-signed-in; second start while active is busy", async () => {
  const h = makeClaudeHarness();
  const started = await h.signIn.start({ seat: "claude" });
  assert.equal((await h.signIn.start({ seat: "claude" })).code, "busy");
  h.pty.exitCb({ exitCode: 1 });
  assert.deepEqual(await started.done, { ok: false, code: "not-signed-in" });
  assert.deepEqual(h.saved, []);
});

test("claude: a flow older than signInMs is cancelled and killed; cancel kills the pty", async () => {
  const slow = makeClaudeHarness({ timeouts: { signInMs: 150 } });
  const started = await slow.signIn.start({ seat: "claude" });
  assert.deepEqual(await started.done, { ok: false, code: "timeout" });
  assert.ok(slow.pty.killed >= 1);

  const h = makeClaudeHarness();
  const run = await h.signIn.start({ seat: "claude" });
  await h.signIn.cancel("claude");
  assert.deepEqual(await run.done, { ok: false, code: "killed" });
  assert.ok(h.pty.killed >= 1);
});

test("claude: encryption unavailable at save fails the flow without leaking the token", async () => {
  const h = makeClaudeHarness({
    tokenStore: {
      save: () => {
        throw Object.assign(new Error("no encryption"), { code: "encryption-unavailable" });
      },
      clear: () => {},
    },
  });
  const started = await h.signIn.start({ seat: "claude" });
  h.pty.dataCb(`${TOKEN}\r\n\r\nStore it safely\r\n`);
  const result = await started.done;
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify([h.events, h.logs, result]).includes(TOKEN));
});

test("submitCode rejects control characters, oversize codes and idle seats", async () => {
  const h = makeClaudeHarness();
  assert.equal(h.signIn.submitCode({ seat: "claude", code: "abc" }).code, "invalid-input");
  await h.signIn.start({ seat: "claude" });
  assert.equal(h.signIn.submitCode({ seat: "claude", code: "a\nb" }).code, "invalid-input");
  assert.equal(
    h.signIn.submitCode({ seat: "claude", code: "x".repeat(600) }).code,
    "invalid-input"
  );
  assert.deepEqual(h.pty.writes, []);
  await h.signIn.cancel("claude");
});

function makeDeviceHarness(seat, { detectState } = {}) {
  const child = makeChild();
  const events = [];
  const opened = [];
  const detector = makeDetector({ detectState });
  const spawnCalls = [];
  const signIn = createSignIn({
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return child;
    },
    detector,
    tokenStore: { save() {}, clear() {} },
    openExternal: async (url) => opened.push(url),
    platform: "win32",
    env: ENV,
    emit: (event) => events.push(event),
    killTree: () => (child.killedTree = true),
  });
  return { signIn, child, events, opened, detector, spawnCalls, seat };
}

for (const [seat, banner] of [
  ["codex", "Open https://auth.openai.com/codex/device and enter code ABCD-1234\n"],
  ["grok", "Visit https://accounts.x.ai/device?user_code=WXYZ-9876 code WXYZ-9876\n"],
]) {
  test(`${seat} device flow: verified url and code surface, exit 0 plus probe finishes`, async () => {
    const h = makeDeviceHarness(seat);
    const started = await h.signIn.start({ seat });
    assert.deepEqual(h.spawnCalls[0].args, ["login", "--device-auth"]);
    assert.equal(h.spawnCalls[0].options.windowsHide, true);
    assert.equal(h.spawnCalls[0].options.shell, false);
    assert.equal(h.spawnCalls[0].options.env.ANTHROPIC_API_KEY, undefined);
    h.child.stdout.emit("data", Buffer.from(banner));
    await tick();
    assert.equal(h.events[0].kind, "device-code");
    assert.match(h.events[0].code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(h.opened.length, 1);
    h.child.emit("close", 0);
    assert.deepEqual(await started.done, { ok: true });
  });

  test(`${seat} device flow: non-zero exit or mismatching probe is signed-out with not-signed-in`, async () => {
    const bad = makeDeviceHarness(seat);
    const a = await bad.signIn.start({ seat });
    bad.child.emit("close", 1);
    assert.deepEqual(await a.done, { ok: false, code: "not-signed-in" });
    assert.ok(bad.detector.applied.some((e) => e[1] === "SIGNIN_FAIL" && e[2] === "not-signed-in"));

    const mismatch = makeDeviceHarness(seat, { detectState: { status: "signed-out" } });
    const b = await mismatch.signIn.start({ seat });
    mismatch.child.emit("close", 0);
    assert.deepEqual(await b.done, { ok: false, code: "not-signed-in" });
  });
}

test("device flow: second start is busy; cancel kills the child; timeout kills it", async () => {
  const h = makeDeviceHarness("codex");
  const started = await h.signIn.start({ seat: "codex" });
  assert.equal((await h.signIn.start({ seat: "codex" })).code, "busy");
  await h.signIn.cancel("codex");
  assert.equal(h.child.killedTree, true);
  assert.deepEqual(await started.done, { ok: false, code: "killed" });

  const child = makeChild();
  let killed = false;
  const slow = createSignIn({
    spawn: () => child,
    detector: makeDetector(),
    tokenStore: {},
    platform: "win32",
    env: ENV,
    killTree: () => (killed = true),
    timeouts: { signInMs: 120 },
  });
  const run = await slow.start({ seat: "grok" });
  assert.deepEqual(await run.done, { ok: false, code: "timeout" });
  assert.equal(killed, true);
});

test("agy opens its own terminal through a table-derived command and stays installed", async () => {
  const child = makeChild();
  const spawnCalls = [];
  const events = [];
  const detector = makeDetector();
  const signIn = createSignIn({
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return child;
    },
    detector,
    tokenStore: {},
    platform: "win32",
    env: ENV,
    emit: (event) => events.push(event),
  });
  const result = await signIn.start({ seat: "agy" });
  assert.deepEqual(result, { ok: true, kind: "terminal-guide" });
  assert.deepEqual(spawnCalls[0].command, "cmd.exe");
  assert.deepEqual(spawnCalls[0].args, ["/c", "start", "", "C:\\bin\\agy.exe"]);
  assert.equal(spawnCalls[0].options.shell, false);
  assert.equal(events[0].kind, "terminal-guide");
  assert.deepEqual(detector.applied, []); // state untouched until Test succeeds

  assert.deepEqual(agyTerminalLaunch("darwin", "/x/agy"), {
    command: "open",
    args: ["-a", "Terminal", "/x/agy"],
  });
  assert.equal(agyTerminalLaunch("linux", "/x/agy"), null);
});

function makeSignOut({ probeCodes } = {}) {
  const detector = makeDetector({ probeCodes });
  const cleared = [];
  const signIn = createSignIn({
    detector,
    tokenStore: { clear: () => cleared.push(true) },
    platform: "win32",
    env: ENV,
  });
  return { signIn, detector, cleared };
}

test("sign-out: claude clears the token store; grok runs logout; agy is guided", async () => {
  const { signIn, detector, cleared } = makeSignOut();
  assert.deepEqual(await signIn.signOut({ seat: "claude" }), {
    ok: true,
    affectsTerminalCli: false,
  });
  assert.equal(cleared.length, 1);
  assert.deepEqual(await signIn.signOut({ seat: "grok" }), { ok: true, affectsTerminalCli: true });
  assert.deepEqual(detector.probes, ["logout"]);
  assert.deepEqual(await signIn.signOut({ seat: "agy" }), {
    ok: false,
    guided: true,
    affectsTerminalCli: false,
  });
  assert.equal(detector.applied.filter((e) => e[1] === "SIGNOUT_DONE").length, 2);
});

test("sign-out: codex logout runs only if `codex logout --help` exits 0, checked once", async () => {
  const supported = makeSignOut();
  assert.deepEqual(await supported.signIn.signOut({ seat: "codex" }), {
    ok: true,
    affectsTerminalCli: true,
  });
  await supported.signIn.signOut({ seat: "codex" });
  assert.deepEqual(supported.detector.probes, ["logout --help", "logout", "logout"]);

  const unsupported = makeSignOut({ probeCodes: { "logout --help": 2 } });
  assert.deepEqual(await unsupported.signIn.signOut({ seat: "codex" }), {
    ok: false,
    guided: true,
    affectsTerminalCli: true,
  });
  assert.deepEqual(unsupported.detector.probes, ["logout --help"]);
  assert.equal(unsupported.detector.applied.length, 0);
});

test("sign-out: a failing logout is exit-nonzero and does not reduce SIGNOUT_DONE", async () => {
  const { signIn, detector } = makeSignOut({ probeCodes: { logout: 1 } });
  const result = await signIn.signOut({ seat: "grok" });
  assert.equal(result.code, "exit-nonzero");
  assert.equal(detector.applied.length, 0);
});
