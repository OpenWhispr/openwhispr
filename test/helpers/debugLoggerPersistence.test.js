const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// File logging used to be gated on debug mode, so warnings and errors were never
// written to disk on a default install — which is why a subsystem could fail for
// days with "no errors" to show for it. Severity decides persistence now, and
// rotation is what makes that safe to leave on.
const debugLogger = require("../../src/helpers/debugLogger");
const { DebugLogger } = debugLogger;

function makeLogger(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-logtest-"));
  const logger = new DebugLogger({ level: "info", ...options });
  logger._resolveLogsDir = () => dir;
  return { logger, dir };
}

function readLog(logger) {
  return fs.readFileSync(logger.getLogPath(), "utf8");
}

function logFiles(dir) {
  return fs.readdirSync(dir).filter((name) => /^debug-.*\.log$/.test(name));
}

test("warn and error persist at the default info level", async () => {
  const { logger } = makeLogger();

  logger.warn("a warning worth keeping");
  logger.error("an error worth keeping");
  await logger.close();

  const contents = readLog(logger);
  assert.match(contents, /a warning worth keeping/);
  assert.match(contents, /an error worth keeping/);
});

test("debug and info do not persist at the default info level", async () => {
  const { logger, dir } = makeLogger();

  logger.debug("noisy debug line");
  logger.info("chatty info line");

  assert.deepEqual(logFiles(dir), [], "nothing below warn should open a log file");
});

test("debug persists when the log level asks for it", async () => {
  const { logger } = makeLogger({ level: "debug" });

  logger.debug("noisy debug line");
  await logger.close();

  assert.match(readLog(logger), /noisy debug line/);
});

test("initialization prunes to the newest N log files", async () => {
  const { logger, dir } = makeLogger({ maxFiles: 3 });

  // All well inside the retention window, so this exercises the count backstop
  // rather than the age bound (which has its own test).
  const now = Date.now();
  const names = [];
  for (let i = 0; i < 6; i += 1) {
    const name = `debug-2026-01-0${i + 1}T00-00-00-000Z.log`;
    names.push(name);
    const full = path.join(dir, name);
    fs.writeFileSync(full, "old\n");
    const seconds = (now - (6 - i) * 3600 * 1000) / 1000;
    fs.utimesSync(full, seconds, seconds);
  }
  fs.writeFileSync(path.join(dir, "onnx-worker.log"), "not ours\n");

  logger.warn("open a fresh log");
  await logger.close();

  const remaining = logFiles(dir).sort();
  assert.equal(remaining.length, 3, "the newest N-1 plus the new one");
  assert.ok(remaining.includes(names[5]), "newest kept");
  assert.ok(!remaining.includes(names[0]), "oldest pruned");
  assert.ok(fs.existsSync(path.join(dir, "onnx-worker.log")), "other logs are left alone");
});

test("a missing logs directory is created rather than throwing", async () => {
  const { logger, dir } = makeLogger();
  fs.rmSync(dir, { recursive: true, force: true });

  assert.doesNotThrow(() => logger.warn("still fine"));
  await logger.close();

  assert.match(readLog(logger), /still fine/);
});

test("passing the size cap rotates to a new file", async () => {
  const { logger, dir } = makeLogger({ maxBytes: 200, maxFiles: 10 });

  for (let i = 0; i < 20; i += 1) {
    logger.warn(`line ${i} padded out to force a rotation ${"x".repeat(40)}`);
  }
  await logger.close();

  assert.ok(logFiles(dir).length > 1, "the cap must roll the file over");
});

test("a repeating warning is throttled instead of flooding the file", async () => {
  const { logger } = makeLogger();

  for (let i = 0; i < 200; i += 1) {
    logger.warn("system audio websocket is null");
  }
  await logger.close();

  const contents = readLog(logger);
  const written = contents.match(/system audio websocket is null/g) || [];
  assert.ok(written.length < 20, `expected throttling, got ${written.length} lines`);
  assert.match(contents, /suppressed \d+ repeats/);
});

test("distinct messages are not throttled by a noisy neighbour", async () => {
  const { logger } = makeLogger();

  for (let i = 0; i < 100; i += 1) {
    logger.warn("flooding message");
  }
  logger.warn("a different, rare problem");
  await logger.close();

  assert.match(readLog(logger), /a different, rare problem/);
});

test("logging outside Electron neither throws nor opens a file", async () => {
  // Under plain node, require("electron") is a string and `app` is undefined.
  // Severity-gated persistence makes this path reachable in every test run.
  assert.doesNotThrow(() => {
    debugLogger.warn("no electron app here");
    debugLogger.error("nor here");
  });
  assert.equal(debugLogger.getLogPath(), null);
});
