const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { CancellationToken, CancellationError } = require("builder-util-runtime");

for (const streaming of [false, true]) {
  test(`aborting a feed request settles it${streaming ? " during its response" : " before headers"}`, async (t) => {
    const originalLoad = Module._load;
    const request = new EventEmitter();
    request.end = () => {};
    // Electron closes an explicitly aborted request without a rejecting error.
    request.abort = () => request.emit("close");
    Module._load = function (name, parent, isMain) {
      if (name === "electron") {
        return { session: { fromPartition: () => ({}) }, net: { request: () => request } };
      }
      return originalLoad.call(this, name, parent, isMain);
    };
    t.after(() => (Module._load = originalLoad));
    const UpdateHttpExecutor = require("../../src/helpers/updateHttpExecutor");
    const executor = new UpdateHttpExecutor();
    const pending = executor.request({
      protocol: "http:",
      hostname: "localhost",
      path: "/latest.yml",
    });
    const rejected = assert.rejects(pending, CancellationError);
    if (streaming) {
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = {};
      request.emit("response", response);
      response.write("version: ");
      t.after(() => response.destroy());
    }
    request.emit("close");
    assert.equal(executor.requests.size, 1);
    executor.abortRequests();
    await rejected;
    assert.equal(executor.requests.size, 0);
  });
}

for (const redirect of [false, true]) {
  test(
    `policy cancellation closes a real HTTP transfer${redirect ? " after a redirect" : ""}`,
    { timeout: 5000 },
    async (t) => {
      const originalLoad = Module._load;
      const requests = new Set();
      Module._load = function (name, parent, isMain) {
        if (name === "electron") {
          return {
            session: { fromPartition: () => ({}) },
            net: {
              request(options) {
                const request = http.request(options);
                requests.add(request);
                request.once("close", () => requests.delete(request));
                return request;
              },
            },
          };
        }
        return originalLoad.call(this, name, parent, isMain);
      };
      t.after(() => {
        for (const request of requests) request.destroy();
        Module._load = originalLoad;
      });
      const UpdateHttpExecutor = require("../../src/helpers/updateHttpExecutor");
      const executor = new UpdateHttpExecutor();
      let started;
      let closed;
      const receiving = new Promise((resolve) => (started = resolve));
      const disconnected = new Promise((resolve) => (closed = resolve));
      const total = 64 * 1024 * 1024;
      let blockedRequests = 0;
      const server = http.createServer((request, response) => {
        if (request.url === "/blocked") {
          blockedRequests++;
          response.end("unexpected");
          return;
        }
        if (request.url === "/ready") {
          response.end("permitted");
          return;
        }
        if (request.url === "/missing") {
          response.writeHead(404);
          response.end("missing");
          return;
        }
        if (request.url === "/empty") {
          response.writeHead(204);
          response.end();
          return;
        }
        if (request.url === "/redirect") {
          response.writeHead(302, { Location: "/payload" });
          response.end();
          return;
        }
        response.writeHead(200, { "Content-Length": total });
        let sent = 0;
        const timer = setInterval(() => {
          response.write(Buffer.alloc(64 * 1024));
          sent += 64 * 1024;
          started();
        }, 10);
        response.once("close", () => {
          clearInterval(timer);
          closed({ sent, complete: response.writableFinished });
        });
      });
      server.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      t.after(() => {
        server.closeAllConnections();
        server.close();
      });
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "update-request-test-"));
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      const token = new CancellationToken();
      const download = executor.download(
        new URL(`http://127.0.0.1:${server.address().port}/${redirect ? "redirect" : "payload"}`),
        path.join(directory, "update.bin"),
        { cancellationToken: token }
      );
      const rejected = assert.rejects(download);
      await receiving;
      token.cancel();
      executor.abortRequests();
      await rejected;
      const result = await disconnected;
      assert.ok(result.sent > 0 && result.sent < total);
      assert.equal(result.complete, false);
      assert.equal(executor.requests.size, 0);
      const requestOptions = {
        protocol: "http:",
        hostname: "127.0.0.1",
        port: server.address().port,
      };
      await assert.rejects(
        executor.request({ ...requestOptions, path: "/blocked" }),
        CancellationError
      );
      executor.resumeRequests();
      assert.equal(await executor.request({ ...requestOptions, path: "/ready" }), "permitted");
      assert.equal(blockedRequests, 0);
      await assert.rejects(executor.request({ ...requestOptions, path: "/missing" }));
      await assert.rejects(
        executor.downloadToBuffer(new URL(`http://127.0.0.1:${server.address().port}/missing`), {
          cancellationToken: new CancellationToken(),
        })
      );
      await executor.request({ ...requestOptions, path: "/empty" });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(executor.requests.size, 0);
    }
  );
}
