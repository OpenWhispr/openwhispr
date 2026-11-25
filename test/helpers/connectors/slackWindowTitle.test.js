const test = require("node:test");
const assert = require("node:assert/strict");
const {
  slackWindowTitle,
  slackTitleNames,
} = require("../../../src/helpers/connectors/slackWindowTitle");

test("a Slack window is the Slack app, a slack.com page, or a title with Slack's name in it", () => {
  const title = "eng (Channel) - Acme - Slack";
  const cases = [
    [{ appSignature: "Slack com.tinyspeck.slackmacgap", windowTitle: "eng" }, "eng"],
    [{ appSignature: "slack.exe", windowTitle: title }, title],
    [{ appSignature: "Google Chrome", urlHost: "app.slack.com", windowTitle: "eng" }, "eng"],
    [
      { appSignature: "chrome.exe", windowTitle: `${title} - Google Chrome` },
      `${title} - Google Chrome`,
    ],
    [{ appSignature: "Notes com.apple.Notes", windowTitle: "Slack ideas for the team" }, null],
    [{ appSignature: "slacker", windowTitle: "eng" }, null],
    [{ appSignature: "Slack", windowTitle: "  " }, null],
    [null, null],
  ];
  for (const [context, expected] of cases) {
    assert.equal(slackWindowTitle(context), expected, JSON.stringify(context));
  }
});

test("a title's names leave out Slack, the workspace, unread marks, # and a kind tag", () => {
  assert.deepEqual(slackTitleNames("* eng (Channel) - Acme - Slack", "Acme"), [
    "eng (Channel)",
    "eng",
  ]);
  assert.deepEqual(slackTitleNames("(3) Slack | #leads | Acme", "Acme"), ["leads"]);
  // A name of its own may end in parentheses too, so both forms are tried.
  assert.deepEqual(slackTitleNames("Sam (he/him) (DM) - Acme - Slack", "acme"), [
    "Sam (he/him) (DM)",
    "Sam (he/him)",
  ]);
  assert.deepEqual(slackTitleNames("Acme - Slack", "Acme"), []);
});

test("a title's names stop at Slack's name, before what a browser adds", () => {
  // As Slack's desktop app and Chrome title them.
  assert.deepEqual(slackTitleNames("eng (Channel) - Acme - 28 new items - Slack", "Acme"), [
    "eng (Channel)",
    "eng",
    "28 new items",
  ]);
  assert.deepEqual(
    slackTitleNames("Saved - Acme - Slack - Google Chrome – Sam Lee (acme.com)", "Acme"),
    ["Saved"]
  );
});
