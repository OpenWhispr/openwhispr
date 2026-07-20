const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

function createElectronMock(response) {
  return {
    app: { isReady: () => false },
    net: {
      request() {
        const request = new EventEmitter();
        request.setHeader = () => {};
        request.abort = () => {};
        request.end = () => queueMicrotask(() => request.emit("response", response));
        return request;
      },
    },
  };
}

test("downloadFile waits for a cancelled write stream to close before removing its temp file", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "downloadUtils-test-"));
  const destination = path.join(tempDir, "model.bin");
  const response = new PassThrough();
  response.statusCode = 200;
  response.headers = {};

  const electronPath = require.resolve("electron");
  const downloadUtilsPath = require.resolve("../../src/helpers/downloadUtils.js");
  const originalElectronCache = require.cache[electronPath];
  const originalCreateWriteStream = fs.createWriteStream;
  let releaseOpen;
  const openGate = new Promise((resolve) => (releaseOpen = resolve));
  let onOpenStarted;
  const openStarted = new Promise((resolve) => (onOpenStarted = resolve));
  const order = [];

  require.cache[electronPath] = { exports: createElectronMock(response) };
  delete require.cache[downloadUtilsPath];

  fs.createWriteStream = (filePath, options) => {
    const stream = originalCreateWriteStream(filePath, {
      ...options,
      fs: {
        open: (...args) => {
          const callback = args.at(-1);
          onOpenStarted();
          openGate.then(() => fs.open(...args.slice(0, -1), callback));
        },
        write: fs.write.bind(fs),
        writev: fs.writev.bind(fs),
        close: fs.close.bind(fs),
      },
    });
    stream.once("close", () => order.push("close"));
    return stream;
  };

  try {
    const { createDownloadSignal, downloadFile } = require(downloadUtilsPath);
    const { signal, abort } = createDownloadSignal();
    let settled = null;
    const done = downloadFile("https://example.com/model.bin", destination, {
      signal,
      maxRetries: 0,
    }).then(
      () => (settled = "resolved"),
      (error) => {
        order.push("rejected");
        settled = error;
      }
    );

    await openStarted;
    abort();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));

    assert.equal(settled, null, "cancellation must not settle while the open is still pending");

    releaseOpen();
    await done;

    assert.equal(settled.isAbort, true);
    assert.deepEqual(order, ["close", "rejected"]);
    assert.equal(
      fs.existsSync(`${destination}.tmp`),
      false,
      "the late open must not leave a temp file"
    );
  } finally {
    fs.createWriteStream = originalCreateWriteStream;
    releaseOpen();
    delete require.cache[downloadUtilsPath];
    if (originalElectronCache) require.cache[electronPath] = originalElectronCache;
    else delete require.cache[electronPath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
