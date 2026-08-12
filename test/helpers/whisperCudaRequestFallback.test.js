const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const WhisperServerManager = require("../../src/helpers/whisperServer");
const {
  shouldFallbackToCpuAfterRequestError,
  shouldRetryAfterServerReplaced,
} = require("../../src/helpers/whisperServer");

const base = {
  isConnectionError: true,
  useGpu: true,
  isRemote: false,
  stopRequested: false,
  generationChanged: false,
  processExited: true,
};

test("falls back when a local GPU server drops the connection and exits", () => {
  assert.equal(shouldFallbackToCpuAfterRequestError(base), true);
});

test("skips a failure that is not a connection error (server answered)", () => {
  assert.equal(shouldFallbackToCpuAfterRequestError({ ...base, isConnectionError: false }), false);
});

test("skips a CPU server (nothing to fall back to)", () => {
  assert.equal(shouldFallbackToCpuAfterRequestError({ ...base, useGpu: false }), false);
});

test("skips a remote server (its process is not ours to restart)", () => {
  assert.equal(shouldFallbackToCpuAfterRequestError({ ...base, isRemote: true }), false);
});

test("skips when the server was stopped on purpose", () => {
  assert.equal(shouldFallbackToCpuAfterRequestError({ ...base, stopRequested: true }), false);
});

test("skips when another start replaced the server mid-request", () => {
  assert.equal(shouldFallbackToCpuAfterRequestError({ ...base, generationChanged: true }), false);
});

test("skips when the server process is still alive (request refused, not a crash)", () => {
  assert.equal(shouldFallbackToCpuAfterRequestError({ ...base, processExited: false }), false);
});

const replacedBase = {
  isConnectionError: true,
  isRemote: false,
  stopRequested: false,
  ready: true,
  sameModel: true,
};

test("retries against the server a concurrent caller already restarted", () => {
  assert.equal(shouldRetryAfterServerReplaced(replacedBase), true);
});

test("skips the replaced-server retry for a failure that is not a connection error", () => {
  assert.equal(
    shouldRetryAfterServerReplaced({ ...replacedBase, isConnectionError: false }),
    false
  );
});

test("skips the replaced-server retry when the server is now remote", () => {
  assert.equal(shouldRetryAfterServerReplaced({ ...replacedBase, isRemote: true }), false);
});

test("skips the replaced-server retry after an intentional stop", () => {
  assert.equal(shouldRetryAfterServerReplaced({ ...replacedBase, stopRequested: true }), false);
});

test("skips the replaced-server retry while the replacement is not ready", () => {
  assert.equal(shouldRetryAfterServerReplaced({ ...replacedBase, ready: false }), false);
});

test("skips the replaced-server retry when the replacement switched model", () => {
  assert.equal(shouldRetryAfterServerReplaced({ ...replacedBase, sameModel: false }), false);
});

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createManager(port, { useCuda, useVulkan = false }) {
  const manager = new WhisperServerManager();
  manager.ready = true;
  manager.hostname = "127.0.0.1";
  manager.port = port;
  manager.useCuda = useCuda;
  manager.useVulkan = useVulkan;
  manager.canConvert = true;
  manager.process = {};
  manager.modelPath = "/tmp/model.bin";
  manager.lastStartOptions = { useCuda, useVulkan };
  manager._convertToWav = async (buffer) => buffer;
  return manager;
}

test("falls back to CPU and retries once when the CUDA server dies mid-request", async (t) => {
  let manager;
  let requestCount = 0;

  const { server, port } = await startServer((req, res) => {
    requestCount += 1;
    if (requestCount === 1) {
      // The real child's close handler clears this before the socket drops.
      manager.process = null;
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "hello" }));
  });
  t.after(() => server.close());

  manager = createManager(port, { useCuda: true });

  const startCalls = [];
  manager.start = async (modelPath, options) => {
    startCalls.push({ modelPath, options });
    manager.useCuda = false;
    manager.ready = true;
  };

  let fallbackEvents = 0;
  manager.on("cuda-fallback", () => {
    fallbackEvents += 1;
  });

  const result = await manager.transcribe(Buffer.from("audio"));

  assert.equal(result.text, "hello");
  assert.equal(requestCount, 2);
  assert.equal(fallbackEvents, 1);
  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0].modelPath, "/tmp/model.bin");
  assert.equal(startCalls[0].options.useCuda, false);
  assert.equal(startCalls[0].options.useVulkan, false);
});

