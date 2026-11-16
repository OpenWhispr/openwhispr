const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/utils/urlUtils.ts");

test("a scheme-less endpoint is read as https, as the connection test does", async () => {
  const { withHttpsScheme } = await load();
  assert.equal(withHttpsScheme("stt.example.com/v1"), "https://stt.example.com/v1");
  assert.equal(withHttpsScheme("  http://127.0.0.1:8178 "), "http://127.0.0.1:8178");
  assert.equal(withHttpsScheme("   "), "");
});
