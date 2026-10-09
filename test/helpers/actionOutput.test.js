const test = require("node:test");
const assert = require("node:assert/strict");
const { getActionOutput } = require("../../src/helpers/actionOutput.js");
const { BUILTIN_ACTIONS } = require("../../src/helpers/builtinActions.js");

test("only the two actual built-in length identities write summaries", () => {
  for (const builtin of BUILTIN_ACTIONS) {
    const row = { ...builtin, is_builtin: 1, translation_key: builtin.translationKey };
    for (const output of ["chat", "summary", null]) {
      assert.equal(
        getActionOutput({ ...row, output, name: "自由な名前", prompt: "anything" }),
        builtin.output
      );
    }
  }
  for (const key of ["shorten", "lengthen"]) {
    const identity = `notes.actions.builtin.${key}`;
    assert.equal(
      getActionOutput({
        kind: "action",
        is_builtin: 0,
        translation_key: identity,
        client_id: identity,
        name: "Make notes shorter",
        output: "summary",
      }),
      "chat"
    );
    assert.equal(
      getActionOutput({
        kind: "action",
        is_builtin: 1,
        translation_key: null,
        client_id: identity,
        output: "summary",
      }),
      "chat"
    );
    assert.equal(
      getActionOutput({
        kind: "template",
        is_builtin: 1,
        translation_key: identity,
        output: "summary",
      }),
      null
    );
  }
});