test("falls back to CPU and emits gpu-fallback when a Vulkan server dies mid-request", async (t) => {
  let manager;
  let requestCount = 0;

  const { server, port } = await startServer((req, res) => {
    requestCount += 1;
    if (requestCount === 1) {
      manager.process = null;
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "hello" }));
  });
  t.after(() => server.close());

  manager = createManager(port, { useCuda: false, useVulkan: true });

  const startCalls = [];
  manager.start = async (modelPath, options) => {
    startCalls.push({ modelPath, options });
    manager.useVulkan = false;
    manager.ready = true;
  };

  const events = [];
  manager.on("cuda-fallback", () => events.push("cuda-fallback"));
  manager.on("gpu-fallback", () => events.push("gpu-fallback"));

  const result = await manager.transcribe(Buffer.from("audio"));

  assert.equal(result.text, "hello");
  assert.equal(requestCount, 2);
  assert.deepEqual(events, ["gpu-fallback"]);
  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0].options.useCuda, false);
  assert.equal(startCalls[0].options.useVulkan, false);
});

test("falls back to CPU when a peer's replacement is another doomed CUDA server", async (t) => {
  let manager;
  let requestCount = 0;

  const { server, port } = await startServer((req, res) => {
    requestCount += 1;
    if (requestCount === 1) {
      // Crash, then simulate a peer restarting with CUDA still enabled.
      manager.process = null;
      manager.startGeneration += 1;
      manager.ready = true;
      req.socket.destroy();
      return;
    }
    if (requestCount === 2) {
      // The replacement CUDA server aborts at its first kernel launch too.
      manager.process = null;
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "hello" }));
  });
  t.after(() => server.close());

  manager = createManager(port, { useCuda: true });

  const startCalls = [];
  manager.start = async (modelPath, options) => {
    startCalls.push({ modelPath, options });
    manager.useCuda = false;
    manager.ready = true;
  };

  let fallbackEvents = 0;
  manager.on("cuda-fallback", () => {
    fallbackEvents += 1;
  });

  const result = await manager.transcribe(Buffer.from("audio"));

  assert.equal(result.text, "hello");
  assert.equal(requestCount, 3);
  assert.equal(fallbackEvents, 1);
  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0].options.useCuda, false);
});

test("does not fall back when the request fails on a CPU server", async (t) => {
  let manager;
  let requestCount = 0;

  const { server, port } = await startServer((req) => {
    requestCount += 1;
    manager.process = null;
    req.socket.destroy();
  });
  t.after(() => server.close());

  manager = createManager(port, { useCuda: false });

  let startCalled = false;
  manager.start = async () => {
    startCalled = true;
  };

  let fallbackEvents = 0;
  manager.on("cuda-fallback", () => {
    fallbackEvents += 1;
  });

  await assert.rejects(
    () => manager.transcribe(Buffer.from("audio")),
    (err) => {
      assert.ok(err.message.startsWith("whisper-server request failed"));
      return true;
    }
  );

  assert.equal(requestCount, 1);
  assert.equal(startCalled, false);
  assert.equal(fallbackEvents, 0);
});

test("recovers both callers when two concurrent requests hit the same crash", async (t) => {
  let manager;
  let requestCount = 0;
  const crashing = [];

  const { server, port } = await startServer((req, res) => {
    requestCount += 1;
    if (requestCount <= 2) {
      // Drop both sockets only once both requests are in flight against the CUDA server.
      crashing.push(req);
      if (crashing.length === 2) {
        manager.process = null;
        for (const pending of crashing) pending.socket.destroy();
      }
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "hello" }));
  });
  t.after(() => server.close());

  manager = createManager(port, { useCuda: true });

  const startCalls = [];
  manager.start = async (mp, options) => {
    startCalls.push({ modelPath: mp, options });
    manager.startGeneration += 1;
    manager.useCuda = false;
    manager.ready = true;
  };

  let fallbackEvents = 0;
  manager.on("cuda-fallback", () => {
    fallbackEvents += 1;
  });

  const results = await Promise.all([
    manager.transcribe(Buffer.from("audio-a")),
    manager.transcribe(Buffer.from("audio-b")),
  ]);

  assert.equal(results[0].text, "hello");
  assert.equal(results[1].text, "hello");
  assert.equal(fallbackEvents, 1);
  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0].options.useCuda, false);
  assert.equal(requestCount, 4);
});

