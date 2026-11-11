const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const main = fs.readFileSync(path.join(__dirname, "../../main.js"), "utf8");
const start = main.indexOf("function registerOpenWhisprProtocol() {");
assert.notEqual(start, -1);
const source = main.slice(start, main.indexOf("\n}\n", start) + 2);

function register(platform, alreadyDefault, appArgs = []) {
  const writes = [];
  const restored = [];
  const result = vm.runInNewContext(`(${source})()`, {
    OAUTH_PROTOCOL: "openwhispr",
    process: { platform, execPath: "/app/OpenWhispr" },
    app: {
      isDefaultProtocolClient(protocol) {
        assert.equal(platform, "darwin");
        assert.equal(protocol, "openwhispr");
        return alreadyDefault;
      },
      setAsDefaultProtocolClient(...args) {
        assert.ok(!alreadyDefault, "must not repeat an existing macOS registration");
        writes.push(args);
        return true;
      },
    },
    getDefaultHtmlHandler: () => "browser.desktop",
    getProtocolAppArgs: () => appArgs,
    restoreHtmlHandlerIfChanged: (handler) => restored.push(handler),
  });
  return { result, writes, restored };
}

test("macOS startup does not repeat an existing protocol registration", () => {
  assert.deepEqual(register("darwin", true), { result: true, writes: [], restored: [] });
});

test("macOS still registers the sign-in protocol when it is not the default", () => {
  assert.deepEqual(register("darwin", false).writes, [["openwhispr"]]);
});

test("Windows keeps the executable and script arguments for development registration", () => {
  assert.deepEqual(register("win32", false, ["/app/main.js"]).writes, [
    ["openwhispr", "/app/OpenWhispr", ["/app/main.js"]],
  ]);
});

test("Linux keeps its HTML handler restoration after protocol registration", () => {
  assert.deepEqual(register("linux", false), {
    result: true,
    writes: [["openwhispr"]],
    restored: ["browser.desktop"],
  });
});
