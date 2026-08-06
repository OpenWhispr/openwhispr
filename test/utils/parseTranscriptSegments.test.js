const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/parseTranscriptSegments.ts");

test("parseTranscriptSegments safely handles nullish and non-string inputs", async () => {
  const { parseTranscriptSegments } = await load();
  assert.deepEqual(parseTranscriptSegments(null), []);
  assert.deepEqual(parseTranscriptSegments(undefined), []);
  assert.deepEqual(parseTranscriptSegments(123), []);
});

test("parseTranscriptSegments parses JSON arrays with leading whitespace or newlines", async () => {
  const { parseTranscriptSegments } = await load();
  const jsonWithWhitespace = `
  [
    {
      "text": "Hello world",
      "source": "mic",
      "timestamp": 12345
    }
  ]
  `;
  const result = parseTranscriptSegments(jsonWithWhitespace);
  assert.equal(result.length, 1);
  assert.equal(result[0].text, "Hello world");
  assert.equal(result[0].source, "mic");
  assert.equal(result[0].timestamp, 12345);
});

test("parseTranscriptSegments safely handles arrays with null or non-object elements", async () => {
  const { parseTranscriptSegments } = await load();
  const jsonWithNullElement = `[null, {"text": "Valid", "source": "system"}]`;
  const result = parseTranscriptSegments(jsonWithNullElement);
  assert.equal(result.length, 1);
  assert.equal(result[0].text, "Valid");
  assert.equal(result[0].source, "system");
});
