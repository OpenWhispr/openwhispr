const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("events");

const policy = require("../../src/helpers/llmCliProviders");
const { createInstaller } = require("../../src/helpers/llmCli/llmCliInstaller");

const ENV = { SystemRoot: "C:\\Windows", OPENAI_API_KEY: "sk-should-be-scrubbed-1234567890" };

function makeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 99;
  child.kill = () => {};
  return child;
}

function makeHarness({
  platform = "win32",
  exe = "C:\\Users\\u\\.local\\bin\\claude.exe",
  signature,
} = {}) {
  const spawnCalls = [];
  const children = [];
  const applied = [];
  const killed = [];
  const detector = {
    apply: (seat, event) => applied.push([seat, event.type, event.code]),
    resolveExe: () => exe,
    detectOne: async (seat) => ({ status: "installed", seat }),
    probe: async () => ({
      stdout: signature === undefined ? "" : JSON.stringify(signature),
      stderr: "",
      code: 0,
    }),
  };
  const installer = createInstaller({
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      const child = makeChild();
      children.push(child);
      return child;
    },
    detector,
    platform,
    env: ENV,
    killTree: (child) => killed.push(child),
    timeouts: { installMs: 300 },
  });
  return { installer, spawnCalls, children, applied, killed, detector };
}

const finishOk = (h, lines = []) => {
  const child = h.children[0];
  for (const line of lines) child.stdout.emit("data", Buffer.from(`${line}\n`));
  child.emit("close", 0);
};

test("a consentedUrl that is not byte-equal to the table url is rejected; nothing is spawned", async () => {
  const h = makeHarness();
  for (const url of [
    "https://claude.ai/install.ps1 ",
    "https://claude.ai/install.ps1?x=1",
    "https://evil.example/install.ps1",
    undefined,
  ]) {
    const result = await h.installer.install({ seat: "claude", consentedUrl: url });
    assert.equal(result.code, "invalid-input");
  }
  assert.equal(h.spawnCalls.length, 0);
});

test("grok is guided with the guide url; nothing is spawned", async () => {
  const h = makeHarness();
  const result = await h.installer.install({
    seat: "grok",
    consentedUrl: policy.installSpec("grok", "win32").url,
  });
  assert.deepEqual(result, {
    ok: false,
    guided: true,
    url: policy.installSpec("grok", "win32").url,
  });
  assert.equal(h.spawnCalls.length, 0);
});

