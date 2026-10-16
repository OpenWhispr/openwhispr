const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const SOURCE = fs.readFileSync(path.resolve("src/helpers/downloadUtils.js"), "utf8");
const PAYLOAD = Buffer.from("abcdefghij");

// Real file opens/truncation and stream cleanup, with an explicitly scripted
// server. Successful responses honor the actual Range header received.
function createHarness(t, attempts, initialBytes = 4) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "download-resume-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const destination = path.join(dir, "model.bin");
  if (initialBytes) fs.writeFileSync(`${destination}.tmp`, PAYLOAD.subarray(0, initialBytes));
  const ranges = [];
  let current;
  const context = vm.createContext({
    module: { exports: {} },
    __dirname: path.resolve("src/helpers"),
    process,
    // Backoff is advanced explicitly; stall timers never fire in this fixture.
    setTimeout(callback, delay) {
      if (delay < 30000) queueMicrotask(callback);
      return {};
    },
    clearTimeout() {},
    require(name) {
      if (name === "./debugLogger") return { info() {}, warn() {}, error() {} };
      if (name === "./systemTar") return {};
      if (name === "fs") {
        return {
          ...fs,
          createWriteStream(file, options) {
            const stream = fs.createWriteStream(file, options);
            const { response, attempt, offset } = current;
            // 'open' is after O_TRUNC. Premature EOF therefore happens after
            // the old prefix is gone, without racing the file open.
            stream.once("open", () => {
              response.end(PAYLOAD.subarray(offset, attempt.incompleteBytes));
            });
            return stream;
          },
        };
      }
      if (name === "electron") {
        return {
          net: {
            request() {
              const request = new EventEmitter();
              let range = null;
              request.setHeader = (name, value) => {
                if (name === "Range") range = value;
              };
              request.abort = () => {};
              request.end = () => {
                queueMicrotask(() => {
                  const attempt = attempts[ranges.length];
                  assert.ok(attempt, "unexpected extra download attempt");
                  ranges.push(range);
                  const offset = attempt.ignoreRange || !range ? 0 : Number(range.match(/\d+/)[0]);
                  const response = new PassThrough();
                  response.statusCode = offset ? 206 : 200;
                  response.headers = { "content-length": String(PAYLOAD.length - offset) };
                  if (offset) {
                    response.headers["content-range"] = `bytes ${offset}-9/10`;
                  }
                  current = { response, attempt, offset };
                  request.emit("response", response);
                });
              };
              return request;
            },
          },
        };
      }
      return require(name);
    },
  });
  vm.runInContext(SOURCE, context);
  return {
    destination,
    ranges,
    download: () =>
      context.module.exports.downloadFile("https://example.com/model.bin", destination, {
        maxRetries: attempts.length - 1,
      }),
  };
}

test("a resumed download appends the requested suffix to its existing prefix", async (t) => {
  const h = createHarness(t, [{}]);
  assert.equal(await h.download(), h.destination);
  assert.deepEqual(fs.readFileSync(h.destination), PAYLOAD);
  assert.deepEqual(h.ranges, ["bytes=4-"]);
  assert.equal(fs.existsSync(`${h.destination}.tmp`), false);
});

test("retry after a failed full-response restart downloads the missing prefix too", async (t) => {
  const h = createHarness(t, [{ ignoreRange: true, incompleteBytes: 0 }, {}]);
  assert.equal(await h.download(), h.destination);
  assert.deepEqual(fs.readFileSync(h.destination), PAYLOAD);
  assert.deepEqual(h.ranges, ["bytes=4-", null]);
  assert.equal(fs.existsSync(`${h.destination}.tmp`), false);
});

test("a completed full response replaces the old prefix when Range is ignored", async (t) => {
  const h = createHarness(t, [{ ignoreRange: true }]);
  await h.download();
  assert.deepEqual(fs.readFileSync(h.destination), PAYLOAD);
  assert.deepEqual(h.ranges, ["bytes=4-"]);
});

test("retry resumes from a shorter replacement prefix, not the original prefix", async (t) => {
  const h = createHarness(t, [{ ignoreRange: true, incompleteBytes: 2 }, {}]);
  await h.download();
  assert.deepEqual(fs.readFileSync(h.destination), PAYLOAD);
  assert.deepEqual(h.ranges, ["bytes=4-", "bytes=2-"]);
});

test("a fresh download recovers when its retry loses the first attempt's prefix", async (t) => {
  const h = createHarness(
    t,
    [{ incompleteBytes: 4 }, { ignoreRange: true, incompleteBytes: 0 }, {}],
    0
  );
  await h.download();
  assert.deepEqual(fs.readFileSync(h.destination), PAYLOAD);
  assert.deepEqual(h.ranges, [null, "bytes=4-", null]);
});
