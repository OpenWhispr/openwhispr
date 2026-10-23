// Resolve API keys from the process environment and (on Unix) from a login
// shell, so keys exported in ~/.zshrc / ~/.bashrc work even when the app is
// launched from a desktop entry instead of a terminal.
//
// Stored Settings values still win. This module only fills empty keys and
// expands $VAR / ${VAR} references at read time. Callers must not persist
// imported names — EnvironmentManager tracks them and skips them on write.

const fs = require("fs");
const os = require("os");
const { promisify } = require("util");
const execFileAsync = promisify(require("child_process").execFile);
const { ENV_REF_RE, isEnvRef, envRefName, usableSecret, classifySecretInput } = require("./envRef.cjs");

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

function unquoteShellValue(raw) {
  const s = raw.trim();
  if (!s) return "";

  if (s.startsWith("$'")) {
    let out = "";
    for (let i = 2; i < s.length; i++) {
      const ch = s[i];
      if (ch === "'" && s[i - 1] !== "\\") break;
      if (ch === "\\" && i + 1 < s.length) {
        const next = s[i + 1];
        const escapes = { n: "\n", t: "\t", r: "\r", "'": "'", "\\": "\\" };
        out += Object.prototype.hasOwnProperty.call(escapes, next) ? escapes[next] : next;
        i++;
        continue;
      }
      out += ch;
    }
    return out;
  }

  if (s[0] === "'") {
    const end = s.indexOf("'", 1);
    return end === -1 ? s.slice(1) : s.slice(1, end);
  }

  if (s[0] === '"') {
    let out = "";
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "\\" && i + 1 < s.length) {
        out += s[i + 1];
        i++;
        continue;
      }
      if (s[i] === '"') break;
      out += s[i];
    }
    return out;
  }

  return s.replace(/\s+#.*$/, "").split(/\s/)[0];
}

// Parse `export -p` / `declare -x` output from bash or zsh.
function parseExportP(output, sentinel) {
  const result = {};
  if (!output) return result;
  let text = String(output);
  if (sentinel) {
    const idx = text.indexOf(sentinel);
    if (idx === -1) return result;
    text = text.slice(idx + sentinel.length);
  }
  const lineRe = /^(?:declare -x |export )?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/\r$/, "");
    const match = line.match(lineRe);
    if (!match) continue;
    result[match[1]] = unquoteShellValue(match[2]);
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

function resolveLoginShell(env = process.env, existsSync = fs.existsSync, passwdShell = passwdLoginShell()) {
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
} = {}) {
  if (platform === "win32") return { imported: [], reason: "win32" };
  const names = (secretNames || []).filter((name) => name && !env[name]);
  if (names.length === 0) return { imported: [], reason: "none-missing" };

  const shell = resolveLoginShell(env, existsSync, passwdShell);
  if (!shell) return { imported: [], reason: "no-trusted-shell" };

  // -ilc so ~/.zshrc / ~/.bashrc are sourced (login non-interactive -lc skips them).
  const args = ["-ilc", "printf '%s\\n' '" + ENV_EXPORT_SENTINEL + "'; export -p"];
  const opts = {
    encoding: "utf8",
    timeout: 1500,
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
      const { stdout } = await execFileAsync(shell, args, opts);
      output = stdout || "";
    }
  } catch {
    return { imported: [], reason: "exec-failed" };
  }

  const parsed = parseExportP(output, ENV_EXPORT_SENTINEL);
  const imported = [];
  for (const name of names) {
    if (parsed[name]) {
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
  parseExportP,
  unquoteShellValue,
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
