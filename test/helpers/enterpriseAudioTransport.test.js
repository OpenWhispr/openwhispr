const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const http = require("node:http");
const net = require("node:net");
const { execFileSync, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { WebSocketServer } = require("ws");
const {
  createEnterpriseAudioTransport,
  proxyCandidates,
} = require("../../src/helpers/enterpriseAudioTransport");

const hasOpenSsl = spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;
let directory, certificate, ca, server, sockets, port;
const requests = [];
before(async () => {
  if (!hasOpenSsl) return;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "ow-enterprise-tls-"));
  const openssl = (...args) => execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });
  openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "2",
    "-subj",
    "/CN=OpenWhispr test CA"
  );
  openssl(
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "server.key",
    "-out",
    "server.csr",
    "-subj",
    "/CN=localhost"
  );
  fs.writeFileSync(
    path.join(directory, "ext.cnf"),
    "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n"
  );
  openssl(
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "server.pem",
    "-days",
    "2",
    "-extfile",
    "ext.cnf"
  );
  ca = fs.readFileSync(path.join(directory, "ca.pem"), "utf8");
  certificate = {
    key: fs.readFileSync(path.join(directory, "server.key")),
    cert: fs.readFileSync(path.join(directory, "server.pem")),
  };
  server = https.createServer(certificate, (req, res) => {
    requests.push({
      url: req.url,
      authorization: req.headers.authorization,
      apiKey: req.headers["api-key"],
    });
    if (req.url === "/stall") {
      res.writeHead(200);
      res.write("{");
      return;
    }
    req.resume();
    req.on("end", () => res.end(JSON.stringify({ text: "A real TLS request" })));
  });
  sockets = new WebSocketServer({ server });
  sockets.on("connection", (ws, req) => {
    requests.push({
      url: req.url,
      authorization: req.headers.authorization,
      apiKey: req.headers["api-key"],
    });
    ws.on("message", (data) => ws.send(data));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = server.address().port;
});
after(async () => {
  if (!hasOpenSsl) return;
  for (const client of sockets.clients) client.terminate();
  sockets.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(directory, { recursive: true, force: true });
});
const local = { skip: !hasOpenSsl };
const transport = (resolveProxy = async () => "DIRECT", readCredential = async () => "") =>
  createEnterpriseAudioTransport({ resolveProxy, readCredential });

test("mandatory PAC does not permit a direct fallback", () => {
  assert.throws(() => proxyCandidates("DIRECT", true), { code: "PROXY_FAILED" });
  assert.deepEqual(proxyCandidates("PROXY proxy.test:8080; DIRECT", true), [
    "http://proxy.test:8080",
  ]);
  assert.throws(() => proxyCandidates("SOCKS proxy.test:8080"), { code: "PROXY_UNSUPPORTED" });
});

test("scoped CA trusts HTTPS and WSS, preserving exact paths and auth headers", local, async () => {
  const client = transport();
  const endpoint = `https://127.0.0.1:${port}/api/providers/openai/v1/audio/transcriptions?api-version=test`;
  const response = await client.request(endpoint, {
    method: "POST",
    headers: { Authorization: "Bearer test-key" },
    body: new FormData(),
    caPem: ca,
  });
  assert.equal((await response.json()).text, "A real TLS request");
  assert.equal(
    requests.at(-1).url,
    "/api/providers/openai/v1/audio/transcriptions?api-version=test"
  );
  assert.equal(requests.at(-1).authorization, "Bearer test-key");
  const ws = await client.createSocket(
    `wss://127.0.0.1:${port}/custom/realtime?intent=transcription`,
    { headers: { "api-key": "test-key" }, caPem: ca }
  );
  await once(ws, "open");
  ws.send("real socket audio frame");
  assert.equal((await once(ws, "message"))[0].toString(), "real socket audio frame");
  assert.equal(requests.at(-1).apiKey, "test-key");
  ws.close();
  await once(ws, "close");
});

test("unknown CA and mismatched hostname are never accepted", local, async () => {
  await assert.rejects(transport().request(`https://127.0.0.1:${port}/audio`));
  const bad = https.createServer(
    {
      key: fs.readFileSync(path.join(directory, "ca.key")),
      cert: fs.readFileSync(path.join(directory, "ca.pem")),
    },
    (_, res) => res.end("invalid")
  );
  bad.listen(0, "127.0.0.1");
  await once(bad, "listening");
  try {
    await assert.rejects(
      transport().request(`https://127.0.0.1:${bad.address().port}/audio`, { caPem: ca })
    );
  } finally {
    await new Promise((resolve) => bad.close(resolve));
  }
});

