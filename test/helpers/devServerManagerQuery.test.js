const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Window routes ride on the URL's query: the control panel's panel=true, and
// extra flags such as the agent window's agent=true, in both builds.
const originalLoad = Module._load;
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") return { app: { getAppPath: () => "/app" } };
  return originalLoad.call(this, request, parent, isMain);
};
// Kept installed: getAppFilePath requires electron when it is called.
const DevServerManager = require("../../src/helpers/devServerManager");
test.after(() => {
  Module._load = originalLoad;
});

function withNodeEnv(t, value) {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  t.after(() => {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  });
}

test("development URLs carry the window's route flags", (t) => {
  withNodeEnv(t, "development");
  const base = DevServerManager.DEV_SERVER_URL;

  assert.equal(DevServerManager.getAppUrl(false), base);
  assert.equal(DevServerManager.getAppUrl(true), `${base}?panel=true`);
  assert.equal(DevServerManager.getAppUrl(false, { agent: "true" }), `${base}?agent=true`);
});

test("packaged builds pass the same flags to loadFile", (t) => {
  withNodeEnv(t, "production");

  assert.deepEqual(DevServerManager.getAppFilePath(false).query, {});
  assert.deepEqual(DevServerManager.getAppFilePath(true).query, { panel: "true" });
  assert.deepEqual(DevServerManager.getAppFilePath(false, { agent: "true" }).query, {
    agent: "true",
  });
  assert.equal(DevServerManager.getAppUrl(false, { agent: "true" }), null);
});
