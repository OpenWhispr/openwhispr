const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const DOWNLOAD_UTILS = path.join(__dirname, "..", "..", "scripts", "lib", "download-utils.js");

// A real redirect (HuggingFace, GitHub release assets) answers with a body, not
// an empty 302, so the hop we abandon has unread data holding its socket open.
function startRedirectingServer(t) {
  const payload = Buffer.alloc(4096, 7);
  const server = http.createServer((req, res) => {
    if (req.url === "/start") {
      const body = Buffer.from("<html>Redirecting...</html>");
      res.writeHead(302, { Location: "/final", "Content-Length": body.length });
      res.end(body);
      return;
    }
    res.writeHead(200, { "Content-Length": payload.length });
    res.end(payload);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      t.after(() => new Promise((done) => server.close(done)));
      resolve({ url: `http://127.0.0.1:${server.address().port}/start`, size: payload.length });
    });
  });
}

// Run the download in a child so we can see whether node's event loop drains.
// An in-process assertion cannot tell "socket leaked" from "socket pooled".
function downloadInChild(url, dest, timeoutMs = 10000) {
  const source = `
    // download-utils only speaks https; point it at the plain-http test server
    // so this stays offline and needs no certificate.
    require("https").get = require("http").get;
    const { downloadFile } = require(${JSON.stringify(DOWNLOAD_UTILS)});
    downloadFile(${JSON.stringify(url)}, ${JSON.stringify(dest)}).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, ["-e", source], { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ exitCode: null, timedOut: true, elapsedMs: Date.now() - startedAt });
    }, timeoutMs);

    child.on("exit", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, timedOut: false, elapsedMs: Date.now() - startedAt });
    });
  });
}

// Without the drain the child still ends eventually -- after the abandoned
// socket's keep-alive expires locally, or not for minutes against a real CDN --
// so this asserts on how long it takes, not merely that it finished.
const EXIT_BUDGET_MS = 3000;

test("a redirected download lets the process exit instead of hanging predev", async (t) => {
  const { url, size } = await startRedirectingServer(t);
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "download-utils-")), "payload.bin");
  t.after(() => fs.rmSync(path.dirname(dest), { recursive: true, force: true }));

  const { exitCode, timedOut, elapsedMs } = await downloadInChild(url, dest);

  assert.equal(timedOut, false, "download-utils never released the redirect hop's socket");
  assert.equal(exitCode, 0);
  assert.equal(fs.statSync(dest).size, size);
  assert.ok(
    elapsedMs < EXIT_BUDGET_MS,
    `process took ${elapsedMs}ms to exit after a redirected download (budget ${EXIT_BUDGET_MS}ms)`
  );
});
