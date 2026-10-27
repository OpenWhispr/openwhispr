const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyInviteError, classifyRowActionError } = require("../../src/lib/workspaceErrors.ts");
const { CloudApiError } = require("../../src/services/cloudApi.ts");

const kindOf = (error) => classifyInviteError(error).kind;

test("codes win over messages", () => {
  const error = new CloudApiError(
    "User is already a member of this workspace",
    409,
    "already_invited"
  );
  assert.equal(kindOf(error), "alreadyInvited");
});

test("every known code maps to its kind", () => {
  const cases = {
    invalid_email: "invalid",
    already_member: "alreadyMember",
    already_invited: "alreadyInvited",
    seat_limit_reached: "seatLimit",
    DIRECTORY_ASSIGNMENT_REQUIRED: "directoryRequired",
    SSO_REQUIRED: "ssoRequired",
  };
  for (const [code, kind] of Object.entries(cases)) {
    assert.equal(kindOf(new CloudApiError("x", 400, code)), kind, code);
  }
});

test("older API messages still classify", () => {
  assert.equal(
    kindOf(new CloudApiError("User is already a member of this workspace", 409)),
    "alreadyMember"
  );
  assert.equal(
    kindOf(new CloudApiError("An invitation for this email is already pending", 409)),
    "alreadyInvited"
  );
  assert.equal(kindOf(new CloudApiError("Invalid email", 400)), "invalid");
});

// The API's own text here ("Insufficient role", "Workspace not found") says less than the copy,
// and every remaining address would get the same answer.
test("403 and 404 without a code mean the caller is not allowed, whatever the message", () => {
  assert.equal(kindOf(new CloudApiError("Insufficient role", 403)), "notAllowed");
  assert.equal(kindOf(new CloudApiError("Forbidden", 403)), "notAllowed");
  assert.equal(kindOf(new CloudApiError("Workspace not found", 404)), "notAllowed");
});

test("a refusal without a known code keeps the server's reason", () => {
  assert.deepEqual(
    classifyInviteError(new CloudApiError("Only admins can be invited without a seat", 400)),
    { kind: "refused", message: "Only admins can be invited without a seat" }
  );
  assert.deepEqual(
    classifyInviteError(new CloudApiError("Too many invitations", 429, "rate_limited")),
    { kind: "refused", message: "Too many invitations" }
  );
  // A bare status carries no reason to show.
  assert.equal(kindOf(new CloudApiError("API error: 400", 400)), "requestFailed");
});

test("a dropped connection is a failed request", () => {
  assert.equal(kindOf(new CloudApiError("Network", 0)), "requestFailed");
  assert.equal(kindOf(new Error("boom")), "requestFailed");
  assert.equal(kindOf(new CloudApiError("Unauthorized", 401)), "requestFailed");
  assert.equal(kindOf(new CloudApiError("Oops", 500)), "requestFailed");
});

test("a missing member is gone", () => {
  assert.deepEqual(classifyRowActionError(new CloudApiError("Member not found", 404)), {
    kind: "gone",
  });
});

test("losing the workspace is not allowed, not gone", () => {
  assert.deepEqual(classifyRowActionError(new CloudApiError("Workspace not found", 404)), {
    kind: "notAllowed",
  });
});

test("403 on a row action is not allowed", () => {
  assert.deepEqual(classifyRowActionError(new CloudApiError("Forbidden", 403)), {
    kind: "notAllowed",
  });
});

test("a 400 with a server message is refused with that message", () => {
  assert.deepEqual(
    classifyRowActionError(new CloudApiError("Transfer ownership before demoting the owner", 400)),
    { kind: "refused", message: "Transfer ownership before demoting the owner" }
  );
});

test("connection and server failures on a row action are failed", () => {
  assert.deepEqual(classifyRowActionError(new CloudApiError("Network", 0)), { kind: "failed" });
  assert.deepEqual(classifyRowActionError(new CloudApiError("Oops", 500)), { kind: "failed" });
  assert.deepEqual(classifyRowActionError(new CloudApiError("API error: 400", 400)), {
    kind: "failed",
  });
  assert.deepEqual(classifyRowActionError(new Error("boom")), { kind: "failed" });
});
