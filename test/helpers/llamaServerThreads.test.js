const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");

const LlamaServerManager = require("../../src/helpers/llamaServer.js");
const { resolveLlamaThreads } = LlamaServerManager;

const threadsArg = (args) =>
  args.includes("--threads") ? args[args.indexOf("--threads") + 1] : undefined;

test("LLAMA_CPU_THREADS unset or invalid keeps the default of 4", () => {
  for (const value of [undefined, "", "fast", "-2", "1.5"]) {
    assert.equal(resolveLlamaThreads(value), 4, String(value));
  }
});

test("LLAMA_CPU_THREADS=N is used as given, capped at the logical CPU count", () => {
  const cpus = os.availableParallelism();
  assert.equal(resolveLlamaThreads("1"), 1);
  assert.equal(resolveLlamaThreads(` ${cpus} `), cpus);
  assert.equal(resolveLlamaThreads("99999"), cpus);
});

test("threads 0 omits --threads so llama.cpp picks its own default", () => {
  const manager = new LlamaServerManager();
  const args = manager._buildBaseArgs("/models/main.gguf", 8221, {
    threads: resolveLlamaThreads("0"),
  });
  assert.equal(threadsArg(args), undefined);
});

test("--threads is passed through, and stays 4 when no count is given", () => {
  const manager = new LlamaServerManager();
  assert.equal(threadsArg(manager._buildBaseArgs("/m.gguf", 8221, { threads: 2 })), "2");
  assert.equal(threadsArg(manager._buildBaseArgs("/m.gguf", 8221, {})), "4");
});
