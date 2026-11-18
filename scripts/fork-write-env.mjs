#!/usr/bin/env node
// Writes the fork's OAuth client ids into <out>/.env (default: repo root), which
// electron-builder packages as resources/.env (environment.js reads it at start).
//
//   node scripts/fork-write-env.mjs [--out <dir>]
//
// The five values come from the build shell's environment (FORK-BUILD.md maps
// them from Proton Pass). Fail-closed: a missing, empty or unsafe value exits 1
// naming the key and writes nothing. Prints key names only, never values.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FORK_ENV_KEYS = [
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "MICROSOFT_CALENDAR_CLIENT_ID",
  "SLACK_CLIENT_ID",
  "LINEAR_CLIENT_ID",
];

// dotenv would misread whitespace, quotes or # in an unquoted value.
const UNSAFE = /[\s#"'`\\\u0000-\u001f\u007f]/;

// Pure: returns { ok: true, content } or { ok: false, missing, unsafe }.
export function buildForkEnv(env, existing = "") {
  const missing = FORK_ENV_KEYS.filter((key) => !String(env[key] ?? "").trim());
  const unsafe = FORK_ENV_KEYS.filter(
    (key) => !missing.includes(key) && UNSAFE.test(String(env[key]).trim())
  );
  if (missing.length || unsafe.length) return { ok: false, missing, unsafe };

  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const owned = new Set(FORK_ENV_KEYS);
  const kept = existing.split(/\r?\n/).filter((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    return !(match && owned.has(match[1]));
  });
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  const lines = [...kept, ...FORK_ENV_KEYS.map((key) => `${key}=${String(env[key]).trim()}`)];
  return { ok: true, content: lines.join(eol) + eol };
}

function parseOut(argv) {
  const index = argv.indexOf("--out");
  if (index === -1) return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) return null;
  return path.resolve(value);
}

function main(argv, env) {
  const outDir = parseOut(argv);
  if (!outDir) {
    process.stderr.write("fork-write-env: --out needs a directory\n");
    return 1;
  }
  const target = path.join(outDir, ".env");
  const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const built = buildForkEnv(env, existing);
  if (!built.ok) {
    if (built.missing.length) {
      process.stderr.write(`fork-write-env: missing or empty: ${built.missing.join(", ")}\n`);
    }
    if (built.unsafe.length) {
      process.stderr.write(
        `fork-write-env: value has whitespace, quotes, # or control characters: ${built.unsafe.join(", ")}\n`
      );
    }
    return 1;
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(target, built.content);
  process.stdout.write(`fork-write-env: wrote ${FORK_ENV_KEYS.join(", ")} to ${target}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2), process.env));
}
