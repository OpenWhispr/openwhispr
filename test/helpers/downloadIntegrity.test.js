const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function setup(t, body, offset = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-integrity-"));
  const dest = path.join(dir, "model.bin");
  const electron = require.resolve("electron");
  const modulePath = require.resolve("../../src/helpers/downloadUtils");
  const prior = require.cache[electron];
  const requests = [];
  require.cache[electron] = {
    exports: {
      app: { isReady: () => false },
      net: {
        request(options) {
          requests.push(options);
          const req = new EventEmitter();
          req.setHeader = () => {};
          req.abort = () => {};
          req.end = () =>
            queueMicrotask(() => {
              const response = new PassThrough();
              response.statusCode = offset ? 206 : 200;
              response.headers = {
                "content-length": String(body.length),
                "content-range": `bytes ${offset}-${offset + body.length - 1}/${offset + body.length}`,
              };
              req.emit("response", response);
              response.end(body);
            });
          return req;
        },
      },
    },
  };
  delete require.cache[modulePath];
  const api = require(modulePath);
  t.after(() => {
    delete require.cache[modulePath];
    if (prior) require.cache[electron] = prior;
    else delete require.cache[electron];
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { ...api, dest, requests };
}

test("incorrect bytes never replace an existing installed model", async (t) => {
  const { downloadFile, dest } = setup(t, Buffer.from("corrupted"));
  fs.writeFileSync(dest, "working model");
  await assert.rejects(
    downloadFile("https://example.com/model", dest, {
      expectedSha256: digest("correct"),
      maxRetries: 0,
    }),
    /SHA-256/
  );
  assert.equal(fs.readFileSync(dest, "utf8"), "working model");
  assert.equal(fs.existsSync(`${dest}.tmp`), false);
});

test("a resumed download hashes the entire temporary file before installation", async (t) => {
  const { downloadFile, dest } = setup(t, Buffer.from("suffix"), 6);
  fs.writeFileSync(`${dest}.tmp`, "prefix");
  await downloadFile("https://example.com/model", dest, {
    expectedSha256: digest("prefixsuffix"),
    maxRetries: 0,
  });
  assert.equal(fs.readFileSync(dest, "utf8"), "prefixsuffix");
});

test("corrupted resumed bytes fail even when the fetched suffix is correct", async (t) => {
  const { downloadFile, dest } = setup(t, Buffer.from("suffix"), 6);
  fs.writeFileSync(`${dest}.tmp`, "broken");
  await assert.rejects(
    downloadFile("https://example.com/model", dest, {
      expectedSha256: digest("prefixsuffix"),
      maxRetries: 0,
    }),
    /SHA-256/
  );
  assert.equal(fs.existsSync(dest), false);
});

test("reused artifacts are verified against the expected digest", async (t) => {
  const { verifyFileSha256, dest } = setup(t, Buffer.alloc(0));
  fs.writeFileSync(dest, "archive");
  await verifyFileSha256(dest, digest("archive"));
  await assert.rejects(verifyFileSha256(dest, digest("other")), /SHA-256/);
});

test("model archive entries cannot escape their declared root or create links", () => {
  const { assertSafeModelArchiveEntry } = require("../../src/helpers/modelArchiveIntegrity");
  for (const name of ["root/encoder.onnx", "root/sub/tokens.txt", "./root/"]) {
    assert.doesNotThrow(() =>
      assertSafeModelArchiveEntry(
        { path: name, type: name.endsWith("/") ? "Directory" : "File" },
        "root"
      )
    );
  }
  for (const name of [
    "../outside",
    "/root/file",
    "root/../../file",
    "root/..\\outside",
    "C:/root/file",
    "other/file",
  ]) {
    assert.throws(
      () => assertSafeModelArchiveEntry({ path: name, type: "File" }, "root"),
      /Unsafe/
    );
  }
  for (const type of ["SymbolicLink", "Link", "CharacterDevice", "FIFO"]) {
    assert.throws(() => assertSafeModelArchiveEntry({ path: "root/file", type }, "root"), /Unsafe/);
  }
});

test("complete compressed archives are checked before extraction", async (t) => {
  const { validateModelArchive } = require("../../src/helpers/modelArchiveIntegrity");
  const { dest } = setup(t, Buffer.alloc(0));
  const archives = require("../fixtures/model-archives.json");
  fs.writeFileSync(dest, Buffer.from(archives.valid, "base64"));
  await validateModelArchive(dest, "root");
  for (const name of ["traversal", "link"]) {
    fs.writeFileSync(dest, Buffer.from(archives[name], "base64"));
    await assert.rejects(validateModelArchive(dest, "root"), /Unsafe/);
  }
});

test("cancelling archive verification stops the read before extraction can begin", async (t) => {
  const { validateModelArchive } = require("../../src/helpers/modelArchiveIntegrity");
  const { createDownloadSignal, dest } = setup(t, Buffer.alloc(0));
  fs.writeFileSync(
    dest,
    Buffer.from(require("../fixtures/large-model-archive.json").base64, "base64")
  );
  const { signal, abort } = createDownloadSignal();
  const previousAbort = () => {};
  signal.onAbort = previousAbort;
  const verifying = validateModelArchive(dest, "root", signal);
  setTimeout(abort, 50);
  await assert.rejects(verifying, /abort|cancel/i);
  assert.equal(signal.onAbort, previousAbort);
  // The worker has exited, so callers can immediately remove the archive on Windows too.
  fs.unlinkSync(dest);
});
