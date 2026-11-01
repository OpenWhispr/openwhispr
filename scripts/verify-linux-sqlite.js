#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

// Use the packaged Electron ABI and SQLite, including the FTS5 initialization
// that raised SIGILL before the first window on CPUs without AVX2 (#3038).
const probe = String.raw`
const assert = require("node:assert/strict");
const Database = require(process.argv[1]);
const filename = process.argv[2];
assert.ok(process.versions.electron);
const db = new Database(filename);
assert.equal(db.pragma("journal_mode = WAL", { simple: true }), "wal");
db.exec("CREATE VIRTUAL TABLE documents USING fts5(body)");
const text = "baseline Grüße 日本語 🧪";
db.prepare("INSERT INTO documents VALUES (?)").run(text);
assert.equal(db.prepare("SELECT body FROM documents WHERE documents MATCH 'baseline'").get().body, text);
assert.equal(db.prepare("SELECT json_extract('{\"ok\":true}', '$.ok') AS value").get().value, 1);
assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
db.close();
const reopened = new Database(filename, { readonly: true });
assert.equal(reopened.prepare("SELECT body FROM documents").get().body, text);
reopened.close();
console.log("Packaged SQLite database, WAL, FTS5, JSON and persistence passed");
`;

function verifyLinuxSqliteBaseline(appDir, executableName = "open-whispr-app") {
  const binary = path.resolve(appDir, executableName);
  const sqlite = path.resolve(appDir, "resources", "app.asar", "node_modules", "better-sqlite3");
  for (const cpu of ["Nehalem", "IvyBridge", "Haswell,-avx2"]) {
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
          timeout: 45000,
          killSignal: "SIGKILL",
        }
      );
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

if (require.main === module) {
  if (!process.argv[2]) {
    console.error("Usage: node scripts/verify-linux-sqlite.js <app directory> [executable name]");
    process.exitCode = 1;
  } else {
    try {
      verifyLinuxSqliteBaseline(process.argv[2], process.argv[3]);
    } catch (error) {
      console.error(`Linux SQLite compatibility verification failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

exports.verifyLinuxSqliteBaseline = verifyLinuxSqliteBaseline;
