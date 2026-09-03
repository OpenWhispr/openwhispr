const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const LlamaServerManager = require("../../src/helpers/llamaServer");
const { parseServerContextSize } = require("../../src/helpers/llamaServer");

// The prompt budget is enforced against `contextSize`, so an estimator that
// drifts high refuses prompts the server would have accepted — which is exactly
// how "Prompt is too long: 2654 against a budget of 1228" reached a user. The
// server knows the real answer; ask it rather than trusting the estimate.

test("reads the context the server actually created", () => {
  const body = JSON.stringify({
    default_generation_settings: { n_ctx: 16384, params: {} },
    total_slots: 4,
  });

  assert.equal(parseServerContextSize(body), 16384);
});

test("anything that is not a positive whole context is ignored", () => {
  for (const body of [
    "{}",
    '{"default_generation_settings":{}}',
    '{"default_generation_settings":{"n_ctx":0}}',
    '{"default_generation_settings":{"n_ctx":-1}}',
    '{"default_generation_settings":{"n_ctx":"16384"}}',
    '{"default_generation_settings":{"n_ctx":1.5}}',
    '{"default_generation_settings":null}',
    "not json at all",
    "",
  ]) {
    assert.equal(parseServerContextSize(body), null, body);
  }
});

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("the server's own context replaces the estimate", async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.url, "/props");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ default_generation_settings: { n_ctx: 4096 } }));
    },
    async (port) => {
      const manager = new LlamaServerManager();
      manager.port = port;
      manager.contextSize = 32768;

      await manager.reconcileContextSize();

      assert.equal(manager.contextSize, 4096, "the estimate was wrong; the server was not");
    }
  );
});

test("a server that cannot answer leaves the estimate alone", async () => {
  // Reconciliation runs after the server is already healthy. It must never turn
  // a working start into a failed one.
  for (const handler of [
    (req, res) => {
      res.writeHead(500);
      res.end("nope");
    },
    (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{ this is not json");
    },
    (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ default_generation_settings: { n_ctx: null } }));
    },
  ]) {
    await withServer(handler, async (port) => {
      const manager = new LlamaServerManager();
      manager.port = port;
      manager.contextSize = 32768;

      await manager.reconcileContextSize();

      assert.equal(manager.contextSize, 32768);
    });
  }
});

test("nothing listening leaves the estimate alone and does not throw", async () => {
  const manager = new LlamaServerManager();
  // Port 1 is privileged and never has llama-server on it.
  manager.port = 1;
  manager.contextSize = 8192;

  await manager.reconcileContextSize();

  assert.equal(manager.contextSize, 8192);
});
