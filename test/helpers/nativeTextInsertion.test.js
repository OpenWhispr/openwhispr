const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { tryNativeInsertion } = require("../../src/helpers/nativeTextInsertion");
function nativeReply(code) {
  return () => {
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => queueMicrotask(() => child.emit("close", code));
    child.kill = () => {};
    return child;
  };
}
test("native success and explicit unsupported have distinct outcomes", async () => {
  assert.equal(
    await tryNativeInsertion("你好", { binary: "helper", spawnProcess: nativeReply(0) }),
    true
  );
  assert.equal(
    await tryNativeInsertion("hello", { binary: "helper", spawnProcess: nativeReply(2) }),
    false
  );
});
test("uncertain native insertion cannot fall through to a duplicate paste", async () => {
  await assert.rejects(
    tryNativeInsertion("hello", { binary: "helper", spawnProcess: nativeReply(3) }),
    /uncertain/
  );
});
test("missing helper and oversized input permit existing clipboard fallback", async () => {
  assert.equal(await tryNativeInsertion("hello", { binary: null }), false);
  assert.equal(await tryNativeInsertion("x".repeat(1048577), { binary: "helper" }), false);
});