test("waits for a peer's in-flight restart before retrying", async (t) => {
  let manager;
  let requestCount = 0;
  let restartFinished = false;
  let restartFinishedWhenRetried = null;
  const restarted = createDeferred();

  const { server, port } = await startServer((req, res) => {
    requestCount += 1;
    if (requestCount === 1) {
      manager.process = null;
      manager.startGeneration += 1;
      manager.ready = false;
      manager.startupPromise = restarted.promise;
      setTimeout(() => {
        manager.ready = true;
        manager.useCuda = false;
        manager.startupPromise = null;
        restartFinished = true;
        restarted.resolve();
      }, 100);
      req.socket.destroy();
      return;
    }
    restartFinishedWhenRetried = restartFinished;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "hello" }));
  });
  t.after(() => server.close());

  manager = createManager(port, { useCuda: true });

  const startCalls = [];
  manager.start = async (modelPath, options) => {
    startCalls.push({ modelPath, options });
  };

  let fallbackEvents = 0;
  manager.on("cuda-fallback", () => {
    fallbackEvents += 1;
  });

  const result = await manager.transcribe(Buffer.from("audio"));

  assert.equal(result.text, "hello");
  assert.equal(requestCount, 2);
  assert.equal(restartFinishedWhenRetried, true);
  assert.equal(startCalls.length, 0);
  assert.equal(fallbackEvents, 0);
});

test("throws the original error when the peer's restart fails", async (t) => {
  let manager;
  let requestCount = 0;
  const restarted = createDeferred();

  const { server, port } = await startServer((req) => {
    requestCount += 1;
    manager.process = null;
    manager.startGeneration += 1;
    manager.ready = false;
    manager.startupPromise = restarted.promise;
    setTimeout(() => {
      manager.startupPromise = null;
      restarted.reject(new Error("boom"));
    }, 100);
    req.socket.destroy();
  });
  t.after(() => server.close());

  manager = createManager(port, { useCuda: true });

  const startCalls = [];
  manager.start = async (modelPath, options) => {
    startCalls.push({ modelPath, options });
  };

  let fallbackEvents = 0;
  manager.on("cuda-fallback", () => {
    fallbackEvents += 1;
  });

  await assert.rejects(
    () => manager.transcribe(Buffer.from("audio")),
    (err) => {
      assert.ok(err.message.startsWith("whisper-server request failed"));
      return true;
    }
  );

  assert.equal(requestCount, 1);
  assert.equal(startCalls.length, 0);
  assert.equal(fallbackEvents, 0);
});

test("aborts the fallback when a stop request lands during the exit wait", async (t) => {
  let manager;
  let requestCount = 0;

  const { server, port } = await startServer((req) => {
    requestCount += 1;
    setTimeout(() => {
      manager._stopRequested = true;
      manager.process = null;
    }, 100);
    req.socket.destroy();
  });
  t.after(() => server.close());

  manager = createManager(port, { useCuda: true });

  let startCalled = false;
  manager.start = async () => {
    startCalled = true;
  };

  let fallbackEvents = 0;
  manager.on("cuda-fallback", () => {
    fallbackEvents += 1;
  });

  await assert.rejects(
    () => manager.transcribe(Buffer.from("audio")),
    (err) => {
      assert.ok(err.message.startsWith("whisper-server request failed"));
      return true;
    }
  );

  assert.equal(requestCount, 1);
  assert.equal(startCalled, false);
  assert.equal(fallbackEvents, 0);
});

test("does not fall back while the CUDA server process stays alive", async (t) => {
  let requestCount = 0;

  const { server, port } = await startServer((req) => {
    requestCount += 1;
    req.socket.destroy();
  });
  t.after(() => server.close());

  const manager = createManager(port, { useCuda: true });

  let startCalled = false;
  manager.start = async () => {
    startCalled = true;
  };

  let fallbackEvents = 0;
  manager.on("cuda-fallback", () => {
    fallbackEvents += 1;
  });

  await assert.rejects(
    () => manager.transcribe(Buffer.from("audio")),
    (err) => {
      assert.ok(err.message.startsWith("whisper-server request failed"));
      return true;
    }
  );

  assert.equal(requestCount, 1);
  assert.equal(manager.process !== null, true);
  assert.equal(startCalled, false);
  assert.equal(fallbackEvents, 0);
});

