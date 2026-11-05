const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const LlamaServerManager = require("../../src/helpers/llamaServer.js");

// A manager whose spawn is stubbed at the _doStart boundary, recording the
// options each start was asked for.
function makeManager() {
  const manager = new LlamaServerManager();
  const starts = [];
  manager._doStart = async (modelPath, options = {}) => {
    manager.ready = true;
    manager.modelPath = modelPath;
    manager.draftModelPath = options.draftModelPath || null;
    starts.push({ modelPath, contextSize: options.contextSize });
  };
  return { manager, starts };
}

// --- grow-only restart ---------------------------------------------------
//
// Before #2142 the context was a single constant, so start() could ignore
// options entirely once a server was ready. Now that the context varies per
// request, it has to restart to grow — but only to grow, or a long note
// followed by a short dictation would restart the server twice.

test("a larger context restarts the server", async () => {
  const { manager, starts } = makeManager();

  await manager.start("/models/main.gguf", { contextSize: 16384 });
  assert.equal(starts.length, 1);

  await manager.start("/models/main.gguf", { contextSize: 32768 });
  assert.equal(starts.length, 2);
  assert.equal(manager.contextSize, 32768);
});

test("an equal or smaller context reuses the running server", async () => {
  const { manager, starts } = makeManager();

  await manager.start("/models/main.gguf", { contextSize: 32768 });
  assert.equal(starts.length, 1);

  // Exactly the same → no restart.
  await manager.start("/models/main.gguf", { contextSize: 32768 });
  assert.equal(starts.length, 1);

  // Smaller → no restart, and the larger window is kept. This is what stops a
  // short dictation right after a long note from costing a second restart.
  await manager.start("/models/main.gguf", { contextSize: 16384 });
  assert.equal(starts.length, 1);
  assert.equal(manager.contextSize, 32768);
});

test("growing the context still restarts when the drafter is unchanged", async () => {
  const { manager, starts } = makeManager();

  await manager.start("/models/main.gguf", { contextSize: 16384, draftModelPath: "/d.gguf" });
  await manager.start("/models/main.gguf", { contextSize: 65536, draftModelPath: "/d.gguf" });

  assert.equal(starts.length, 2);
  assert.equal(manager.contextSize, 65536);
});

test("a context grown for one model does not carry over to another", async () => {
  const { manager, starts } = makeManager();

  await manager.start("/models/big.gguf", { contextSize: 65536 });
  await manager.start("/models/other.gguf", { contextSize: 16384 });

  assert.equal(starts.length, 2);
  assert.equal(manager.contextSize, 16384, "the new model starts at its own size");
});

test("stopping the server forgets the grown context", async () => {
  const { manager } = makeManager();
  manager._killCurrentProcess = async () => {};
  manager.process = {};

  await manager.start("/models/main.gguf", { contextSize: 65536 });
  assert.equal(manager.contextSize, 65536);

  await manager.stop();
  assert.equal(manager.contextSize, null);
});

test("a server that died is started again for the same model", async () => {
  const { manager, starts } = makeManager();

  await manager.start("/models/main.gguf", { contextSize: 16384 });
  // What the process close handler leaves behind: the model and context
  // outlive a crash, so only `ready` says the server is gone.
  manager.ready = false;
  manager.process = null;

  await manager.start("/models/main.gguf", { contextSize: 16384 });
  assert.equal(starts.length, 2);
});

// --- concurrent starts ---------------------------------------------------
//
// The server is shared between scopes, so cleanup and the Voice Assistant can
// ask for different models at once. Callers record the model they asked for
// as loaded once start() resolves, so a start must never resolve on a startup
// that does not give it what it asked for — the renderer would then be handed
// model A's port for a model B request.

