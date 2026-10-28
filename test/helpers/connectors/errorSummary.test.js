const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../../src/helpers/connectors/errorSummary.js");

test("an error summary keeps the name and code, never the message", async () => {
  const { describeError } = await load();
  const error = Object.assign(
    new TypeError("fetch failed https://slack.com/api/chat.postMessage?token=xoxp-1"),
    { cause: { code: "ECONNRESET" } }
  );

  assert.deepEqual(describeError(error), { errorName: "TypeError", errorCode: "ECONNRESET" });
  assert.deepEqual(
    describeError(Object.assign(new Error("x"), { redirectCode: "token_exchange_failed" })),
    {
      errorName: "Error",
      errorCode: "token_exchange_failed",
    }
  );
  assert.deepEqual(describeError(undefined), { errorName: "Error", errorCode: null });
  assert.doesNotMatch(JSON.stringify(describeError(error)), /xoxp|slack\.com/);
});
