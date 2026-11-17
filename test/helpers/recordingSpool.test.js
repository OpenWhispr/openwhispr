const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer } = require("../lib/rendererTestHarness");

// The spool is what keeps a recording's audio when the main process hangs
// (#2073). A recording it hands back twice, or one that finished normally,
// becomes a phantom history row on the next launch, so these pin which
// sessions come back and in what shape.

// Just the IndexedDB surface recordingSpool uses. Rows live in a Map that
// outlives the module, so seeded rows stand in for a page that died.
function installFakeIndexedDB(t, seed = []) {
  const keyOf = (row) => [row.sessionId, row.seq];
  const compare = (a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] < b[0] ? -1 : 1);
  const rows = new Map(seed.map((row) => [JSON.stringify(keyOf(row)), row]));
  const later = (run) => {
    const request = {};
    setTimeout(() => {
      request.result = run();
      request.onsuccess?.();
    }, 0);
    return request;
  };
  const store = {
    put: (row) => later(() => rows.set(JSON.stringify(keyOf(row)), row)),
    delete: (range) =>
      later(() => {
        for (const [key, row] of rows) if (range.includes(keyOf(row))) rows.delete(key);
      }),
    getAll: () => later(() => [...rows.values()].sort((a, b) => compare(keyOf(a), keyOf(b)))),
  };
  const db = { createObjectStore() {}, transaction: () => ({ objectStore: () => store }) };
  const originals = { indexedDB: globalThis.indexedDB, IDBKeyRange: globalThis.IDBKeyRange };
  globalThis.indexedDB = {
    open() {
      const request = {};
      setTimeout(() => {
        request.result = db;
        request.onupgradeneeded?.();
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };
  globalThis.IDBKeyRange = {
    bound: (lower, upper) => ({
      includes: (key) => compare(key, lower) >= 0 && compare(key, upper) <= 0,
    }),
  };
  t.after(() => Object.assign(globalThis, originals));
  return rows;
}

async function loadSpool(t) {
  const warnings = [];
  globalThis.__spoolWarnings = warnings;
  t.after(() => delete globalThis.__spoolWarnings);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-recording-spool-test-",
    mockModules: {
      "/utils/logger":
        "export default { warn: (message) => globalThis.__spoolWarnings.push(message) };",
    },
  });
  return { ...(await vite.ssrLoadModule("/helpers/recordingSpool.js")), warnings };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const text = (blob) => blob.text();
const deadRow = (seq, segment, at, chunk) => ({
  sessionId: "dead-page",
  seq,
  segment,
  mimeType: "audio/webm;codecs=opus",
  routeKind: "translation",
  startedAt: 1000,
  at,
  chunk: new Blob([chunk]),
});

test("a page that died mid-recording hands its audio back once, one blob per recorder", async (t) => {
  // Seeded out of order: recovery must follow seq, not insertion.
  const rows = installFakeIndexedDB(t, [
    deadRow(2, 1, 4000, "after-swap"),
    deadRow(0, 0, 1250, "header+"),
    deadRow(1, 0, 1500, "speech"),
  ]);
  const { takeInterruptedRecordings } = await loadSpool(t);

  const [recording, ...rest] = await takeInterruptedRecordings();

  assert.equal(rest.length, 0);
  assert.equal(recording.startedAt, 1000);
  assert.equal(recording.durationMs, 3000);
  assert.equal(recording.routeKind, "translation");
  assert.deepEqual(await Promise.all(recording.segments.map(text)), [
    "header+speech",
    "after-swap",
  ]);
  assert.equal(recording.segments[0].type, "audio/webm;codecs=opus");
  assert.deepEqual(await takeInterruptedRecordings(), [], "a second caller gets nothing");

  recording.discard();
  await settle();
  assert.equal(rows.size, 0);
});

test("recordings this page started never come back, and a finished one leaves nothing", async (t) => {
  const rows = installFakeIndexedDB(t);
  const { startRecordingSpool, takeInterruptedRecordings } = await loadSpool(t);

  const finished = startRecordingSpool();
  const appendFinished = finished.addSegment("audio/webm");
  appendFinished(new Blob(["a"]));
  finished.finish();
  // A cancelled recorder's last chunk lands after the cancel.
  appendFinished(new Blob(["late"]));

  const active = startRecordingSpool();
  active.addSegment("audio/webm")(new Blob(["b"]));
  await settle();

  assert.deepEqual(await takeInterruptedRecordings(), []);
  assert.deepEqual(
    [...rows.values()].map((row) => row.seq),
    [0],
    "only the open recording's chunk is stored"
  );
});

test("a database that won't open is reported once and the recording goes on unspooled", async (t) => {
  installFakeIndexedDB(t);
  globalThis.indexedDB = {
    open() {
      const request = { error: new Error("backing store corrupt") };
      setTimeout(() => request.onerror?.(), 0);
      return request;
    },
  };
  const { startRecordingSpool, takeInterruptedRecordings, warnings } = await loadSpool(t);

  const spool = startRecordingSpool();
  const append = spool.addSegment("audio/webm");
  for (const chunk of ["a", "b", "c"]) append(new Blob([chunk]));
  spool.finish();
  await settle();

  assert.deepEqual(await takeInterruptedRecordings(), []);
  assert.deepEqual(warnings, ["Recording spool unavailable"]);
});