// Like makeManager(), but each start stays in flight until released, and a
// started server leaves a live process behind, so the next start has to await
// stop() before it spawns.
function makeGatedManager() {
  const { manager, starts } = makeManager();
  const stubStart = manager._doStart;
  const gates = [];
  // These tests are about the queue, not about what a running server is doing.
  manager._isBusy = async () => false;
  manager._doStart = async (modelPath, options) => {
    await new Promise((resolve, reject) => {
      gates.push({ resolve, reject });
    });
    await stubStart(modelPath, options);
    manager.process = { exitCode: 0, once: (event, callback) => callback() };
  };
  const release = async (index, error) => {
    // Let start() reach _doStart before settling it.
    for (let attempt = 0; !gates[index]; attempt++) {
      assert.ok(attempt < 50, `start #${index + 1} never reached _doStart`);
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (error) gates[index].reject(error);
    else gates[index].resolve();
  };
  const tick = async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  return { manager, starts, release, spawned: () => gates.length, tick };
}

test("a start for another model waits for the in-flight start, then loads its own model", async () => {
  const { manager, starts, release, spawned, tick } = makeGatedManager();

  const startA = manager.start("/models/cleanup.gguf");
  const startB = manager.start("/models/assistant.gguf");
  await tick();
  assert.equal(spawned(), 1, "B must not spawn while A is in flight");

  await release(0);
  await startA;
  await release(1);
  await startB;

  assert.deepEqual(
    starts.map((start) => start.modelPath),
    ["/models/cleanup.gguf", "/models/assistant.gguf"]
  );
  assert.equal(manager.modelPath, "/models/assistant.gguf");
});

test("a start for another model still runs when the in-flight start fails", async () => {
  const { manager, starts, release } = makeGatedManager();

  const startA = manager.start("/models/cleanup.gguf");
  const startB = manager.start("/models/assistant.gguf");

  await release(0, new Error("spawn failed"));
  await assert.rejects(startA, /spawn failed/);
  await release(1);
  await startB;

  assert.deepEqual(
    starts.map((start) => start.modelPath),
    ["/models/assistant.gguf"]
  );
  assert.equal(manager.modelPath, "/models/assistant.gguf");
});

test("concurrent starts for the same model share one startup, and its failure", async () => {
  const { manager, release, spawned, tick } = makeGatedManager();

  const first = manager.start("/models/cleanup.gguf");
  const second = manager.start("/models/cleanup.gguf");
  // Attached before the failure, or it is reported as unhandled.
  const secondRejects = assert.rejects(second, /spawn failed/);

  await release(0, new Error("spawn failed"));
  await assert.rejects(first, /spawn failed/);
  await tick();

  assert.equal(spawned(), 1, "the joined start must not spawn a second time");
  await secondRejects;
});

test("a start needing a larger context does not join a smaller in-flight start", async () => {
  // Joining would resolve on the smaller window, and the caller would then
  // record the larger one as refused by this machine without ever trying it.
  const { manager, starts, release } = makeGatedManager();

  const small = manager.start("/models/main.gguf", { contextSize: 16384 });
  const large = manager.start("/models/main.gguf", { contextSize: 32768 });

  await release(0);
  await small;
  await release(1);
  await large;

  assert.deepEqual(
    starts.map((start) => start.contextSize),
    [16384, 32768]
  );
  assert.equal(manager.contextSize, 32768);
});

test("a start needing a smaller context joins a larger in-flight start", async () => {
  const { manager, release, spawned } = makeGatedManager();

  const large = manager.start("/models/main.gguf", { contextSize: 32768 });
  const small = manager.start("/models/main.gguf", { contextSize: 16384 });

  await release(0);
  await Promise.all([large, small]);

  assert.equal(spawned(), 1);
  assert.equal(manager.contextSize, 32768);
});

test("a start with a different drafter does not join the in-flight start", async () => {
  const { manager, release, spawned } = makeGatedManager();

  const drafted = manager.start("/models/main.gguf", { draftModelPath: "/d.gguf" });
  const plain = manager.start("/models/main.gguf");

  await release(0);
  await drafted;
  await release(1);
  await plain;

  assert.equal(spawned(), 2);
  assert.equal(manager.draftModelPath, null);
});

test("waiting starts are woken one at a time", async () => {
  const { manager, starts, release, spawned, tick } = makeGatedManager();

  const startA = manager.start("/models/a.gguf");
  const startB = manager.start("/models/b.gguf");
  const startC = manager.start("/models/c.gguf");

  await release(0);
  await startA;
  await tick();
  assert.equal(spawned(), 2, "only one waiter may start once A finishes");

  await release(1);
  await tick();
  assert.equal(spawned(), 3);
  await release(2);
  await Promise.all([startB, startC]);

  assert.equal(starts.length, 3);
});

// --- spawn arguments -----------------------------------------------------

test("every GPU ladder rung inherits the requested context and cache bounds", async () => {
  const manager = new LlamaServerManager();
  const seen = [];
  manager._buildEnv = () => ({});
  manager._killCurrentProcess = async () => {};
  manager.findAvailablePort = async () => 8221;
  manager.draftModelPath = null;
  manager._startWithBinary = async (binary, args) => {
    seen.push(args);
    throw new Error("stub fail");
  };

  const baseArgs = manager._buildBaseArgs("/models/main.gguf", 8221, {
    contextSize: 32768,
    cacheRamMiB: 1024,
  });
  await assert.rejects(() =>
    manager._startWithGpuFallback({ vulkan: "/bin/vulkan", cpu: "/bin/cpu" }, baseArgs, {}, [])
  );

  assert.ok(seen.length >= 2, "expected the ladder to try more than one rung");
  for (const args of seen) {
    assert.equal(args[args.indexOf("--ctx-size") + 1], "32768");
    // llama-server defaults --cache-ram to 8192 MiB of host RAM on top of the
    // KV cache. Left unbounded it would undo the memory budget entirely.
    assert.equal(args[args.indexOf("--cache-ram") + 1], "1024");
  }
});

// --- context-overflow errors --------------------------------------------

test("a context overflow is reported as a typed error, not as llama.cpp JSON", async () => {
  const overflowBody = JSON.stringify({
    error: {
      code: 400,
      message: "request (20514 tokens) exceeds the available context size (16384 tokens)",
      type: "exceed_context_size_error",
      n_prompt_tokens: 20514,
      n_ctx: 16384,
    },
  });

  const server = http.createServer((req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(overflowBody);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const manager = new LlamaServerManager();
  manager.ready = true;
  manager.process = {};
  manager.port = server.address().port;

  try {
    await assert.rejects(
      () => manager.inference([{ role: "user", content: "hi" }], {}),
      (error) => {
        assert.equal(error.code, "CONTEXT_TOO_LARGE");
        assert.equal(error.neededTokens, 20514);
        assert.equal(error.maxContextTokens, 16384);
        // The whole point: a customer must never be shown a JSON blob.
        assert.ok(!error.message.includes("{"), `raw JSON leaked: ${error.message}`);
        return true;
      }
    );
  } finally {
    manager.clearIdleTimer();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("other llama-server failures keep their existing shape", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("internal error");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const manager = new LlamaServerManager();
  manager.ready = true;
  manager.process = {};
  manager.port = server.address().port;

  try {
    await assert.rejects(
      () => manager.inference([{ role: "user", content: "hi" }], {}),
      (error) => {
        assert.equal(error.code, undefined);
        assert.match(error.message, /llama-server returned status 500/);
        return true;
      }
    );
  } finally {
    manager.clearIdleTimer();
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- measuring the running server ----------------------------------------
//
// The estimate only picks the size the server starts at. These two calls are
// what make the decision exact: /props reports the window actually in force
// (which can differ from what we asked for), and /apply-template + /tokenize
// price the real prompt, chat template and all.

function withStubServer(routes) {
  // A Map rather than indexing the object: req.url is request-controlled, so a
  // plain lookup answers /toString or /constructor with an inherited
  // Object.prototype method and then calls it.
  const routeTable = new Map(Object.entries(routes));
  return async (run) => {
    const server = http.createServer((req, res) => {
      const handler = routeTable.get(req.url);
      if (typeof handler !== "function") {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const { status = 200, payload } = handler(body);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    const manager = new LlamaServerManager();
    manager.ready = true;
    manager.process = {};
    manager.port = server.address().port;
    try {
      await run(manager);
    } finally {
      manager.clearIdleTimer();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

test("stopWhenIdle waits for an answer in progress before it stops the server", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const manager = new LlamaServerManager();
  manager.process = { exitCode: 0, once: (event, callback) => callback() };
  const replies = [[{ is_processing: true }], [{ is_processing: false }]];
  let stops = 0;
  manager._requestJson = async () => replies.shift();
  manager.stop = async () => {
    stops += 1;
    manager.process = null;
  };

  const stopped = manager.stopWhenIdle();
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stops, 0, "the answer keeps running");

  t.mock.timers.tick(5000);
  assert.equal(await stopped, true);
  assert.equal(stops, 1);
});

test("stopWhenIdle leaves a server another start has replaced alone", async () => {
  const manager = new LlamaServerManager();
  manager.process = { exitCode: 0 };
  let stops = 0;
  manager.stop = async () => {
    stops += 1;
  };
  manager._requestJson = async () => {
    manager.process = { exitCode: 0 };
    return [];
  };

  assert.equal(await manager.stopWhenIdle(), false);
  assert.equal(stops, 0);
  assert.equal(await new LlamaServerManager().stopWhenIdle(), false, "no server, nothing to stop");
});

// --- a restart never cuts off an answer ------------------------------------
//
// Streaming chat talks to the port directly, so only the server knows an answer
// is being generated. Every restart (another model, a bigger window) goes through
// the same wait, with a deadline the caller picks.

const BUSY = [{ is_processing: false }, { is_processing: true }];
const IDLE = [{ is_processing: false }, { is_processing: false }];

// A manager already serving /models/running.gguf, with /slots stubbed and
// stops recorded. replyFor decides what each /slots read answers.
function makeRunningManager(replyFor) {
  const { manager, starts } = makeManager();
  const doStart = manager._doStart;
  manager._doStart = async (modelPath, options) => {
    await doStart(modelPath, options);
    manager.process = { pid: starts.length };
  };
  manager.process = { pid: 0 };
  manager.ready = true;
  manager.port = 1;
  manager.modelPath = "/models/running.gguf";
  manager.draftModelPath = null;
  manager.contextSize = 4096;
  const stops = [];
  manager.stop = async () => {
    stops.push(manager.modelPath);
    manager.process = null;
    manager.ready = false;
    manager.modelPath = null;
    manager.contextSize = null;
  };
  manager._requestJson = async () => replyFor();
  return { manager, starts, stops };
}

const isModelBusy = (error) => error.code === "LOCAL_MODEL_BUSY";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a start for another model waits for the answer to finish before stopping the server", async () => {
  let answering = true;
  const { manager, starts, stops } = makeRunningManager(() => (answering ? BUSY : IDLE));

  const swap = manager.start("/models/other.gguf", { busyWaitMs: 5000 });
  await pause(300);
  assert.deepEqual(stops, [], "the answer keeps its server");
  assert.equal(starts.length, 0);

  answering = false;
  await swap;
  assert.deepEqual(stops, ["/models/running.gguf"]);
  assert.equal(starts[0].modelPath, "/models/other.gguf");
  manager.clearIdleTimer();
});

test("a start that runs out of time is refused and leaves the answer running", async () => {
  const { manager, starts, stops } = makeRunningManager(() => BUSY);

  const started = Date.now();
  await assert.rejects(manager.start("/models/other.gguf", { busyWaitMs: 300 }), isModelBusy);
  assert.ok(Date.now() - started < 1000, "the deadline is what ended the wait");
  assert.deepEqual(stops, []);
  assert.equal(starts.length, 0);
  assert.equal(manager.modelPath, "/models/running.gguf");
  assert.equal(manager.ready, true);
});

test("a start with no time to wait is refused at once", async () => {
  const { manager, stops } = makeRunningManager(() => BUSY);

  const started = Date.now();
  await assert.rejects(manager.start("/models/other.gguf", { busyWaitMs: 0 }), isModelBusy);
  assert.ok(Date.now() - started < 100);
  assert.deepEqual(stops, []);
});

test("a server too busy to answer /slots counts as busy, and the wait still ends on time", async (t) => {
  // llama-server answers /slots between batches, so a long prompt holds the reply.
  const hung = http.createServer(() => {});
  await new Promise((resolve) => hung.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    hung.closeAllConnections();
    hung.close();
  });
  const { manager, stops } = makeRunningManager(() => BUSY);
  delete manager._requestJson;
  manager.port = hung.address().port;

  const started = Date.now();
  await assert.rejects(manager.start("/models/other.gguf", { busyWaitMs: 300 }), isModelBusy);
  assert.ok(Date.now() - started < 1500);
  assert.deepEqual(stops, []);
});

test("a /slots read that fails outright does not hold the restart up", async () => {
  const { manager, starts, stops } = makeRunningManager(() => null);

  await manager.start("/models/other.gguf", { busyWaitMs: 5000 });
  assert.equal(stops.length, 1);
  assert.equal(starts.length, 1);
  manager.clearIdleTimer();
});

test("a server that failed its health check is replaced without asking it", async () => {
  let reads = 0;
  const { manager, starts } = makeRunningManager(() => {
    reads += 1;
    return BUSY;
  });
  manager.ready = false;

  await manager.start("/models/other.gguf", { busyWaitMs: 0 });
  assert.equal(reads, 0);
  assert.equal(starts.length, 1);
  manager.clearIdleTimer();
});

test("the running model stays available while another start waits for its turn", async () => {
  let answering = true;
  const { manager, starts, stops } = makeRunningManager(() => (answering ? BUSY : IDLE));

  const waiting = manager.start("/models/other.gguf", { busyWaitMs: 5000 });
  await pause(50);

  // A follow-up on the model that's answering is not queued behind the swap.
  await manager.start("/models/running.gguf");
  assert.deepEqual(stops, []);
  assert.equal(starts.length, 0);

  answering = false;
  manager.handoffUntil = 0;
  await waiting;
  assert.equal(starts[0].modelPath, "/models/other.gguf");
  manager.clearIdleTimer();
});

test("growing a busy server's context waits for its answer too", async () => {
  let answering = true;
  const { manager, starts, stops } = makeRunningManager(() => (answering ? BUSY : IDLE));

  await assert.rejects(
    manager.start("/models/running.gguf", { contextSize: 32768, busyWaitMs: 0 }),
    isModelBusy
  );
  assert.deepEqual(stops, []);

  answering = false;
  await manager.start("/models/running.gguf", { contextSize: 32768, busyWaitMs: 0 });
  assert.equal(starts[0].contextSize, 32768);
  manager.clearIdleTimer();
});

test("a request main is waiting on counts as busy", async () => {
  // Between sending it and the server taking it, /slots still reads idle.
  const { manager, stops } = makeRunningManager(() => IDLE);
  manager.activeRequest = {};

  await assert.rejects(manager.start("/models/other.gguf", { busyWaitMs: 0 }), isModelBusy);
  assert.deepEqual(stops, []);
});

test("a server just handed to a caller is kept until its request can arrive", async () => {
  // The renderer gets the port, then connects: /slots reads idle in between.
  const { manager, starts, stops } = makeRunningManager(() => IDLE);

  await manager.start("/models/running.gguf");
  await assert.rejects(manager.start("/models/other.gguf", { busyWaitMs: 100 }), isModelBusy);
  assert.deepEqual(stops, []);

  await manager.start("/models/other.gguf", { busyWaitMs: 5000 });
  assert.deepEqual(stops, ["/models/running.gguf"]);
  assert.equal(starts[0].modelPath, "/models/other.gguf");
  manager.clearIdleTimer();
});

test("a queued start does not take the server a finished start just loaded", async () => {
  const { manager, starts, stops } = makeRunningManager(() => IDLE);
  const doStart = manager._doStart;
  manager._doStart = async (modelPath, options) => {
    await pause(50);
    await doStart(modelPath, options);
  };

  const first = manager.start("/models/first.gguf", { busyWaitMs: 5000 });
  const second = manager.start("/models/second.gguf", { busyWaitMs: 5000 });
  let secondDone = false;
  second.then(() => {
    secondDone = true;
  });

  await first;
  assert.equal(manager.modelPath, "/models/first.gguf");
  await pause(200);
  assert.equal(secondDone, false, "the first caller's request gets there first");
  assert.equal(manager.modelPath, "/models/first.gguf");

  await second;
  assert.deepEqual(
    starts.map((start) => start.modelPath),
    ["/models/first.gguf", "/models/second.gguf"]
  );
  assert.deepEqual(stops, ["/models/running.gguf", "/models/first.gguf"]);
  manager.clearIdleTimer();
});

test("the deadline also covers waiting for another model to finish loading", async () => {
  const { manager } = makeManager();
  let finishLoad;
  manager._doStart = () => new Promise((resolve) => (finishLoad = resolve));

  const loading = manager.start("/models/slow.gguf");
  const started = Date.now();
  await assert.rejects(manager.start("/models/other.gguf", { busyWaitMs: 100 }), isModelBusy);
  assert.ok(Date.now() - started < 1000);

  finishLoad();
  await loading;
  manager.clearIdleTimer();
});

test("an old server exiting late does not take the new server's handle with it", async (t) => {
  // A server that ignored SIGTERM is SIGKILLed and stop() moves on before it
  // exits, so its close event lands after the next server has spawned.
  const portOf = () =>
    new Promise((resolve) => {
      const probe = http.createServer();
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
  const healthServer = (port) => [
    "-e",
    `require("http").createServer((q,s)=>s.end("ok")).listen(${port},"127.0.0.1")`,
  ];
  const manager = new LlamaServerManager();
  const spawnServer = async () => {
    manager.port = await portOf();
    await manager._startWithBinary(
      process.execPath,
      healthServer(manager.port),
      process.env,
      10000
    );
    return manager.process;
  };

  const oldServer = await spawnServer();
  t.after(() => oldServer.kill("SIGKILL"));
  manager.process = null;
  const newServer = await spawnServer();
  t.after(() => newServer.kill("SIGKILL"));

  await new Promise((resolve) => {
    oldServer.once("close", resolve);
    oldServer.kill("SIGKILL");
  });

  assert.equal(manager.process, newServer);
  assert.equal(manager.ready, true);
  manager.stopHealthCheck();
});

test("usableContextSize reports the window the server actually has", async () => {
  await withStubServer({
    "/props": () => ({ payload: { default_generation_settings: { n_ctx: 32768 } } }),
  })(async (manager) => {
    assert.equal(await manager.usableContextSize(), 32768);
  });
});

test("usableContextSize returns null rather than guessing when props is unreadable", async () => {
  // A broken measurement must degrade to the estimate, never fail the request.
  await withStubServer({ "/props": () => ({ status: 500, payload: {} }) })(async (manager) => {
    assert.equal(await manager.usableContextSize(), null);
  });
  await withStubServer({})(async (manager) => {
    assert.equal(await manager.usableContextSize(), null);
  });
});

test("countPromptTokens prices the rendered template, not just the message text", async () => {
  let templatedWith = null;
  let tokenized = null;

  await withStubServer({
    "/apply-template": (body) => {
      templatedWith = JSON.parse(body);
      // The real server renders role tags and, with thinking disabled, an
      // empty <think></think> block. All of it costs context.
      return { payload: { prompt: "<|im_start|>system\nSYS<|im_end|>\nhello" } };
    },
    "/tokenize": (body) => {
      tokenized = JSON.parse(body);
      return { payload: { tokens: new Array(20514).fill(0) } };
    },
  })(async (manager) => {
    const messages = [
      { role: "system", content: "SYS" },
      { role: "user", content: "hello" },
    ];
    assert.equal(await manager.countPromptTokens(messages, { disableThinking: true }), 20514);
    assert.deepEqual(templatedWith.messages, messages);
    assert.deepEqual(templatedWith.chat_template_kwargs, { enable_thinking: false });
    assert.equal(tokenized.content, "<|im_start|>system\nSYS<|im_end|>\nhello");
  });
});

test("countPromptTokens returns null when the server cannot measure", async () => {
  await withStubServer({ "/apply-template": () => ({ status: 500, payload: {} }) })(
    async (manager) => {
      assert.equal(await manager.countPromptTokens([{ role: "user", content: "hi" }], {}), null);
    }
  );
});

// --- reading the reply ---------------------------------------------------
//
// With thinking on, `reasoning_content` is the reasoning, not the answer (#2187).

const MESSAGES = [{ role: "user", content: "hi" }];

// Stubs one chat completion and records the request bodies it receives.
function withReply(message, finishReason = "stop") {
  const requests = [];
  const run = withStubServer({
    "/v1/chat/completions": (body) => {
      requests.push(JSON.parse(body));
      return { payload: { choices: [{ message, finish_reason: finishReason }] } };
    },
  });
  return { run, requests };
}

const TRUNCATED = { code: "OUTPUT_TRUNCATED" };

test("reasoning never stands in for the answer when thinking was requested", async () => {
  const reasoningOnly = { content: "", reasoning_content: "Thinking Process:\n\n1. Analyze" };

  // Cut off mid-reasoning: there is no answer to return, so every caller gets
  // the truncation error rather than an empty string it would have to explain.
  const truncated = withReply(reasoningOnly, "length");
  await truncated.run(async (manager) => {
    await assert.rejects(manager.inference(MESSAGES, { disableThinking: false }), TRUNCATED);
    const strict = { disableThinking: false, requireCompleteOutput: true };
    await assert.rejects(manager.inference(MESSAGES, strict), TRUNCATED);
  });
  assert.equal(truncated.requests[0].chat_template_kwargs, undefined);

  // Finished with no answer: reaches strict callers such as dictation cleanup too.
  const finished = withReply(reasoningOnly, "stop");
  await finished.run(async (manager) => {
    const options = { disableThinking: false, requireCompleteOutput: true };
    assert.equal(await manager.inference(MESSAGES, options), "");
  });
});

test("a cut-off reply with no content is truncated even when thinking was suppressed", async () => {
  // gpt-oss ignores enable_thinking and reasons into reasoning_content anyway;
  // a budget spent entirely there is a cut-off reply, not a misrouted answer.
  const analysisOnly = withReply({ content: "", reasoning_content: "analysis..." }, "length");
  await analysisOnly.run(async (manager) => {
    await assert.rejects(manager.inference(MESSAGES, { disableThinking: true }), TRUNCATED);
  });
});

test("a cut-off reply that has content is still returned to lenient callers", async () => {
  // Only requireCompleteOutput callers reject a partial answer (#2130).
  const partial = withReply({ content: "Cleaned te", reasoning_content: "" }, "length");
  await partial.run(async (manager) => {
    assert.equal(await manager.inference(MESSAGES, { disableThinking: true }), "Cleaned te");
    await assert.rejects(manager.inference(MESSAGES, { requireCompleteOutput: true }), TRUNCATED);
  });
});

test("an answer routed into reasoning_content with thinking suppressed is still returned", async () => {
  // Some llama-server builds do this despite enable_thinking: false (#809).
  const misrouted = withReply({ content: "", reasoning_content: "Cleaned text." });
  await misrouted.run(async (manager) => {
    assert.equal(await manager.inference(MESSAGES, { disableThinking: true }), "Cleaned text.");
    assert.equal(await manager.inference(MESSAGES, {}), "Cleaned text.");
  });
  assert.deepEqual(misrouted.requests[0].chat_template_kwargs, { enable_thinking: false });
});

test("content is returned over reasoning_content whether or not thinking was on", async () => {
  const both = withReply({ content: "Cleaned text.", reasoning_content: "Thinking Process:" });
  await both.run(async (manager) => {
    assert.equal(await manager.inference(MESSAGES, { disableThinking: false }), "Cleaned text.");
    assert.equal(await manager.inference(MESSAGES, {}), "Cleaned text.");
  });
});

// --- Vulkan context step-down --------------------------------------------
//
// Sizing the context to the request is bounded by SYSTEM RAM, but a discrete
// GPU has its own memory that the app does not probe. A machine with plenty of
// RAM and a small card can therefore now ask for a context that will not fit
// in VRAM — a failure this change introduces. Dropping straight to CPU costs
// 10-30x; halving the context is far cheaper, so try that first.

function makeLadder(shouldFail, { contextSize = 32768 } = {}) {
  const manager = new LlamaServerManager();
  const attempts = [];
  manager._buildEnv = () => ({});
  manager._killCurrentProcess = async () => {};
  manager.findAvailablePort = async () => 8221;
  manager.draftModelPath = null;
  manager._startWithBinary = async (binary, args) => {
    const attempt = { binary, ctx: Number(args[args.indexOf("--ctx-size") + 1]) };
    attempts.push(attempt);
    if (shouldFail(attempt)) throw new Error(`stub fail: ${binary} ctx=${attempt.ctx}`);
  };
  const baseArgs = manager._buildBaseArgs("/models/main.gguf", 8221, { contextSize });
  return { manager, attempts, baseArgs, options: { contextSize } };
}

const BINARIES = { vulkan: "/bin/vulkan", cpu: "/bin/cpu" };

test("a Vulkan start that fails at a grown context retries smaller before dropping to CPU", async () => {
  // Vulkan only succeeds at the baseline context.
  const { manager, attempts, baseArgs, options } = makeLadder(
    (attempt) => attempt.binary === "/bin/vulkan" && attempt.ctx > 16384
  );

  await manager._startWithGpuFallback(BINARIES, baseArgs, options, []);

  assert.deepEqual(attempts, [
    { binary: "/bin/vulkan", ctx: 32768 },
    { binary: "/bin/vulkan", ctx: 16384 },
  ]);
  assert.equal(manager.activeBackend, "vulkan", "a live GPU beats a CPU fallback");
});

test("a baseline-context start keeps today's exact ladder, with no extra rung", async () => {
  // The step-down must not add an attempt when there is nothing to step down
  // to, or every existing failure path gets slower.
  const { manager, attempts, baseArgs, options } = makeLadder(() => true, {
    contextSize: 16384,
  });

  await assert.rejects(() => manager._startWithGpuFallback(BINARIES, baseArgs, options, []));

  assert.deepEqual(attempts, [
    { binary: "/bin/vulkan", ctx: 16384 },
    { binary: "/bin/cpu", ctx: 16384 },
  ]);
});

test("a context step-down is recorded, so the server reports what it actually has", async () => {
  const { manager, baseArgs, options } = makeLadder(
    (attempt) => attempt.binary === "/bin/vulkan" && attempt.ctx > 16384
  );

  await manager._startWithGpuFallback(BINARIES, baseArgs, options, []);

  // Otherwise the preflight would believe the request still fits and send a
  // prompt the server cannot take.
  assert.equal(manager.contextSize, 16384);
});
