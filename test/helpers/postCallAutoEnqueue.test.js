const test = require("node:test");
const assert = require("node:assert/strict");

const { enqueuePostCallPipeline } = require("../../src/helpers/postCallAutoEnqueue.js");

function harness({ disabled = false } = {}) {
  const jobs = [];
  const ran = [];
  return {
    jobs,
    ran,
    call: (noteId) =>
      enqueuePostCallPipeline({
        noteId,
        disabled,
        backgroundJobQueue: { enqueue: (id, fn) => jobs.push({ id, fn }) },
        postCallPipelineManager: { run: (id) => ran.push(id) },
      }),
  };
}

test("a finished meeting queues the post-call pipeline", () => {
  const h = harness();

  assert.equal(h.call(42), true);
  assert.equal(h.jobs.length, 1, "the pipeline must actually be kicked off when a call ends");
  assert.equal(h.jobs[0].id, "post-call-42");
});

test("the queued job runs the pipeline for that note", () => {
  const h = harness();
  h.call(42);

  assert.deepEqual(h.ran, [], "the run is deferred to the queue, not executed inline");
  h.jobs[0].fn();
  assert.deepEqual(h.ran, [42]);
});

test("nothing is queued when the user turned the automatic pipeline off", () => {
  const h = harness({ disabled: true });

  assert.equal(h.call(42), false);
  assert.equal(h.jobs.length, 0);
});

test("a missing note id queues nothing", () => {
  const h = harness();

  assert.equal(h.call(undefined), false);
  assert.equal(h.call(null), false);
  assert.equal(h.jobs.length, 0);
});

test("note id 0 is still a note", () => {
  const h = harness();

  assert.equal(h.call(0), true);
  assert.equal(h.jobs[0].id, "post-call-0");
});

test("each meeting gets its own job id", () => {
  const h = harness();
  h.call(1);
  h.call(2);

  assert.deepEqual(
    h.jobs.map((j) => j.id),
    ["post-call-1", "post-call-2"]
  );
});