test("_waitForProcessExit resolves true immediately when no process is tracked", async () => {
  const manager = new WhisperServerManager();
  manager.process = null;

  const startedAt = Date.now();
  const exited = await manager._waitForProcessExit(500);
  const elapsed = Date.now() - startedAt;

  assert.equal(exited, true);
  assert.ok(elapsed < 100, `expected no wait, took ${elapsed}ms`);
});

test("_waitForProcessExit resolves false after the deadline while the process stays alive", async () => {
  const manager = new WhisperServerManager();
  manager.process = {};

  const startedAt = Date.now();
  const exited = await manager._waitForProcessExit(120);
  const elapsed = Date.now() - startedAt;

  assert.equal(exited, false);
  assert.ok(elapsed >= 120, `expected the full deadline, took ${elapsed}ms`);
  assert.ok(elapsed < 1500, `expected the deadline to bound the wait, took ${elapsed}ms`);
});

test("_waitForProcessExit resolves true as soon as the process exits mid-wait", async () => {
  const manager = new WhisperServerManager();
  manager.process = {};
  setTimeout(() => {
    manager.process = null;
  }, 60);

  const startedAt = Date.now();
  const exited = await manager._waitForProcessExit(1000);
  const elapsed = Date.now() - startedAt;

  assert.equal(exited, true);
  assert.ok(elapsed < 800, `expected an early exit, took ${elapsed}ms`);
});

test("propagates the CPU restart failure without notifying (CPU never came up)", async (t) => {
  let manager;

  const { server, port } = await startServer((req) => {
    manager.process = null;
    req.socket.destroy();
  });
  t.after(() => server.close());

  manager = createManager(port, { useCuda: true });
  manager.start = async () => {
    throw new Error("boom");
  };

  let fallbackEvents = 0;
  manager.on("cuda-fallback", () => {
    fallbackEvents += 1;
  });

  await assert.rejects(
    () => manager.transcribe(Buffer.from("audio")),
    (err) => {
      assert.equal(err.message, "boom");
      return true;
    }
  );

  assert.equal(fallbackEvents, 0);
});

test("rejects immediately for a CPU server without waiting for process exit", async (t) => {
  let requestCount = 0;

  const { server, port } = await startServer((req) => {
    requestCount += 1;
    req.socket.destroy();
  });
  t.after(() => server.close());

  // The process stays alive: the old code polled it for the full exit timeout.
  const manager = createManager(port, { useCuda: false });

  let startCalled = false;
  manager.start = async () => {
    startCalled = true;
  };

  let fallbackEvents = 0;
  manager.on("cuda-fallback", () => {
    fallbackEvents += 1;
  });

  const startedAt = Date.now();
  await assert.rejects(
    () => manager.transcribe(Buffer.from("audio")),
    (err) => {
      assert.ok(err.message.startsWith("whisper-server request failed"));
      return true;
    }
  );
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 1000, `expected an immediate rejection, took ${elapsed}ms`);
  assert.equal(requestCount, 1);
  assert.equal(manager.process !== null, true);
  assert.equal(startCalled, false);
  assert.equal(fallbackEvents, 0);
});

test("does not fall back after an intentional stop", async (t) => {
  let manager;
  let requestCount = 0;

  const { server, port } = await startServer((req) => {
    requestCount += 1;
    manager.process = null;
    req.socket.destroy();
  });
  t.after(() => server.close());

  manager = createManager(port, { useCuda: true });
  manager._stopRequested = true;

  let startCalled = false;
  manager.start = async () => {
    startCalled = true;
  };

  let fallbackEvents = 0;
  manager.on("cuda-fallback", () => {
    fallbackEvents += 1;
  });

  await assert.rejects(
    () => manager.transcribe(Buffer.from("audio")),
    (err) => {
      assert.ok(err.message.startsWith("whisper-server request failed"));
      return true;
    }
  );

  assert.equal(requestCount, 1);
  assert.equal(startCalled, false);
  assert.equal(fallbackEvents, 0);
});
