const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/issueApprovalFields.ts");

test("only issue and comment cards get the issue layout", async () => {
  const { issueVerb } = await load();
  assert.equal(issueVerb("issue"), "issue");
  assert.equal(issueVerb("comment"), "comment");
  for (const verbKey of ["email", "slackPost", "default", ""])
    assert.equal(issueVerb(verbKey), null);
});

test("the layout's fields come from the draft, or not at all", async () => {
  const { toIssueFields } = await load();
  assert.deepEqual(toIssueFields({ title: "Fix login", body: "Steps" }, "issue"), {
    title: "Fix login",
    body: "Steps",
  });
  assert.equal(toIssueFields({ body: "Steps" }, "issue"), null, "an issue needs a title field");
  assert.equal(toIssueFields({ title: ["Fix"], body: "Steps" }, "issue"), null);
  assert.deepEqual(toIssueFields({ body: "Fixed in 1.9." }, "comment"), {
    title: "",
    body: "Fixed in 1.9.",
  });
  assert.equal(toIssueFields({ title: "x" }, "comment"), null, "a comment needs a body field");
});

test("Send waits for a title within limits and a body within limits", async () => {
  const { issueFieldProblem, MAX_ISSUE_TITLE_LENGTH, MAX_ISSUE_BODY_LENGTH } = await load();
  const issue = (title, body = "") => issueFieldProblem({ title, body }, "issue");

  assert.equal(MAX_ISSUE_TITLE_LENGTH, 256);
  assert.equal(MAX_ISSUE_BODY_LENGTH, 65536);
  assert.equal(issue(""), "missingTitle");
  assert.equal(issue(" \t "), "missingTitle");
  assert.equal(issue("x".repeat(257)), "titleTooLong");
  assert.equal(issue("x".repeat(256)), null);
  assert.equal(issue("😀".repeat(256)), null, "characters, not UTF-16 units");
  assert.equal(issue("Fix", "y".repeat(65537)), "bodyTooLong");
  assert.equal(issue("Fix", "y".repeat(65536)), null);
  assert.equal(issue("Fix", ""), null, "an issue may have no description");

  const comment = (body) => issueFieldProblem({ title: "", body }, "comment");
  assert.equal(comment(" \n "), "missingBody");
  assert.equal(comment("y".repeat(65537)), "bodyTooLong");
  assert.equal(comment("Thanks!"), null, "a comment has no title to check");
});

test("each problem, outcome and verb reads from its own copy", async () => {
  const { issueProblemCopy, issueSentCopy, issueUnknownCopy } = await load();

  assert.deepEqual(issueProblemCopy("missingTitle", "issue"), {
    key: "connectors.approval.issue.missingTitle",
  });
  assert.deepEqual(issueProblemCopy("titleTooLong", "issue"), {
    key: "connectors.approval.issue.titleTooLong",
    values: { max: 256 },
  });
  assert.deepEqual(issueProblemCopy("bodyTooLong", "comment"), {
    key: "connectors.approval.comment.bodyTooLong",
    values: { max: 65536 },
  });
  assert.deepEqual(issueProblemCopy("missingBody", "comment"), {
    key: "connectors.approval.comment.missingBody",
  });

  assert.deepEqual(issueSentCopy("issue", "ENG", "ENG-124"), {
    key: "connectors.approval.issue.created",
    values: { result: "ENG-124" },
  });
  assert.deepEqual(issueSentCopy("issue", "ENG"), {
    key: "connectors.approval.issue.createdIn",
    values: { destination: "ENG" },
  });
  assert.deepEqual(issueSentCopy("comment", "ENG-123", "ignored"), {
    key: "connectors.approval.comment.posted",
    values: { destination: "ENG-123" },
  });
  assert.deepEqual(issueUnknownCopy("comment", "ENG-123"), {
    key: "connectors.approval.comment.unknown",
    values: { destination: "ENG-123" },
  });
});
