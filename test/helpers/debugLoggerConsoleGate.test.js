const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const loggerPath = require.resolve("../../src/helpers/debugLogger.js");
const originalLoad = Module._load;

// Load a fresh debugLogger singleton with electron's `app` mocked and the
// process/env shaped for the scenario under test.
function loadLogger({ isPackaged, argv = [], env = {} } = {}) {
  const prevArgv = process.argv;
  const prevEnv = {
    OPENWHISPR_LOG_LEVEL: process.env.OPENWHISPR_LOG_LEVEL,
    LOG_LEVEL: process.env.LOG_LEVEL,
    NODE_ENV: process.env.NODE_ENV,
  };

  // Start from a clean slate so a debug-level shell running the suite can't
  // force console logging on and mask a regression.
  delete process.env.OPENWHISPR_LOG_LEVEL;
  delete process.env.LOG_LEVEL;
  delete process.env.NODE_ENV;
  Object.assign(process.env, env);
  process.argv = ["node", "main.js", ...argv];

  delete require.cache[loggerPath];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return { app: { isPackaged } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(loggerPath);
  } finally {
    Module._load = originalLoad;
    process.argv = prevArgv;
    delete process.env.OPENWHISPR_LOG_LEVEL;
    delete process.env.LOG_LEVEL;
    delete process.env.NODE_ENV;
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

function captureConsole(fn) {
  const calls = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => calls.push(["log", ...args]);
  console.warn = (...args) => calls.push(["warn", ...args]);
  console.error = (...args) => calls.push(["error", ...args]);
  try {
    fn();
  } finally {
    Object.assign(console, original);
  }
  return calls;
}

test("packaged build keeps main-process logs off the console (#1075/#1058)", () => {
  const logger = loadLogger({ isPackaged: true });
  assert.equal(logger.consoleLoggingEnabled, false);

  const streamed = [];
  logger.logStream = { write: (line) => streamed.push(line) };

  // The exact line the reporter saw leaking into the focused window.
  const calls = captureConsole(() => {
    logger.info("CLI bridge started", { port: 8200 }, "cli-bridge");
    logger.warn("something", {}, "meeting");
    logger.error("boom");
  });

  assert.deepEqual(calls, [], "nothing reaches stdout/stderr in a packaged build");
  assert.equal(streamed.length, 3, "logs still go to the file stream");
  assert.match(streamed[0], /\[INFO\]\[cli-bridge\] CLI bridge started/);
});

test("dev build still writes logs to the console", () => {
  const logger = loadLogger({ isPackaged: false });
  assert.equal(logger.consoleLoggingEnabled, true);

  const calls = captureConsole(() => {
    logger.info("CLI bridge started", { port: 8200 }, "cli-bridge");
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "log");
});

test("explicit --log-level re-enables console in a packaged build", () => {
  const logger = loadLogger({ isPackaged: true, argv: ["--log-level=info"] });
  assert.equal(logger.consoleLoggingEnabled, true);

  const calls = captureConsole(() => {
    logger.info("opted in");
  });

  assert.equal(calls.length, 1);
});

test("explicit OPENWHISPR_LOG_LEVEL re-enables console in a packaged build", () => {
  const logger = loadLogger({ isPackaged: true, env: { OPENWHISPR_LOG_LEVEL: "debug" } });
  assert.equal(logger.consoleLoggingEnabled, true);
});
