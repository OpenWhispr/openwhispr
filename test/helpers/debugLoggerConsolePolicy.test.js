const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const loggerPath = require.resolve("../../src/helpers/debugLogger.js");
const dragManagerPath = require.resolve("../../src/helpers/dragManager.js");
const originalLoad = Module._load;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function withRuntime({ platform, argv = [], env = {}, electron }, loadModule) {
  const previousArgv = process.argv;
  const previousEnvironment = {
    LOG_LEVEL: process.env.LOG_LEVEL,
    NODE_ENV: process.env.NODE_ENV,
    OPENWHISPR_LOG_LEVEL: process.env.OPENWHISPR_LOG_LEVEL,
  };

  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  process.argv = ["node", "main.js", ...argv];
  delete process.env.LOG_LEVEL;
  delete process.env.NODE_ENV;
  delete process.env.OPENWHISPR_LOG_LEVEL;
  Object.assign(process.env, env);

  Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === "electron") return electron;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return loadModule();
  } finally {
    Module._load = originalLoad;
    Object.defineProperty(process, "platform", originalPlatform);
    process.argv = previousArgv;
    delete process.env.LOG_LEVEL;
    delete process.env.NODE_ENV;
    delete process.env.OPENWHISPR_LOG_LEVEL;
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value !== undefined) process.env[name] = value;
    }
  }
}

function loadLogger({
  platform,
  isPackaged,
  argv,
  env,
  isReady = false,
  userDataPath = os.tmpdir(),
}) {
  delete require.cache[loggerPath];
  return withRuntime(
    {
      platform,
      argv,
      env,
      electron: {
        app: {
          getAppPath: () => "/openwhispr",
          getPath: () => userDataPath,
          getVersion: () => "9.9.9-test",
          isPackaged,
          isReady: () => isReady,
        },
      },
    },
    () => require(loggerPath)
  );
}

async function captureConsole(run) {
  const calls = [];
  const originalConsole = {
    error: console.error,
    log: console.log,
    warn: console.warn,
  };

  console.error = (...args) => calls.push(["error", ...args]);
  console.log = (...args) => calls.push(["log", ...args]);
  console.warn = (...args) => calls.push(["warn", ...args]);
  try {
    await run();
  } finally {
    Object.assign(console, originalConsole);
  }
  return calls;
}

async function closeLogStream(logger) {
  if (!logger.logStream) return;
  const logStream = logger.logStream;
  logger.logStream = null;
  await new Promise((resolve, reject) => {
    logStream.once("error", reject);
    logStream.end(resolve);
  });
}

test(
  "packaged Windows suppresses main and renderer console logging at the default level",
  async () => {
    const logger = loadLogger({ platform: "win32", isPackaged: true });

    const calls = await captureConsole(() => {
      logger.info("Recording started", { microphone: "Default" }, "audio");
      logger.warn("Recording warning");
      logger.error("Recording failure");
      logger.logEntry({
        level: "info",
        message: "Pipeline timing",
        meta: { roundTripDurationMs: 42 },
        scope: "performance",
        source: "renderer",
      });
    });

    assert.deepEqual(calls, []);
    assert.equal(logger.getLogPath(), null, "default INFO logging remains non-persistent");
  }
);

test("log-level settings never opt a packaged Windows build into console logging", async (t) => {
  const cases = [
    { name: "--log-level", argv: ["--log-level=debug"] },
    {
      name: "OPENWHISPR_LOG_LEVEL=debug",
      env: { OPENWHISPR_LOG_LEVEL: "debug" },
    },
    {
      name: "OPENWHISPR_LOG_LEVEL=info",
      env: { OPENWHISPR_LOG_LEVEL: "info" },
    },
    { name: "LOG_LEVEL", env: { LOG_LEVEL: "debug" } },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const logger = loadLogger({
        platform: "win32",
        isPackaged: true,
        argv: testCase.argv,
        env: testCase.env,
      });

      const calls = await captureConsole(() => logger.info("Configured log level"));

      assert.deepEqual(calls, []);
    });
  }
});

test("--console-logs explicitly enables console logging in packaged Windows", async () => {
  const logger = loadLogger({
    platform: "win32",
    isPackaged: true,
    argv: ["--console-logs"],
  });

  const calls = await captureConsole(() => logger.info("Console diagnostics enabled"));

  assert.deepEqual(calls, [["log", "[INFO] Console diagnostics enabled"]]);
});

test("development and non-Windows packaged builds preserve console logging", async (t) => {
  const cases = [
    { name: "Windows development", platform: "win32", isPackaged: false },
    { name: "packaged macOS", platform: "darwin", isPackaged: true },
    { name: "packaged Linux", platform: "linux", isPackaged: true },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const logger = loadLogger(testCase);

      const calls = await captureConsole(() => logger.info("Existing console behavior"));

      assert.deepEqual(calls, [["log", "[INFO] Existing console behavior"]]);
    });
  }
});

test(
  "packaged Windows retains debug logs in the file sink while suppressing the console",
  async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-debug-logger-"));
    const logger = loadLogger({
      platform: "win32",
      isPackaged: true,
      env: { OPENWHISPR_LOG_LEVEL: "debug" },
      isReady: true,
      userDataPath,
    });

    try {
      const calls = await captureConsole(() => {
        logger.logEntry({
          level: "info",
          message: "Pipeline timing",
          scope: "performance",
          source: "renderer",
        });
      });
      const logPath = logger.getLogPath();
      await closeLogStream(logger);

      assert.deepEqual(calls, []);
      assert.ok(logPath);
      assert.match(
        fs.readFileSync(logPath, "utf8"),
        /\[INFO\]\[performance\]\[renderer\] Pipeline timing/
      );
    } finally {
      await closeLogStream(logger);
      fs.rmSync(userDataPath, { recursive: true, force: true });
    }
  }
);

test("routine window-drag activity obeys the packaged Windows console policy", async () => {
  delete require.cache[loggerPath];
  delete require.cache[dragManagerPath];
  const DragManager = withRuntime(
    {
      platform: "win32",
      electron: {
        app: {
          getAppPath: () => "/openwhispr",
          getPath: () => os.tmpdir(),
          isPackaged: true,
          isReady: () => false,
        },
        screen: {
          getCursorScreenPoint: () => ({ x: 120, y: 80 }),
        },
      },
    },
    () => require(dragManagerPath)
  );
  const dragManager = new DragManager();
  dragManager.setTargetWindow({
    getPosition: () => [100, 50],
    isDestroyed: () => false,
  });

  const calls = await captureConsole(async () => {
    assert.deepEqual(await dragManager.startWindowDrag(), { success: true });
    assert.deepEqual(await dragManager.stopWindowDrag(), { success: true });
  });

  assert.deepEqual(calls, []);
});
