// Sign-in and sign-out for the CLI seats. claude: `setup-token` hosted in a pty
// in main, the token captured and stored with safeStorage, never emitted.
// codex and grok: device-auth over a plain spawn, finished when the CLI exits
// 0 and the status probe agrees. agy: no login command, so its own terminal
// is opened and the seat stays `installed` until Test succeeds.
// Nothing here logs pty or CLI output; only state names reach logs and events.
const os = require("os");
const nodeSpawn = require("child_process").spawn;
const policy = require("../llmCliProviders");
const { defaultKillTree } = require("./llmCliRunner");

const BUFFER_CAP = 64 * 1024;
const CODE_MAX = 512;
const PTY_COLS = 4096; // wide enough that the CLI never wraps the long token
const AGY_GUIDE_KEY = "llmCli.signIn.agyTerminalGuide";

// Table-derived launch of agy in its own visible terminal. Linux has no
// portable terminal launcher, so it gets the guide text only.
function agyTerminalLaunch(platform, exe) {
  if (platform === "win32") return { command: "cmd.exe", args: ["/c", "start", "", exe] };
  if (platform === "darwin") return { command: "open", args: ["-a", "Terminal", exe] };
  return null;
}

function defaultPtySpawn(file, args, options) {
  return require("node-pty").spawn(file, args, options);
}

