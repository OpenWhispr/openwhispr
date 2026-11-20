const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { resolveProtocolAppPath } = require("../../src/helpers/protocolAppPath");

const CWD = path.resolve("/home/user/openwhispr");
const ELECTRON = "/home/user/openwhispr/node_modules/electron/dist/electron";

test("takes the app path right after the executable", () => {
  assert.equal(resolveProtocolAppPath([ELECTRON, "."], CWD), CWD);
  assert.equal(resolveProtocolAppPath([ELECTRON, "/opt/app"], CWD), path.resolve("/opt/app"));
});

test("skips a Chromium flag before the app path", () => {
  assert.equal(resolveProtocolAppPath([ELECTRON, "--ozone-platform=x11", "."], CWD), CWD);
});

test("skips several flags and ignores app args after the path", () => {
  assert.equal(
    resolveProtocolAppPath(
      [ELECTRON, "--remote-debugging-port=9222", "--ozone-platform=x11", "/opt/app", "--hidden"],
      CWD
    ),
    path.resolve("/opt/app")
  );
});

test("falls back to the working directory without an app path", () => {
  assert.equal(resolveProtocolAppPath([ELECTRON], CWD), CWD);
  assert.equal(resolveProtocolAppPath([ELECTRON, "--ozone-platform=x11"], CWD), CWD);
  assert.equal(resolveProtocolAppPath([], CWD), CWD);
});