for (const secure of [false, true])
  test(
    `ordered ${secure ? "HTTPS" : "HTTP"} CONNECT proxies carry HTTP and WSS with Basic authentication`,
    local,
    async () => {
      const proxy = secure ? https.createServer(certificate) : http.createServer();
      const unavailable = http.createServer();
      let connections = 0;
      let failedConnects = 0;
      const tunnels = new Set();
      unavailable.on("connect", (_req, socket) => {
        failedConnects++;
        socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
      });
      proxy.on("connect", (req, socket, head) => {
        connections++;
        tunnels.add(socket);
        assert.equal(
          req.headers["proxy-authorization"],
          `Basic ${Buffer.from("user:password").toString("base64")}`
        );
        const upstream = net.connect(port, "127.0.0.1", () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) upstream.write(head);
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
        tunnels.add(upstream);
        socket.on("error", () => upstream.destroy());
        upstream.on("error", () => socket.destroy());
        socket.on("close", () => upstream.destroy());
      });
      proxy.listen(0, "127.0.0.1");
      unavailable.listen(0, "127.0.0.1");
      await Promise.all([once(proxy, "listening"), once(unavailable, "listening")]);
      const client = transport(
        async () =>
          `PROXY 127.0.0.1:${unavailable.address().port}; PROXY 127.0.0.1:1; ${secure ? "HTTPS" : "PROXY"} 127.0.0.1:${proxy.address().port}`,
        async () => JSON.stringify({ username: "user", password: "password" })
      );
      const network = { proxy: { mode: "system", mandatory: true, credentialSlot: "proxy" } };
      try {
        const response = await client.request(`https://127.0.0.1:${port}/proxied`, {
          caPem: ca,
          network,
        });
        assert.equal(response.status, 200);
        const ws = await client.createSocket(`wss://127.0.0.1:${port}/proxied`, {
          caPem: ca,
          network,
        });
        await once(ws, "open");
        ws.close();
        await once(ws, "close");
        assert.equal(connections, 2);
        assert.equal(failedConnects, 2);
        const before = requests.length;
        await assert.rejects(
          transport(async () => `PROXY 127.0.0.1:${unavailable.address().port}; DIRECT`).request(
            `https://127.0.0.1:${port}/must-not-connect-directly`,
            { caPem: ca, network: { proxy: { mode: "system", mandatory: true } } }
          ),
          { code: "PROXY_FAILED" }
        );
        assert.equal(requests.length, before);
      } finally {
        for (const tunnel of tunnels) tunnel.destroy();
        await Promise.all([
          new Promise((resolve) => proxy.close(resolve)),
          new Promise((resolve) => unavailable.close(resolve)),
        ]);
      }
    }
  );

test("body deadline and cancellation close real requests", local, async () => {
  await assert.rejects(
    transport().request(`https://127.0.0.1:${port}/stall`, {
      caPem: ca,
      network: { httpTimeoutMs: 100 },
    })
  );
  const controller = new AbortController();
  const pending = transport().request(`https://127.0.0.1:${port}/stall`, {
    caPem: ca,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending);
});

test("PAC lookup obeys cancellation and both deadlines before creating a connection", async () => {
  for (const kind of ["cancel", "connect", "http"]) {
    let finish;
    let socketsCreated = 0;
    const client = createEnterpriseAudioTransport({
      resolveProxy: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      WebSocketClass: class {
        constructor() {
          socketsCreated++;
        }
      },
    });
    const controller = new AbortController();
    const options = {
      signal: controller.signal,
      network: {
        connectTimeoutMs: kind === "connect" ? 20 : 1000,
        httpTimeoutMs: kind === "http" ? 20 : 1000,
      },
    };
    const pending = client.request("https://127.0.0.1:1/audio", options);
    if (kind === "cancel") controller.abort();
    await assert.rejects(pending);
    finish("DIRECT");
    await new Promise(setImmediate);
    assert.equal(socketsCreated, 0);
  }
  const pending = transport(() => new Promise(() => {})).createSocket("wss://127.0.0.1:1/audio", {
    network: { connectTimeoutMs: 20 },
  });
  await assert.rejects(pending, { code: "TIMEOUT" });
});

test(
  "realtime profile validation preserves an immediate session.created message",
  local,
  async () => {
    const { createEnterpriseAudioRuntime } = require("../../src/helpers/enterpriseAudioRuntime");
    const Streaming = require("../../src/helpers/openaiRealtimeStreaming");
    const endpoint = https.createServer(certificate);
    const realtime = new WebSocketServer({ server: endpoint });
    let updates = 0;
    realtime.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "session.created" }));
      socket.on("message", (data) => {
        if (JSON.parse(data).type !== "session.update") return;
        updates++;
        socket.send(JSON.stringify({ type: "session.updated" }));
      });
    });
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const resolved = {
      managed: true,
      provider: "openai-compatible",
      version: 1,
      generation: 1,
      identity: { accountId: "account-a", workspaceId: "workspace-a" },
      certificateBundles: [{ id: "ca", pem: ca }],
      config: {
        network: { caBundleId: "ca", proxy: { mode: "direct" } },
        realtime: {
          endpoint: `wss://127.0.0.1:${endpoint.address().port}/realtime`,
          defaultDeployment: "gpt-4o-mini-transcribe",
          protocol: "openai-transcription-ga",
          authentication: { type: "bearer", credentialSlot: "socket" },
        },
      },
    };
    const runtime = createEnterpriseAudioRuntime({
      resolveProvider: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return resolved;
      },
      credentials: { generation: 1, read: async () => "local-test" },
      transport: transport(),
    });
    const streaming = new Streaming();
    try {
      const profile = await runtime.resolve({}, "realtime");
      await streaming.connect({
        model: profile.model,
        protocol: profile.protocol,
        createSocket: () => profile.createSocket(),
        connectTimeoutMs: 500,
      });
      assert.equal(streaming.isConnected, true);
      assert.equal(updates, 1);
    } finally {
      await streaming.disconnect();
      for (const socket of realtime.clients) socket.terminate();
      realtime.close();
      endpoint.closeAllConnections();
      await new Promise((resolve) => endpoint.close(resolve));
    }
  }
);
