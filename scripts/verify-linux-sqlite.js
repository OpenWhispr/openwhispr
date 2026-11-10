#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { compareVersions } = require("../src/helpers/parakeetCapability");

// Use the packaged Electron ABI and SQLite, including the FTS5 initialization
// that raised SIGILL before the first window on CPUs without AVX2 (#3038). The
// schema and search mirror notes_fts in src/helpers/database.js.
const probe = String.raw`
const assert = require("node:assert/strict");
const Database = require(process.argv[1]);
const filename = process.argv[2];
assert.ok(process.versions.electron);
const db = new Database(filename);
assert.equal(db.pragma("journal_mode = WAL", { simple: true }), "wal");
db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT, content TEXT)");
db.exec("CREATE VIRTUAL TABLE notes_fts USING fts5(title, content, content='notes', content_rowid='id')");
db.exec("CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content); END");
db.exec("CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content); INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content); END");
db.exec("CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content); END");
const search = db.prepare("SELECT n.content FROM notes n JOIN notes_fts ON notes_fts.rowid = n.id WHERE notes_fts MATCH ? ORDER BY notes_fts.rank");
const text = "baseline Grüße 日本語 🧪";
db.prepare("INSERT INTO notes (title, content) VALUES ('first', ?), ('second', 'removed')").run(text);
assert.equal(search.get("baseline").content, text);
db.exec("UPDATE notes SET title = 'renamed' WHERE id = 1");
assert.equal(search.get("renamed").content, text);
assert.equal(search.get("first"), undefined);
db.exec("DELETE FROM notes WHERE id = 2");
assert.equal(search.get("removed"), undefined);
assert.equal(db.prepare("SELECT json_extract('{\"ok\":true}', '$.ok') AS value").get().value, 1);
assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
db.close();
const reopened = new Database(filename, { readonly: true });
assert.equal(reopened.prepare("SELECT content FROM notes").get().content, text);
reopened.close();
console.log("Packaged SQLite database, WAL, FTS5, JSON and persistence passed");
`;

// The addon links the build host's glibc, and the probe runs on that same glibc,
// so only its symbol versions show it would fail to load on Ubuntu 22.04 (#3114).
const MAX_GLIBC = "2.35";
const GLIBC_SYMBOL = /\(?GLIBC_([0-9][0-9.]*)\)?\s+(\S+)$/gm;

function findNewerGlibcSymbols(dynamicSymbols) {
  return [
    ...new Set(
      Array.from(dynamicSymbols.matchAll(GLIBC_SYMBOL))
        .filter(([, version]) => compareVersions(version, MAX_GLIBC) > 0)
        .map(([, version, symbol]) => `${symbol}@GLIBC_${version}`)
    ),
  ];
}

function assertNoNewerGlibcSymbols(addonPath) {
  const dynamicSymbols = execFileSync("objdump", ["-T", addonPath], { encoding: "utf8" });
  const found = findNewerGlibcSymbols(dynamicSymbols);
  if (found.length > 0) {
    throw new Error(
      `afterPack: ${addonPath} needs a glibc newer than ${MAX_GLIBC}, so the app would not start on Ubuntu 22.04: ${found.slice(0, 10).join(", ")}`
    );
  }
}

// Covers paths the probe never runs. AVX and AVX2 mnemonics start with "v"; the
// rest are the VEX-encoded BMI instructions that x86-64-v3 compilers also emit.
const AVX_INSTRUCTION =
  /^\s*[0-9a-f]+:\s+(v[a-z0-9]+|(?:andn|bextr|blsi|blsmsk|blsr|bzhi|mulx|pdep|pext|rorx|sarx|shlx|shrx)[lq]?)\b/gm;

function findAvxInstructions(disassembly) {
  return [...new Set(Array.from(disassembly.matchAll(AVX_INSTRUCTION), (match) => match[1]))];
}

function assertNoAvxInstructions(addonPath) {
  const disassembly = execFileSync("objdump", ["-d", "--no-show-raw-insn", addonPath], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  const found = findAvxInstructions(disassembly);
  if (found.length > 0) {
    throw new Error(
      `afterPack: ${addonPath} contains instructions CPUs without AVX2 lack: ${found.slice(0, 10).join(", ")}`
    );
  }
}

function runProbe(binary, sqlite, cpu, timeoutMs) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-sqlite-baseline-"));
  try {
    console.log(`  afterPack: checking packaged SQLite on ${cpu}`);
    execFileSync(
      "qemu-x86_64",
      ["-cpu", cpu, binary, "-e", probe, sqlite, path.join(scratch, "Grüße.db")],
      {
        cwd: scratch,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: "inherit",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      }
    );
  } catch (error) {
    const reason = error.code || error.signal || `exit ${error.status}`;
    throw new Error(
      `afterPack: packaged SQLite failed on ${cpu} (${reason}). SIGILL or ETIMEDOUT means it uses instructions this CPU lacks: qemu can hang after the fault, so do not rerun or raise the timeout.`,
      { cause: error }
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function verifyLinuxSqliteBaseline(
  appDir,
  executableName = "open-whispr-app",
  { timeoutMs = 45000 } = {}
) {
  const binary = path.resolve(appDir, executableName);
  const sqlite = path.resolve(appDir, "resources", "app.asar", "node_modules", "better-sqlite3");
  const addon = path.resolve(
    appDir,
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node"
  );
  assertNoNewerGlibcSymbols(addon);
  assertNoAvxInstructions(addon);
  for (const cpu of ["Nehalem", "IvyBridge", "Haswell,-avx2"]) {
    runProbe(binary, sqlite, cpu, timeoutMs);
  }
}

// CI must opt in or out explicitly, so a dropped or misspelled variable cannot
// ship an unchecked build. Elsewhere the check needs qemu, so it stays optional.
function shouldVerifyLinuxSqliteBaseline(platform, arch, env = process.env) {
  if (platform !== "linux" || arch !== "x64") return false;
  const setting = env.OPENWHISPR_VERIFY_SQLITE_BASELINE;
  if (setting === "1") return true;
  if (env.CI && setting !== "0") {
    throw new Error(
      "afterPack: set OPENWHISPR_VERIFY_SQLITE_BASELINE to 1 for Linux x64 CI builds (0 skips the packaged SQLite CPU check)"
    );
  }
  console.log("  afterPack: skipping packaged SQLite CPU check");
  return false;
}

if (require.main === module) {
  if (!process.argv[2]) {
    console.error("Usage: node scripts/verify-linux-sqlite.js <app directory> [executable name]");
    process.exitCode = 1;
  } else {
    try {
      verifyLinuxSqliteBaseline(process.argv[2], process.argv[3]);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

exports.findAvxInstructions = findAvxInstructions;
exports.findNewerGlibcSymbols = findNewerGlibcSymbols;
exports.shouldVerifyLinuxSqliteBaseline = shouldVerifyLinuxSqliteBaseline;
exports.verifyLinuxSqliteBaseline = verifyLinuxSqliteBaseline;
