const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DebugLogger } = require("../../src/helpers/debugLogger");
const { estimatePromptTokens, checkPromptFitsContext } = require("../../src/helpers/llamaContext");

const REPO = path.join(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(REPO, relative), "utf8");

// --- the guard -------------------------------------------------------------
// With the context bounded, an oversized prompt has to fail as a clear,
// translated message instead of a raw llama-server error body — or worse, the
// unbounded grind that started all this.

test("token estimates never undercount plain ASCII", () => {
  const text = "a".repeat(3600);
  assert.ok(estimatePromptTokens(text) >= 1000, "an undercount is what lets a prompt through");
});

test("a prompt that fits is allowed through", () => {
  const result = checkPromptFitsContext({ text: "short prompt", contextSize: 32768 });
  assert.equal(result.fits, true);
});

test("a prompt past the context is rejected with a typed code", () => {
  const result = checkPromptFitsContext({ text: "x".repeat(500000), contextSize: 32768 });

  assert.equal(result.fits, false);
  assert.equal(result.code, "LOCAL_CONTEXT_EXCEEDED");
  assert.ok(result.estimatedTokens > result.budgetTokens);
});

test("the budget leaves headroom for the reply", () => {
  const result = checkPromptFitsContext({ text: "x", contextSize: 32768 });
  assert.ok(
    result.budgetTokens < 32768,
    "sending a prompt that exactly fills the context leaves nowhere to answer"
  );
});

// --- wiring ----------------------------------------------------------------
// llamaServer.js requires electron at module scope, so it cannot be constructed
// under node --test; assert the wiring at the source level instead.

const LLAMA_SOURCE = read("src/helpers/llamaServer.js");

test("llama-server is started with an explicit context size", () => {
  assert.match(LLAMA_SOURCE, /"--ctx-size"/);
  assert.match(LLAMA_SOURCE, /resolveContextSize/);
});

test("the resolved context is recorded so callers can budget against it", () => {
  assert.match(LLAMA_SOURCE, /this\.contextSize\s*=/);
});

test("the registry value is never what reaches the server", () => {
  const bridge = read("src/helpers/modelManagerBridge.js");
  assert.doesNotMatch(
    bridge,
    /contextSize:\s*modelInfo\.model\.contextLength/,
    "the registry claims 262144 for a model whose header says 131072"
  );
});

// --- logging ---------------------------------------------------------------

function makeLogger(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-logtest-"));
  const logger = new DebugLogger({ level: "info", ...options });
  logger._resolveLogsDir = () => dir;
  return { logger, dir };
}

const logFiles = (dir) => fs.readdirSync(dir).filter((n) => /^debug-.*\.log$/.test(n));

test("notice persists at the default level so heavy operations are on the record", async () => {
  const { logger } = makeLogger();

  logger.notice("llama-server started", { contextSize: 32768 });
  logger.info("routine chatter");
  await logger.close();

  const contents = fs.readFileSync(logger.getLogPath(), "utf8");
  assert.match(contents, /llama-server started/);
  assert.doesNotMatch(contents, /routine chatter/, "info must still stay out of the file");
});

test("logs older than the retention window are pruned", async () => {
  const { logger, dir } = makeLogger({ retentionDays: 30 });
  const old = path.join(dir, "debug-2020-01-01T00-00-00-000Z.log");
  const recent = path.join(dir, "debug-2020-06-01T00-00-00-000Z.log");
  fs.writeFileSync(old, "old\n");
  fs.writeFileSync(recent, "recent\n");

  const now = Date.now();
  const days = (n) => (now - n * 86400000) / 1000;
  fs.utimesSync(old, days(45), days(45));
  fs.utimesSync(recent, days(5), days(5));

  logger.warn("open a fresh log");
  await logger.close();

  const remaining = logFiles(dir);
  assert.ok(!remaining.includes(path.basename(old)), "45 days old must go");
  assert.ok(remaining.includes(path.basename(recent)), "5 days old must stay");
});

test("a file-count backstop still applies inside the retention window", async () => {
  const { logger, dir } = makeLogger({ retentionDays: 30, maxFiles: 5 });
  const now = Date.now();
  for (let i = 0; i < 12; i += 1) {
    const file = path.join(dir, `debug-2026-01-${String(i + 1).padStart(2, "0")}T00-00-00-000Z.log`);
    fs.writeFileSync(file, "x\n");
    const age = (now - i * 3600000) / 1000;
    fs.utimesSync(file, age, age);
  }

  logger.warn("open a fresh log");
  await logger.close();

  assert.ok(logFiles(dir).length <= 5, `a restart loop must not fill the disk: ${logFiles(dir).length}`);
});
