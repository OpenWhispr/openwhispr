const test = require("node:test");
const assert = require("node:assert/strict");

const TextEditMonitor = require("../../src/helpers/textEditMonitor");

test("getPrecedingChar resolves to unknown for missing pid", async () => {
  const m = new TextEditMonitor();
  for (const pid of [null, undefined, 0]) {
    assert.deepEqual(await m.getPrecedingChar(pid), { state: "unknown" });
  }
});

test("getPrecedingChar returns unknown when the AX read fails or hangs", async () => {
  const m = new TextEditMonitor();
  // Non-darwin short-circuits without shelling out; darwin errors out on an
  // unmapped PID. Both paths must resolve quickly with state "unknown".
  const start = Date.now();
  const result = await m.getPrecedingChar(99999999, 1500);
  assert.equal(result.state, "unknown");
  assert.ok(Date.now() - start < 3000);
});
