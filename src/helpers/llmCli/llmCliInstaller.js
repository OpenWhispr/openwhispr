// Consent install of a vendor CLI. The command is built only from the 08-01
// policy table; the one renderer-supplied value is the url the consent dialog
// showed, checked byte-for-byte against the table. The app never fetches or
// reads the vendor script, never writes a .ps1, never spawns a shim, and
// never elevates (the vendor installers are per-user).
const path = require("path");
const { spawn: nodeSpawn } = require("child_process");
const policy = require("../llmCliProviders");
const { defaultKillTree } = require("./llmCliRunner");

const PROGRESS_KEEP = 200;
const LINE_CAP = 500;
const SIGNATURE_SCRIPT =
  "Get-AuthenticodeSignature -LiteralPath $env:LLM_CLI_EXE | ForEach-Object { @{ Status = [string]$_.Status; Subject = [string]$_.SignerCertificate.Subject } | ConvertTo-Json -Compress }";

function createInstaller({
  spawn = nodeSpawn,
  detector,
  platform = process.platform,
  env = process.env,
  killTree = defaultKillTree,
  log = () => {},
  timeouts = {},
} = {}) {
  const limits = { ...policy.TIMEOUTS, ...timeouts };
  const active = new Map(); // seat -> { child, cancel }

  function hostCommand(argv) {
    const [head, ...rest] = argv;
    if (platform === "win32" && head === "powershell.exe") {
      const root = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
      return [
        path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ...rest,
      ];
    }
    return [head, ...rest];
  }

  // Authenticode publisher of the resolved exe, read through the same hidden
  // spawn. Returns { status, subject } or null when unreadable.
  async function readSignature(exe) {
    const [powershell] = hostCommand(["powershell.exe"]);
    const result = await detector.probe(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", SIGNATURE_SCRIPT],
      {
        env: { ...policy.buildChildEnv("codex", env), LLM_CLI_EXE: exe },
        timeoutMs: limits.statusMs,
      }
    );
    try {
      const parsed = JSON.parse(result.stdout.trim());
      return { status: String(parsed.Status || ""), subject: String(parsed.Subject || "") };
    } catch {
      return null;
    }
  }

  async function install({ seat, consentedUrl, onProgress = () => {} } = {}) {
    if (!policy.getProvider(seat)) return { ok: false, code: "invalid-input" };
    const spec = policy.installSpec(seat, platform);
    if (spec.kind === "guided") return { ok: false, guided: true, url: spec.url };
    if (consentedUrl !== spec.url) return { ok: false, code: "invalid-input" };
    if (active.has(seat)) return { ok: false, code: "busy" };

    const entry = { child: null, cancel: null };
    active.set(seat, entry);
    detector.apply(seat, { type: "INSTALL_START" });

    const kept = [];
    const emitLine = (raw) => {
      const line = policy.redactSecrets(String(raw)).slice(0, LINE_CAP);
      if (line.trim().length === 0) return;
      kept.push(line);
      if (kept.length > PROGRESS_KEEP) kept.shift();
      onProgress({ type: "install-progress", seat, line });
    };

    const done = (result) => ({ ...result, lines: [...kept] });

    try {
      const [command, ...args] = hostCommand(policy.installCommand(seat, platform));
      const outcome = await new Promise((resolve) => {
        let child;
        try {
          child = spawn(command, args, {
            env: policy.buildChildEnv(seat, env),
            windowsHide: true,
            shell: false,
            detached: platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch {
          resolve({ code: "install-failed" });
          return;
        }
        entry.child = child;
        let settled = false;
        const settle = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => {
          killTree(child);
          settle({ code: "timeout" });
        }, limits.installMs);
        entry.cancel = () => {
          killTree(child);
          settle({ code: "killed" });
        };
        for (const stream of [child.stdout, child.stderr]) {
          let buffer = "";
          stream.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
            let idx;
            while ((idx = buffer.indexOf("\n")) !== -1) {
              emitLine(buffer.slice(0, idx));
              buffer = buffer.slice(idx + 1);
            }
            if (buffer.length > LINE_CAP * 4) buffer = buffer.slice(-LINE_CAP);
          });
          stream.on("end", () => {
            if (buffer) emitLine(buffer);
            buffer = "";
          });
        }
        child.on("error", () => settle({ code: "install-failed" }));
        child.on("close", (exitCode) =>
          settle(exitCode === 0 ? { ok: true } : { code: "install-failed" })
        );
      });

      if (!outcome.ok) {
        detector.apply(seat, { type: "INSTALL_FAIL", code: outcome.code });
        return done({ ok: false, code: outcome.code });
      }

      // A clean exit with no exe on disk is the antivirus-quarantine signature.
      const exe = detector.resolveExe(seat);
      if (!exe) {
        detector.apply(seat, { type: "INSTALL_FAIL", code: "quarantined-or-missing" });
        return done({
          ok: false,
          code: "quarantined-or-missing",
          messageKey: "llmSubscriptions.errors.quarantined-or-missing",
        });
      }

      let publisher = null;
      if (platform === "win32") {
        const signature = await readSignature(exe);
        publisher = signature ? signature.subject : null;
        if (spec.publisherCheck === "enforce") {
          const trusted =
            signature &&
            signature.status === "Valid" &&
            policy.subjectMatchesPublisher(signature.subject, spec.publisher);
          if (!trusted) {
            detector.apply(seat, { type: "INSTALL_FAIL", code: "signature-invalid" });
            return done({ ok: false, code: "signature-invalid" });
          }
        }
        if (publisher) emitLine(`publisher: ${publisher}`);
      }

      const state = await detector.detectOne(seat);
      return done({ ok: true, state, publisher });
    } catch (error) {
      log("llm-cli install failed", error && error.code);
      detector.apply(seat, { type: "INSTALL_FAIL", code: "install-failed" });
      return done({ ok: false, code: "install-failed" });
    } finally {
      active.delete(seat);
    }
  }

  return {
    install,
    cancel: (seat) => active.get(seat)?.cancel?.(),
    cancelAll: () => {
      for (const entry of active.values()) entry.cancel?.();
    },
  };
}

module.exports = { createInstaller, SIGNATURE_SCRIPT };
