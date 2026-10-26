const assert = require("node:assert/strict");
const test = require("node:test");

const registry = require("../../src/models/modelRegistryData.json");
const table = require("../../src/models/localSetupTable.json");

const load = () => import("../../src/components/onboarding/localSetupDownloadState.ts");

const textBytes = (id) =>
  registry.localProviders.flatMap((p) => p.models).find((m) => m.id === id).sizeBytes;

const dictation = { kind: "parakeet", id: "parakeet-unified-en-0.6b", bytes: 631e6 };
const cleanup = { kind: "llm", id: "qwen3.5-2b-q4_k_m", bytes: textBytes("qwen3.5-2b-q4_k_m") };
const assistant = { kind: "llm", id: "qwen3.5-4b-q4_k_m", bytes: textBytes("qwen3.5-4b-q4_k_m") };
const pack = {
  kind: "llamaVulkan",
  id: "llama-vulkan",
  bytes: table.graphicsPackBytes["win32-x64"],
};
const key = (item) => `${item.kind}:${item.id}`;

const queue = (cleanupItems = [cleanup]) => [
  { rowId: "dictation", items: [dictation] },
  { rowId: "cleanup", items: cleanupItems },
  { rowId: "assistant", items: [assistant] },
];

async function harness(rows = queue()) {
  const m = await load();
  let state = m.createLocalSetupDownloadState(rows);
  const send = (event) => {
    state = m.reduce(state, event);
    return state;
  };
  const run = () => state.active?.run;
  return {
    ...m,
    send,
    get state() {
      return state;
    },
    status: (rowId) => m.rowStatus(state, rowId),
    percent: (rowId) => m.rowPercent(state, rowId),
    statuses: () => ["dictation", "cleanup", "assistant"].map((id) => m.rowStatus(state, id)),
    active: () => m.activeItem(state),
    progress: (percent) => send({ type: "progress", run: run(), percent }),
    installing: () => send({ type: "installing", run: run() }),
    complete: () => send({ type: "complete", run: run() }),
    fail: () => send({ type: "fail", run: run() }),
  };
}

test("rows run one at a time in order", async () => {
  const h = await harness();
  assert.deepEqual(h.statuses(), ["waiting", "waiting", "waiting"]);
  assert.equal(h.state.started, false);
  assert.equal(h.active(), null, "nothing downloads before start");

  h.send({ type: "start" });
  assert.equal(h.state.started, true);
  assert.deepEqual(h.statuses(), ["downloading", "waiting", "waiting"]);
  assert.equal(key(h.active()), key(dictation));

  const dictationRun = h.state.active.run;
  h.complete();
  assert.deepEqual(h.statuses(), ["done", "downloading", "waiting"]);
  assert.equal(key(h.active()), key(cleanup));

  // A late result from the finished item must not touch the one now running.
  h.send({ type: "complete", run: dictationRun });
  assert.deepEqual(h.statuses(), ["done", "downloading", "waiting"]);
  h.send({ type: "start" });
  assert.equal(key(h.active()), key(cleanup), "a second start does not restart the queue");

  h.complete();
  assert.deepEqual(h.statuses(), ["done", "done", "downloading"]);
  h.complete();
  assert.deepEqual(h.statuses(), ["done", "done", "done"]);
  assert.equal(h.active(), null);
  assert.equal(h.allEnabledDone(h.state), true);
});

test("installing is not done", async () => {
  const h = await harness();
  h.send({ type: "start" });
  h.progress(40);
  assert.equal(h.status("dictation"), "downloading");
  assert.equal(h.percent("dictation"), 40);

  h.installing();
  assert.equal(h.status("dictation"), "installing");
  assert.equal(h.percent("dictation"), 100, "the pie stays full while it unpacks");
  assert.equal(h.allEnabledDone(h.state), false);
  assert.equal(key(h.active()), key(dictation), "the queue waits for the unpack");
  assert.equal(h.status("cleanup"), "waiting");

  h.progress(50);
  assert.equal(h.status("dictation"), "installing", "a stray progress event cannot rewind it");

  h.complete();
  assert.equal(h.status("dictation"), "done");
  assert.equal(h.status("cleanup"), "downloading");
});

test("failure does not stop the queue", async () => {
  const h = await harness();
  h.send({ type: "start" });
  h.progress(30);
  h.fail();
  assert.deepEqual(h.statuses(), ["failed", "downloading", "waiting"]);
  assert.equal(key(h.active()), key(cleanup));

  h.complete();
  h.complete();
  assert.deepEqual(h.statuses(), ["failed", "done", "done"]);
  assert.equal(h.active(), null);
  assert.equal(h.allEnabledDone(h.state), false, "Proceed stays locked on a failed row");
});

test("a failed model skips the rest of its row", async () => {
  const h = await harness(queue([cleanup, pack]));
  h.send({ type: "start" });
  h.complete();
  h.fail();
  assert.equal(h.status("cleanup"), "failed");
  assert.equal(key(h.active()), key(assistant), "the pack does not download for a failed row");
});

test("a failed graphics pack does not fail its row or lock Proceed", async () => {
  const h = await harness(queue([cleanup, pack]));
  h.send({ type: "start" });
  h.complete(); // dictation
  h.complete(); // cleanup model
  assert.equal(key(h.active()), key(pack));
  h.progress(40);
  h.fail();

  // The model runs on the processor without the pack; Settings can add it later.
  assert.equal(h.status("cleanup"), "done", "the row counts done once its model is on disk");
  assert.equal(h.percent("cleanup"), 100, "its pie is full");
  assert.equal(key(h.active()), key(assistant), "the queue moves on");
  h.send({ type: "retry", rowId: "cleanup" });
  assert.equal(key(h.active()), key(assistant), "no Retry for a row that is done");

  h.complete();
  assert.deepEqual(h.statuses(), ["done", "done", "done"]);
  assert.equal(h.allEnabledDone(h.state), true, "Proceed unlocks");
});

