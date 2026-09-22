const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createClient() {
  const context = vm.createContext({
    module: { exports: {} },
    __dirname: path.resolve("src/helpers"),
    process,
    setTimeout,
    clearTimeout,
    require(name) {
      if (name === "electron")
        return {
          app: { getPath: () => "/tmp" },
          utilityProcess: {
            fork() {
              throw new Error("must not spawn an unused worker");
            },
          },
        };
      if (name === "./debugLogger") return { warn() {}, info() {} };
      return require(name);
    },
  });
  vm.runInContext(
    fs.readFileSync(path.resolve("src/helpers/onnxWorkerClient.js"), "utf8"),
    context
  );
  return context.module.exports;
}

test("unloading unused text does not spawn a worker", async () => {
  const client = createClient();
  await client.request("text.unload", {});
  assert.equal(client.child, null);
});

test("unloading after worker exit succeeds without restarting it", async () => {
  const client = createClient();
  const generation = client.generation;
  client._onExit(0);
  assert.equal(client.generation, generation + 1);
  await client.request("text.unload", {});
  assert.equal(client.child, null);
});
