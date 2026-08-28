const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Regression: the System Info header logged platform/node/electron but not the
// app version, so the first triage question ("which release is this?") was
// unanswerable from a customer debug log (CUS-113 had to infer 1.8.x from the
// Electron version).
test("debug log System Info header includes the app version", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "debugLogger-test-"));
  const electronPath = require.resolve("electron");
  const debugLoggerPath = require.resolve("../../src/helpers/debugLogger.js");
  const originalElectronCache = require.cache[electronPath];
  const originalLoggerCache = require.cache[debugLoggerPath];

  require.cache[electronPath] = {
    exports: {
      app: {
        isReady: () => true,
        getPath: () => tempDir,
        getAppPath: () => "/mock/app",
        getVersion: () => "9.9.9-test",
      },
    },
  };
  delete require.cache[debugLoggerPath];

  try {
    const debugLogger = require(debugLoggerPath);
    debugLogger.initializeFileLogging();

    const logFile = debugLogger.getLogPath();
    const stream = debugLogger.logStream;
    if (typeof stream.fd !== "number") {
      await new Promise((resolve) => stream.once("open", resolve));
    }
    debugLogger.close();
    await new Promise((resolve) => stream.once("finish", resolve));

    const contents = fs.readFileSync(logFile, "utf8");
    assert.match(contents, /System Info/);
    assert.match(contents, /appVersion/);
    assert.match(contents, /9\.9\.9-test/);
  } finally {
    delete require.cache[debugLoggerPath];
    if (originalLoggerCache) require.cache[debugLoggerPath] = originalLoggerCache;
    if (originalElectronCache) require.cache[electronPath] = originalElectronCache;
    else delete require.cache[electronPath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