test("a failed model with a pack behind it still fails its row, with Retry", async () => {
  const h = await harness(queue([cleanup, pack]));
  h.send({ type: "start" });
  h.complete();
  h.fail(); // cleanup model
  h.complete(); // assistant
  assert.equal(h.status("cleanup"), "failed");
  assert.equal(h.allEnabledDone(h.state), false, "Proceed stays locked");

  h.send({ type: "retry", rowId: "cleanup" });
  assert.equal(key(h.active()), key(cleanup), "Retry downloads the model again");
  h.complete();
  assert.equal(key(h.active()), key(pack), "then its pack");
  h.complete();
  assert.equal(h.status("cleanup"), "done");
  assert.equal(h.allEnabledDone(h.state), true);
});

test("retry re-queues a failed row after the current one", async () => {
  const h = await harness();
  h.send({ type: "start" });
  h.fail();
  assert.equal(key(h.active()), key(cleanup));

  h.send({ type: "retry", rowId: "dictation" });
  assert.deepEqual(h.statuses(), ["waiting", "downloading", "waiting"]);
  assert.equal(key(h.active()), key(cleanup), "retry does not interrupt the current download");

  h.complete();
  assert.deepEqual(h.statuses(), ["downloading", "done", "waiting"]);
  assert.equal(key(h.active()), key(dictation), "the retried row runs before the assistant");
  assert.equal(h.percent("dictation"), 0);

  h.complete();
  assert.equal(key(h.active()), key(assistant));
  h.complete();
  assert.equal(h.allEnabledDone(h.state), true);

  h.send({ type: "retry", rowId: "cleanup" });
  assert.equal(h.active(), null, "retrying a row that is not failed does nothing");
});

test("retry with nothing running starts the row at once", async () => {
  const h = await harness([{ rowId: "dictation", items: [dictation] }]);
  h.send({ type: "retry", rowId: "dictation" });
  assert.equal(h.active(), null, "retry before start does nothing");

  h.send({ type: "start" });
  h.fail();
  assert.equal(h.active(), null);
  assert.equal(h.status("dictation"), "failed");

  h.send({ type: "retry", rowId: "dictation" });
  assert.equal(h.status("dictation"), "downloading");
  h.complete();
  assert.equal(h.allEnabledDone(h.state), true);
});

test("rows already on disk start done", async () => {
  const h = await harness(queue([cleanup, pack]));
  h.send({ type: "inventory", onDisk: [key(dictation), key(cleanup)] });
  assert.deepEqual(h.statuses(), ["done", "waiting", "waiting"]);
  assert.equal(h.percent("cleanup"), 97, "the model on disk counts, the missing pack does not");
  assert.equal(h.allEnabledDone(h.state), false);

  h.send({ type: "start" });
  assert.equal(key(h.active()), key(pack), "only the missing item downloads");

  const all = await harness();
  all.send({ type: "inventory", onDisk: [dictation, cleanup, assistant].map(key) });
  assert.deepEqual(all.statuses(), ["done", "done", "done"]);
  assert.equal(all.allEnabledDone(all.state), true, "everything on disk before start");
  all.send({ type: "start" });
  assert.equal(all.active(), null);
});

test("switching rows before start keeps what the inventory found", async () => {
  const h = await harness();
  h.send({ type: "inventory", onDisk: [key(dictation), key(cleanup)] });
  h.send({ type: "configure", rows: queue().slice(0, 2) });
  assert.deepEqual(h.statuses(), ["done", "done", "waiting"]);
  assert.equal(h.allEnabledDone(h.state), true, "a switched-off row is not waited for");

  h.send({ type: "configure", rows: queue() });
  assert.equal(h.allEnabledDone(h.state), false);
  h.send({ type: "start" });
  assert.equal(key(h.active()), key(assistant));
  h.send({ type: "configure", rows: queue().slice(0, 1) });
  assert.equal(key(h.active()), key(assistant), "the rows lock once downloading starts");
});

test("percent is weighted by bytes across a row's items", async () => {
  const h = await harness(queue([cleanup, pack]));
  h.send({ type: "start" });
  h.complete();
  h.progress(50);
  const halfModel = Math.floor((50 * cleanup.bytes) / (cleanup.bytes + pack.bytes));
  assert.equal(h.percent("cleanup"), halfModel);

  h.complete();
  assert.equal(key(h.active()), key(pack));
  assert.equal(h.status("cleanup"), "downloading", "the row is not done until its pack is");
  assert.equal(h.percent("cleanup"), 97, "qwen 2B done + pack at 0%");

  h.progress(50);
  assert.equal(h.percent("cleanup"), 98);
  h.complete();
  assert.equal(h.status("cleanup"), "done");
  assert.equal(h.percent("cleanup"), 100);
});

test("local-setup downloads stay identifiable a short while after they end", async () => {
  const m = await load();
  const item = { kind: "parakeet", id: "test-model" };
  assert.equal(m.isLocalSetupDownload("parakeet", "test-model"), false);

  m.claimLocalSetupDownload(item);
  assert.equal(m.isLocalSetupDownload("parakeet", "test-model"), true);
  assert.equal(m.isLocalSetupDownload("whisper", "test-model"), false);

  m.releaseLocalSetupDownload(item, 1_000);
  assert.equal(m.isLocalSetupDownload("parakeet", "test-model", 2_000), true);
  assert.equal(m.isLocalSetupDownload("parakeet", "test-model", 10_000), false);
});