function createSignIn({
  spawn = nodeSpawn,
  ptySpawn = defaultPtySpawn,
  detector,
  tokenStore,
  openExternal = async () => {},
  platform = process.platform,
  env = process.env,
  killTree = defaultKillTree,
  log = () => {},
  emit = () => {},
  timeouts = {},
} = {}) {
  const limits = { ...policy.TIMEOUTS, ...timeouts };
  const flows = new Map(); // seat -> { cancel, write, done }
  let codexLogoutSupported = null; // cached result of `codex logout --help`

  async function openAllowed(seat, url) {
    if (!policy.isAllowedSignInUrl(seat, url)) return false;
    try {
      await openExternal(url);
    } catch (error) {
      log("llm-cli open sign-in url failed", error && error.code);
    }
    return true;
  }

  // ---- claude: pty setup-token ----
  function startClaude(exe) {
    const childEnv = { ...policy.buildChildEnv("claude", env), BROWSER: "true" };
    let pty;
    try {
      pty = ptySpawn(exe, policy.signInSpec("claude").argv, {
        name: "xterm-256color",
        cols: PTY_COLS,
        rows: 30,
        cwd: os.tmpdir(),
        env: childEnv,
      });
    } catch (error) {
      log("llm-cli claude pty unavailable", error && error.code);
      return { ok: false, code: "install-failed" };
    }
    detector.apply("claude", { type: "SIGNIN_START" });

    const flow = { cancel: null, write: null, done: null };
    flows.set("claude", flow);
    flow.done = new Promise((resolve) => {
      let buffer = "";
      let urlOpened = false;
      let settled = false;
      const timer = setTimeout(() => finish({ code: "timeout" }), limits.signInMs);

      const finish = async ({ code }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        buffer = "";
        try {
          pty.kill();
        } catch {
          // Already exited.
        }
        if (!code) {
          resolve({ ok: true });
          return;
        }
        // The truth is the stored-token presence, not the failed attempt.
        await detector.detectOne("claude");
        resolve({ ok: false, code });
      };

      const captureToken = (final) => {
        const token = policy.extractSetupToken(buffer, { final });
        if (!token) return;
        try {
          tokenStore.save(token);
          detector.apply("claude", { type: "SIGNIN_DONE" });
          void finish({ code: null });
        } catch (error) {
          log("llm-cli claude token save failed", error && error.code);
          void finish({
            code:
              error && error.code === "encryption-unavailable" ? "install-failed" : "exit-nonzero",
          });
        }
      };

      pty.onData((data) => {
        if (settled) return;
        buffer += data;
        if (buffer.length > BUFFER_CAP) buffer = buffer.slice(buffer.length - BUFFER_CAP);
        if (!urlOpened) {
          const url = policy.extractSignInUrl("claude", buffer);
          if (url) {
            urlOpened = true;
            void openAllowed("claude", url);
            emit({
              type: "signin-prompt",
              seat: "claude",
              kind: "browser",
              url,
              awaitingCode: true,
            });
          }
        }
        captureToken(false);
      });
      pty.onExit(() => {
        if (settled) return;
        // The stream is over: a token with nothing after it is now complete.
        captureToken(true);
        if (!settled) void finish({ code: "not-signed-in" });
      });
      flow.cancel = () => void finish({ code: "killed" });
      flow.write = (text) => pty.write(text);
    }).finally(() => flows.delete("claude"));
    return { ok: true, done: flow.done };
  }

  // ---- codex and grok: device auth over a plain spawn ----
  function startDeviceAuth(seat, exe) {
    let child;
    try {
      child = spawn(exe, policy.signInSpec(seat).argv, {
        env: policy.buildChildEnv(seat, env),
        cwd: os.tmpdir(),
        windowsHide: true,
        shell: false,
        detached: platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      log("llm-cli device-auth spawn failed", error && error.code);
      return { ok: false, code: "exit-nonzero" };
    }
    detector.apply(seat, { type: "SIGNIN_START" });

    const flow = { cancel: null, write: null, done: null };
    flows.set(seat, flow);
    flow.done = new Promise((resolve) => {
      let buffer = "";
      let prompted = false;
      let settled = false;
      const finish = async (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        buffer = "";
        resolve(result);
      };
      const timer = setTimeout(async () => {
        killTree(child);
        await detector.detectOne(seat);
        finish({ ok: false, code: "timeout" });
      }, limits.signInMs);

      const onData = (chunk) => {
        if (settled || prompted) return;
        buffer += chunk.toString("utf8");
        if (buffer.length > BUFFER_CAP) buffer = buffer.slice(buffer.length - BUFFER_CAP);
        const url = policy.extractSignInUrl(seat, buffer);
        const code = policy.extractDeviceCode(buffer);
        if (url && code) {
          prompted = true;
          void openAllowed(seat, url);
          emit({ type: "signin-prompt", seat, kind: "device-code", url, code });
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", () => {
        detector.apply(seat, { type: "SIGNIN_FAIL", code: "not-signed-in" });
        finish({ ok: false, code: "not-signed-in" });
      });
      child.on("close", async (exitCode) => {
        if (settled) return;
        if (exitCode === 0) {
          const state = await detector.detectOne(seat);
          if (state && state.status === "signed-in") {
            finish({ ok: true });
            return;
          }
        }
        detector.apply(seat, { type: "SIGNIN_FAIL", code: "not-signed-in" });
        finish({ ok: false, code: "not-signed-in" });
      });
      flow.cancel = async () => {
        killTree(child);
        await detector.detectOne(seat);
        finish({ ok: false, code: "killed" });
      };
    }).finally(() => flows.delete(seat));
    return { ok: true, done: flow.done };
  }

  // ---- agy: its own terminal ----
  function startAgyTerminal(exe) {
    const launch = agyTerminalLaunch(platform, exe);
    if (launch) {
      try {
        const child = spawn(launch.command, launch.args, {
          windowsHide: true,
          shell: false,
          detached: true,
          stdio: "ignore",
        });
        child.on("error", () => {});
        child.unref?.();
      } catch (error) {
        log("llm-cli agy terminal launch failed", error && error.code);
      }
    }
    emit({ type: "signin-prompt", seat: "agy", kind: "terminal-guide", guideKey: AGY_GUIDE_KEY });
    return { ok: true, kind: "terminal-guide" };
  }

  async function start({ seat } = {}) {
    if (!policy.getProvider(seat)) return { ok: false, code: "invalid-input" };
    if (flows.has(seat)) return { ok: false, code: "busy" };
    const exe = detector.resolveExe(seat);
    if (!exe) return { ok: false, code: "not-installed" };
    switch (policy.signInSpec(seat).kind) {
      case "pty-token":
        return startClaude(exe);
      case "device-auth":
        return startDeviceAuth(seat, exe);
      default:
        return startAgyTerminal(exe);
    }
  }

  function submitCode({ seat, code } = {}) {
    const flow = flows.get(seat);
    if (!flow || !flow.write) return { ok: false, code: "invalid-input" };
    if (typeof code !== "string" || code.length === 0 || code.length > CODE_MAX) {
      return { ok: false, code: "invalid-input" };
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(code)) return { ok: false, code: "invalid-input" };
    flow.write(`${code}\r`);
    return { ok: true };
  }

  async function cancel(seat) {
    await flows.get(seat)?.cancel?.();
  }

  async function cancelAll() {
    await Promise.all([...flows.values()].map((flow) => flow.cancel?.()));
  }

  // ---- sign-out ----
  async function runLogout(seat, exe) {
    const result = await detector.probe(exe, ["logout"], {
      env: policy.buildChildEnv(seat, env),
      timeoutMs: limits.statusMs,
    });
    return result.code === 0;
  }

  async function signOut({ seat } = {}) {
    if (!policy.getProvider(seat)) return { ok: false, code: "invalid-input" };
    const spec = policy.signOutSpec(seat);
    const affectsTerminalCli = spec.affectsTerminalCli;
    if (spec.kind === "delete-stored-token") {
      tokenStore.clear();
      detector.apply(seat, { type: "SIGNOUT_DONE" });
      return { ok: true, affectsTerminalCli };
    }
    if (spec.kind === "guide") return { ok: false, guided: true, affectsTerminalCli };

    const exe = detector.resolveExe(seat);
    if (!exe) return { ok: false, code: "not-installed" };
    if (seat === "codex") {
      if (codexLogoutSupported === null) {
        const help = await detector.probe(exe, ["logout", "--help"], {
          env: policy.buildChildEnv(seat, env),
          timeoutMs: limits.statusMs,
        });
        codexLogoutSupported = help.code === 0;
      }
      if (!codexLogoutSupported) return { ok: false, guided: true, affectsTerminalCli };
    }
    if (!(await runLogout(seat, exe)))
      return { ok: false, code: "exit-nonzero", affectsTerminalCli };
    detector.apply(seat, { type: "SIGNOUT_DONE" });
    return { ok: true, affectsTerminalCli };
  }

  return { start, submitCode, cancel, cancelAll, signOut, isActive: (seat) => flows.has(seat) };
}

module.exports = { createSignIn, agyTerminalLaunch, AGY_GUIDE_KEY };
