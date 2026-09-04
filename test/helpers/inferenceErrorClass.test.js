const test = require("node:test");
const assert = require("node:assert");

const { classifyInferenceError } = require("../../src/helpers/inferenceErrorClass");

const err = (message, code) => {
  const e = new Error(message);
  if (code) e.code = code;
  return e;
};

test("scheduler contention is transient", () => {
  assert.equal(classifyInferenceError(err("busy", "LOCAL_INFERENCE_BUSY")), "transient");
  assert.equal(classifyInferenceError(err("full", "LOCAL_INFERENCE_QUEUE_FULL")), "transient");
});

test("llama-server request failures are transient", () => {
  assert.equal(classifyInferenceError(err("socket", "LLAMA_REQUEST_FAILED")), "transient");
  assert.equal(classifyInferenceError(err("500", "LLAMA_BAD_STATUS")), "transient");
});

test("a request that burned the whole timeout is slow, not transient", () => {
  // Retrying it three more times means tens of minutes of the same thrash.
  assert.equal(classifyInferenceError(err("timed out", "LLAMA_REQUEST_TIMEOUT")), "slow");
});

test("a startup SIGKILL is slow, and never genuine", () => {
  // The most likely failure on a memory-pressured machine. Writing a gap marker
  // for it would put a permanent hole in the user's notes over an OOM — but so
  // would loading a 5.4GB model four times in a row on a thrashing machine.
  for (const e of [
    err("llama-server process died during startup (signal: SIGKILL)", "LLAMA_START_FAILED"),
    err("failed to start within 120000ms", "LLAMA_START_TIMEOUT"),
  ]) {
    assert.equal(classifyInferenceError(e), "slow");
    assert.notEqual(classifyInferenceError(e), "genuine");
  }
});

test("an over-context chunk and an empty reply are genuine", () => {
  assert.equal(classifyInferenceError(err("too long", "LOCAL_CONTEXT_EXCEEDED")), "genuine");
  assert.equal(classifyInferenceError(err("empty", "EMPTY_RESPONSE")), "genuine");
});

test("a missing model or binary is fatal", () => {
  assert.equal(classifyInferenceError(err("gone", "MODEL_NOT_DOWNLOADED")), "fatal");
  assert.equal(classifyInferenceError(err("gone", "LLAMASERVER_NOT_FOUND")), "fatal");
  assert.equal(classifyInferenceError(err("gone", "MODEL_NOT_FOUND")), "fatal");
});

test("cancellation is fatal to the job, not a retryable failure", () => {
  assert.equal(classifyInferenceError(err("cancelled", "LOCAL_INFERENCE_ABORTED")), "fatal");
});

test("an unrecognised error defaults to transient, never genuine", () => {
  assert.equal(classifyInferenceError(err("something nobody predicted")), "transient");
  assert.equal(classifyInferenceError(err("boom", "TOTALLY_NEW_CODE")), "transient");
  assert.equal(classifyInferenceError(undefined), "transient");
  assert.equal(classifyInferenceError("a bare string"), "transient");
});

test("falls back to message matching when the code was lost in wrapping", () => {
  // modelManagerBridge historically collapsed everything into INFERENCE_FAILED.
  // Pinned by message as well as code: a rewrap that loses the code must not
  // silently restore the four-attempt policy.
  assert.equal(
    classifyInferenceError(
      err("Inference failed: llama-server request timed out", "INFERENCE_FAILED")
    ),
    "slow"
  );
  assert.equal(
    classifyInferenceError(err("Inference failed: socket hang up", "INFERENCE_FAILED")),
    "transient"
  );
  assert.equal(
    classifyInferenceError(err("connect ECONNREFUSED 127.0.0.1:8080")),
    "transient"
  );
});

test("a bare INFERENCE_FAILED with no recognisable cause is transient", () => {
  assert.equal(classifyInferenceError(err("Inference failed: ???", "INFERENCE_FAILED")), "transient");
});