test("valid codex install: table command, hidden, scrubbed env, progress, then re-detect", async () => {
  const h = makeHarness({
    exe: "C:\\codex.exe",
    signature: { Status: "Valid", Subject: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC"' },
  });
  const progress = [];
  const pending = h.installer.install({
    seat: "codex",
    consentedUrl: policy.installSpec("codex", "win32").url,
    onProgress: (e) => progress.push(e),
  });
  await new Promise((r) => setImmediate(r));
  const call = h.spawnCalls[0];
  const [, ...expectedArgs] = policy.installCommand("codex", "win32");
  assert.match(call.command, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  assert.deepEqual(call.args, expectedArgs);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.env.OPENAI_API_KEY, undefined);
  finishOk(h, ["Downloading...", "token sk-ant-oat01-abcdefghijklmnop leaked", "Installed"]);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.state.status, "installed");
  assert.equal(result.publisher, 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC"');
  assert.ok(progress.every((e) => e.type === "install-progress" && e.seat === "codex"));
  assert.ok(!JSON.stringify(progress).includes("abcdefghijklmnop"));
  assert.ok(progress.some((e) => e.line.includes("publisher: CN=\"OpenAI OpCo")));
  assert.deepEqual(h.applied[0].slice(0, 2), ["codex", "INSTALL_START"]);
});

test("one install per seat runs at a time; the kept lines are capped at 200", async () => {
  const h = makeHarness({ exe: "C:\\codex.exe", signature: { Status: "Valid", Subject: 'CN="OpenAI OpCo, LLC"' } });
  const url = policy.installSpec("codex", "win32").url;
  const first = h.installer.install({ seat: "codex", consentedUrl: url });
  await new Promise((r) => setImmediate(r));
  const second = await h.installer.install({ seat: "codex", consentedUrl: url });
  assert.equal(second.code, "busy");
  assert.equal(h.spawnCalls.length, 1);
  const burst = Array.from({ length: 250 }, (_, i) => `line ${i}`);
  finishOk(h, burst);
  const result = await first;
  assert.equal(result.ok, true);
  assert.equal(result.lines.length, 200);
  assert.equal(result.lines.at(-2), "line 249");
});

test("a hung install is killed at installMs", async () => {
  const h = makeHarness();
  const result = await h.installer.install({
    seat: "codex",
    consentedUrl: policy.installSpec("codex", "win32").url,
  });
  assert.equal(result.code, "timeout");
  assert.equal(h.killed.length, 1);
  assert.deepEqual(h.applied.at(-1), ["codex", "INSTALL_FAIL", "timeout"]);
});

test("non-zero exit is install-failed", async () => {
  const h = makeHarness();
  const pending = h.installer.install({
    seat: "agy",
    consentedUrl: policy.installSpec("agy", "win32").url,
  });
  await new Promise((r) => setImmediate(r));
  h.children[0].emit("close", 2);
  assert.equal((await pending).code, "install-failed");
});

test("clean exit with no exe on disk is quarantined-or-missing with the antivirus key", async () => {
  const h = makeHarness({ exe: null });
  const pending = h.installer.install({
    seat: "codex",
    consentedUrl: policy.installSpec("codex", "win32").url,
  });
  await new Promise((r) => setImmediate(r));
  finishOk(h);
  const result = await pending;
  assert.equal(result.code, "quarantined-or-missing");
  assert.ok(result.messageKey);
  assert.deepEqual(h.applied.at(-1), ["codex", "INSTALL_FAIL", "quarantined-or-missing"]);
});

test("claude publisher check is enforced: not valid or wrong subject is signature-invalid", async () => {
  for (const signature of [
    { Status: "NotSigned", Subject: "" },
    { Status: "Valid", Subject: "CN=Somebody Else" },
    { Status: "HashMismatch", Subject: "CN=Anthropic, PBC" },
    undefined,
  ]) {
    const h = makeHarness({ signature });
    h.detector.detectOne = async () => {
      throw new Error("must not re-detect an untrusted binary");
    };
    const pending = h.installer.install({
      seat: "claude",
      consentedUrl: policy.installSpec("claude", "win32").url,
    });
    await new Promise((r) => setImmediate(r));
    finishOk(h);
    const result = await pending;
    assert.equal(result.code, "signature-invalid");
    assert.deepEqual(h.applied.at(-1), ["claude", "INSTALL_FAIL", "signature-invalid"]);
  }
  const ok = makeHarness({
    signature: { Status: "Valid", Subject: 'CN="Anthropic, PBC", O="Anthropic, PBC"' },
  });
  const pending = ok.installer.install({
    seat: "claude",
    consentedUrl: policy.installSpec("claude", "win32").url,
  });
  await new Promise((r) => setImmediate(r));
  finishOk(ok);
  assert.equal((await pending).ok, true);
});

test("codex and agy publisher checks are enforced: wrong publisher is signature-invalid", async () => {
  for (const [seat, publisher] of [
    ["codex", "OpenAI OpCo, LLC"],
    ["agy", "Google LLC"],
  ]) {
    for (const signature of [
      { Status: "NotSigned", Subject: "" },
      { Status: "Valid", Subject: "CN=Somebody Else" },
      { Status: "HashMismatch", Subject: `CN="${publisher}"` },
      { Status: "Valid", Subject: `CN=Somebody Else, OU=${publisher} tools` },
      { Status: "Valid", Subject: `CN="${publisher} Evil", O="${publisher}"` },
    ]) {
      const h = makeHarness({ signature });
      h.detector.detectOne = async () => {
        throw new Error("must not re-detect an untrusted binary");
      };
      const pending = h.installer.install({
        seat,
        consentedUrl: policy.installSpec(seat, "win32").url,
      });
      await new Promise((r) => setImmediate(r));
      finishOk(h);
      assert.equal((await pending).code, "signature-invalid", seat);
    }
    const ok = makeHarness({ signature: { Status: "Valid", Subject: `CN="${publisher}", O="${publisher}"` } });
    const pending = ok.installer.install({
      seat,
      consentedUrl: policy.installSpec(seat, "win32").url,
    });
    await new Promise((r) => setImmediate(r));
    finishOk(ok);
    assert.equal((await pending).ok, true, seat);
  }
});

test("cancel kills the install", async () => {
  const h = makeHarness();
  const pending = h.installer.install({
    seat: "codex",
    consentedUrl: policy.installSpec("codex", "win32").url,
  });
  await new Promise((r) => setImmediate(r));
  h.installer.cancel("codex");
  assert.equal((await pending).code, "killed");
  assert.equal(h.killed.length, 1);
});
