"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { enqueueMeetingReprocess } = require("../../src/helpers/reprocessMeetings");

function fakeDb(rows) {
  return {
    lastSql: null,
    prepare(sql) {
      this.lastSql = sql;
      return { all: () => rows };
    },
  };
}

function fakeQueue() {
  const jobs = [];
  return { jobs, enqueue: (id, fn) => jobs.push({ id, fn }) };
}

test("enqueues one reprocess job per meeting with saved audio", () => {
  const db = fakeDb([{ id: 1 }, { id: 7 }, { id: 42 }]);
  const queue = fakeQueue();
  const runCalls = [];
  const pipeline = { run: (noteId, opts) => runCalls.push({ noteId, opts }) };

  const count = enqueueMeetingReprocess({
    db,
    backgroundJobQueue: queue,
    postCallPipelineManager: pipeline,
  });

  assert.equal(count, 3);
  assert.equal(queue.jobs.length, 3);
  assert.deepEqual(
    queue.jobs.map((j) => j.id),
    ["post-call-reprocess-1", "post-call-reprocess-7", "post-call-reprocess-42"]
  );
});

test("each queued job runs the full pipeline from the retranscribe step", () => {
  const db = fakeDb([{ id: 5 }]);
  const queue = fakeQueue();
  const runCalls = [];
  const pipeline = { run: (noteId, opts) => runCalls.push({ noteId, opts }) };

  enqueueMeetingReprocess({ db, backgroundJobQueue: queue, postCallPipelineManager: pipeline });

  // Jobs are deferred — nothing runs until the queue invokes the thunk.
  assert.equal(runCalls.length, 0);
  queue.jobs[0].fn();
  assert.deepEqual(runCalls, [{ noteId: 5, opts: { fromStep: "retranscribe" } }]);
});

test("no meetings with saved audio -> zero jobs, count 0", () => {
  const db = fakeDb([]);
  const queue = fakeQueue();
  const pipeline = { run: () => {} };

  const count = enqueueMeetingReprocess({
    db,
    backgroundJobQueue: queue,
    postCallPipelineManager: pipeline,
  });

  assert.equal(count, 0);
  assert.equal(queue.jobs.length, 0);
});

test("query filters to meeting notes that have saved audio", () => {
  const db = fakeDb([]);
  enqueueMeetingReprocess({
    db,
    backgroundJobQueue: fakeQueue(),
    postCallPipelineManager: { run: () => {} },
  });
  assert.match(db.lastSql, /note_type = 'meeting'/);
  assert.match(db.lastSql, /system_audio_path IS NOT NULL OR mic_audio_path IS NOT NULL/);
});
