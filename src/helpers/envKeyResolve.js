// Resolve API keys from the process environment and (on Linux/macOS) from a
// trusted login shell, so keys exported in ~/.zshrc, ~/.bashrc or a login profile work even when the app is
// launched from a desktop entry instead of a terminal.
//
// Stored Settings values still win. This module only fills empty keys and
// expands $VAR / ${VAR} references at read time. Callers must not persist
// imported names — EnvironmentManager tracks them and skips them on write.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { promisify } = require("util");
const execFileAsync = promisify(require("child_process").execFile);
const {
  ENV_REF_RE,
  isEnvRef,
  envRefName,
  usableSecret,
  classifySecretInput,
} = require("./envRef.cjs");

const ENV_EXPORT_SENTINEL = "__OW_ENV__";

// Exact system paths only. A basename check would accept /tmp/zsh.
const TRUSTED_LOGIN_SHELLS = ["/bin/zsh", "/usr/bin/zsh", "/bin/bash", "/usr/bin/bash"];
const TRUSTED_LOGIN_SHELL_SET = new Set(TRUSTED_LOGIN_SHELLS);

// If `value` is `$FOO` or `${FOO}`, return env.FOO (or "" if unset).
// Otherwise return value unchanged. One hop only — no recursive expansion.
function resolveEnvRef(value, env = process.env) {
  if (typeof value !== "string") return "";
  const name = envRefName(value);
  if (!name) return value;
  const resolved = env[name];
  return resolved == null ? "" : String(resolved);
}

const SHELL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The script a trusted login shell runs: print the sentinel, then each requested
// name that is exported, as NAME=value\0. printenv reads only exported variables,
// and NUL never occurs in an environment value, so every value arrives exactly as
// the shell holds it (quotes, spaces, `#`, newlines inside) with no shell-quoting
// to undo. Names come from the allowlist, never from user input.
function buildShellImportScript(shell, names) {
  const safe = (names || []).filter((name) => SHELL_NAME_RE.test(name));
  const bash = /bash$/.test(shell || "");
  const value = bash ? '"${!__ow_n}"' : '"${(P)__ow_n}"';
  // A login profile can override a default it sourced from ~/.bashrc. Capture
  // those exports first, then consult ~/.bashrc only for names still missing.
  return [
    ...(bash ? [fs.readFileSync(path.join(__dirname, "observeBashLogin.sh"), "utf8")] : []),
    `printf '%s\\n' '${ENV_EXPORT_SENTINEL}'`,
    `__ow_emit() { printenv "$__ow_n" >/dev/null && printf '%s=%s\\0' "$__ow_n" ${value}; }`,
    "__ow_missing=()",
    `for __ow_n in ${safe.join(" ")}; do __ow_emit || __ow_missing+=("$__ow_n"); done`,
    ...(bash
      ? [
          'if [[ -z ${__ow_rc_seen:-} && -r "$HOME/.bashrc" ]] && (( ${#__ow_missing[@]} )); then',
          '  . "$HOME/.bashrc" >/dev/null 2>&1',
          '  for __ow_n in "${__ow_missing[@]}"; do __ow_emit || :; done',
          "fi",
        ]
      : []),
    // Returning from a login Zsh would run the user's session cleanup (.zlogout).
    bash ? "true" : "exec /bin/sh -c ':'",
  ].join("\n");
}

// Parse the NAME=value\0 records printed after the sentinel. rc noise before the
// sentinel, and anything after the last NUL (a logout file printing), is ignored.
function parseShellEnvDump(output, sentinel = ENV_EXPORT_SENTINEL) {
  const result = {};
  if (!output) return result;
  let text = String(output);
  const marker = `${sentinel}\n`;
  const idx = text.indexOf(marker);
  if (idx === -1) return result;
  text = text.slice(idx + marker.length);
  const records = text.split("\0");
  records.pop(); // unterminated tail
  for (const record of records) {
    const eq = record.indexOf("=");
    if (eq <= 0) continue;
    const name = record.slice(0, eq);
    if (!SHELL_NAME_RE.test(name)) continue;
    result[name] = record.slice(eq + 1);
  }
  return result;
}

