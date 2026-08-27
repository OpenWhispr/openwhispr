const test = require("node:test");
const assert = require("node:assert/strict");
const DevServerManager = require("../../src/helpers/devServerManager.js");

test("DEV_SERVER_PORT and DEV_SERVER_URL are defined and valid", () => {
  assert.equal(typeof DevServerManager.DEV_SERVER_PORT, "number");
  assert.ok(DevServerManager.DEV_SERVER_PORT > 0);
  assert.ok(DevServerManager.DEV_SERVER_URL.startsWith("http://localhost:"));
});

test("parseDevServerPort validates integer port ranges", () => {
  const originalEnv = process.env.OPENWHISPR_DEV_SERVER_PORT;
  try {
    delete process.env.OPENWHISPR_DEV_SERVER_PORT;
    delete process.env.VITE_DEV_SERVER_PORT;
    assert.equal(DevServerManager.parseDevServerPort(), 5183);

    process.env.OPENWHISPR_DEV_SERVER_PORT = "8080";
    assert.equal(DevServerManager.parseDevServerPort(), 8080);

    process.env.OPENWHISPR_DEV_SERVER_PORT = "invalid";
    assert.equal(DevServerManager.parseDevServerPort(), 5183);

    process.env.OPENWHISPR_DEV_SERVER_PORT = "-1";
    assert.equal(DevServerManager.parseDevServerPort(), 5183);

    process.env.OPENWHISPR_DEV_SERVER_PORT = "70000";
    assert.equal(DevServerManager.parseDevServerPort(), 5183);
  } finally {
    if (originalEnv !== undefined) {
      process.env.OPENWHISPR_DEV_SERVER_PORT = originalEnv;
    } else {
      delete process.env.OPENWHISPR_DEV_SERVER_PORT;
    }
  }
});

test("getAppUrl produces correct URLs in development", () => {
  const originalEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "development";
    assert.equal(DevServerManager.getAppUrl(false), DevServerManager.DEV_SERVER_URL);
    assert.equal(
      DevServerManager.getAppUrl(true),
      `${DevServerManager.DEV_SERVER_URL}?panel=true`
    );

    process.env.NODE_ENV = "production";
    assert.equal(DevServerManager.getAppUrl(false), null);
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});

test("waitForDevServer handles unreachable server URLs gracefully", async () => {
  // Probe a port where nothing is listening with 1 attempt and 10ms delay
  const ready = await DevServerManager.waitForDevServer(
    "http://127.0.0.1:59999/",
    1,
    10
  );
  assert.equal(ready, false);
});
