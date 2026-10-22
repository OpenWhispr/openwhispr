const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const DOWNLOAD_UTILS = path.join(__dirname, "..", "..", "scripts", "lib", "download-utils.js");
const FILE_BODY = Buffer.alloc(64 * 1024, 7);
// Long enough that only an unreleased socket, never the server, could hold the child open.
const SERVER_KEEP_ALIVE_MS = 60_000;
const EXIT_DEADLINE_MS = 5_000;

// Mirrors the Hugging Face and GitHub responses: redirects and errors carry a body.
function startServer() {
  let pendingRedirectSocket = null;
  const server = http.createServer((req, res) => {
    const redirect = (location) => {
      res.writeHead(302, { Location: location, "Content-Type": "text/plain" });
      res.end("Found. Redirecting to " + location + "x".repeat(1024));
    };
    switch (req.url) {
      case "/model.bin":
        return redirect("/cdn/model.bin");
      case "/cdn/model.bin":
        res.writeHead(200, { "Content-Length": FILE_BODY.length });
        return res.end(FILE_BODY);
      case "/repos/owner/repo/releases/latest":
        return redirect("/repos/owner/renamed/releases/latest");
      case "/repos/owner/renamed/releases/latest":
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ tag_name: "v1.0.0", html_url: "u", assets: [] }));
      // A redirect whose body is still arriving when its connection is reset, which only
      // happens once the client has already moved on to the redirect target.
      case "/reset/model.bin":
        res.writeHead(302, { Location: "/reset/cdn/model.bin", "Content-Length": 4096 });
        res.write("Found.");
        pendingRedirectSocket = req.socket;
        return;
      case "/reset/cdn/model.bin":
        pendingRedirectSocket.resetAndDestroy();
        setTimeout(() => {
          res.writeHead(200, { "Content-Length": FILE_BODY.length });
          res.end(FILE_BODY);
        }, 100);
        return;
      case "/repos/owner/missing/releases/latest":
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ message: "Not Found" }));
      case "/repos/owner/stalled/releases/latest":
        return;
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  server.keepAliveTimeout = SERVER_KEEP_ALIVE_MS;
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// Runs `body` in a fresh Node process with https.get pointed at the local server, and
// resolves with how the process ended. A socket left referenced keeps the child alive.
// `requestTimeoutMs` shortens the timeout passed in request options (fetchJson's 30s).
function runChild(port, body, { requestTimeoutMs } = {}) {
  const script = `
    const http = require("http");
    const https = require("https");
    const requestTimeoutMs = ${JSON.stringify(requestTimeoutMs ?? null)};
    https.get = (url, ...rest) => {
      const target = new URL(url);
      if (requestTimeoutMs && rest[0] && typeof rest[0] === "object") {
        rest[0] = { ...rest[0], timeout: requestTimeoutMs };
      }
      return http.get("http://127.0.0.1:${port}" + target.pathname + target.search, ...rest);
    };
    const utils = require(${JSON.stringify(DOWNLOAD_UTILS)});
    (async () => { ${body} })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), EXIT_DEADLINE_MS);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output });
    });
  });
}

async function withServer(fn) {
  const server = await startServer();
  try {
    await fn(server.address().port);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("downloadFile lets the process exit after following a redirect", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "download-utils-"));
  const dest = path.join(dir, "model.bin");
  try {
    await withServer(async (port) => {
      const result = await runChild(
        port,
        `await utils.downloadFile("https://huggingface.co/model.bin", ${JSON.stringify(dest)});`
      );
      assert.equal(result.signal, null, `process did not exit on its own:\n${result.output}`);
      assert.equal(result.code, 0, result.output);
    });
    assert.deepEqual(fs.readFileSync(dest), FILE_BODY);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchLatestRelease lets the process exit after a redirect or an error status", async () => {
  await withServer(async (port) => {
    const result = await runChild(
      port,
      `
        const found = await utils.fetchLatestRelease("owner/repo");
        const missing = await utils.fetchLatestRelease("owner/missing");
        console.log(JSON.stringify({ tag: found && found.tag, missing }));
      `
    );
    assert.equal(result.signal, null, `process did not exit on its own:\n${result.output}`);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /\{"tag":"v1\.0\.0","missing":null\}/);
  });
});

test("downloadFile ignores a reset on the redirect it already followed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "download-utils-"));
  const dest = path.join(dir, "model.bin");
  try {
    await withServer(async (port) => {
      const result = await runChild(
        port,
        `await utils.downloadFile("https://huggingface.co/reset/model.bin", ${JSON.stringify(dest)});`
      );
      assert.equal(result.signal, null, `process did not exit on its own:\n${result.output}`);
      assert.equal(result.code, 0, result.output);
      assert.doesNotMatch(result.output, /Retry/);
    });
    assert.deepEqual(fs.readFileSync(dest), FILE_BODY);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchLatestRelease lets the process exit after a request timeout", async () => {
  await withServer(async (port) => {
    const result = await runChild(
      port,
      `
        const stalled = await utils.fetchLatestRelease("owner/stalled");
        console.log(JSON.stringify({ stalled }));
      `,
      { requestTimeoutMs: 200 }
    );
    assert.equal(result.signal, null, `process did not exit on its own:\n${result.output}`);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Request timeout/);
    assert.match(result.output, /\{"stalled":null\}/);
  });
});