function isTrustedLoginShell(shell) {
  return typeof shell === "string" && TRUSTED_LOGIN_SHELL_SET.has(shell);
}

function passwdLoginShell() {
  try {
    return os.userInfo().shell || "";
  } catch {
    return "";
  }
}

function resolveLoginShell(
  env = process.env,
  existsSync = fs.existsSync,
  passwdShell = passwdLoginShell()
) {
  if (env.SHELL) {
    return isTrustedLoginShell(env.SHELL) && existsSync(env.SHELL) ? env.SHELL : null;
  }
  if (isTrustedLoginShell(passwdShell) && existsSync(passwdShell)) return passwdShell;
  // Do not probe zsh/bash when passwd is missing — a bash user must not get ~/.zshrc.
  return null;
}

function loginShellChildEnv(env, shell) {
  const child = {
    HOME: env.HOME,
    ZDOTDIR: env.ZDOTDIR,
    XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
    PATH: env.PATH,
    USER: env.USER,
    LOGNAME: env.LOGNAME,
    SHELL: shell,
    TERM: "dumb",
    LANG: env.LANG || "C.UTF-8",
  };
  for (const key of Object.keys(child)) {
    if (child[key] == null) delete child[key];
  }
  return child;
}

function coalesceResolvedSecret(raw, resolved) {
  if (typeof resolved === "string") {
    const trimmed = resolved.trim();
    return isEnvRef(trimmed) ? "" : trimmed;
  }
  return isEnvRef(raw || "") ? "" : raw || "";
}

async function importMissingSecretsFromLoginShell({
  secretNames,
  env = process.env,
  platform = process.platform,
  execFileSync,
  execFile,
  existsSync = fs.existsSync,
  passwdShell = passwdLoginShell(),
  importedSet,
  canImport,
} = {}) {
  if (platform === "win32") return { imported: [], reason: "win32" };
  const names = (secretNames || []).filter((name) => name && !env[name]);
  if (names.length === 0) return { imported: [], reason: "none-missing" };

  const shell = resolveLoginShell(env, existsSync, passwdShell);
  if (!shell) return { imported: [], reason: "no-trusted-shell" };

  // Zsh reads its normal startup files. Bash loads its login files in the
  // script so we can detect whether they included .bashrc.
  const args = [
    ...(/bash$/.test(shell) ? ["--noprofile"] : []),
    "-ilc",
    buildShellImportScript(shell, names),
  ];
  const opts = {
    encoding: "utf8",
    timeout: 1500,
    killSignal: "SIGKILL",
    maxBuffer: 2 * 1024 * 1024,
    env: loginShellChildEnv(env, shell),
  };

  let output = "";
  try {
    if (execFileSync) {
      output = execFileSync(shell, args, opts) || "";
    } else if (execFile) {
      const result = await execFile(shell, args, opts);
      output = (result && result.stdout) || result || "";
    } else {
      const execution = execFileAsync(shell, args, opts);
      // A profile may prompt even though a desktop launch has no input to supply.
      execution.child.stdin.end();
      const { stdout } = await execution;
      output = stdout || "";
    }
  } catch {
    return { imported: [], reason: "exec-failed" };
  }

  const parsed = parseShellEnvDump(output, ENV_EXPORT_SENTINEL);
  const imported = [];
  for (const name of names) {
    // Checked again now the shell has answered: a key saved meanwhile wins.
    const stillMissing = canImport ? canImport(name) : !env[name];
    if (parsed[name] && stillMissing) {
      // Record before mutating env so a concurrent .env write cannot persist it.
      if (importedSet) importedSet.add(name);
      env[name] = parsed[name];
      imported.push(name);
    }
  }
  return { imported, reason: "ok" };
}

module.exports = {
  isEnvRef,
  envRefName,
  resolveEnvRef,
  buildShellImportScript,
  parseShellEnvDump,
  isTrustedLoginShell,
  resolveLoginShell,
  loginShellChildEnv,
  coalesceResolvedSecret,
  usableSecret,
  classifySecretInput,
  ENV_REF_RE,
  ENV_EXPORT_SENTINEL,
  TRUSTED_LOGIN_SHELLS,
  importMissingSecretsFromLoginShell,
};
