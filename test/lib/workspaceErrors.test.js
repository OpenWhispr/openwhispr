const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyInviteError,
  classifyRemovalError,
  classifyRowActionError,
} = require("../../src/lib/workspaceErrors.ts");
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
  // A bare status carries no reason to show.
  assert.equal(kindOf(new CloudApiError("API error: 400", 400)), "requestFailed");
});

test("a dropped connection is a failed request", () => {
  assert.equal(kindOf(new CloudApiError("Network", 0)), "requestFailed");
  assert.equal(kindOf(new Error("boom")), "requestFailed");
  assert.equal(kindOf(new CloudApiError("Oops", 500)), "requestFailed");
});

test("an expired or replaced sign-in is its own kind", () => {
  assert.equal(kindOf(new CloudApiError("Unauthorized", 401)), "sessionExpired");
  assert.equal(kindOf(new CloudApiError("Expired", 401, "AUTH_EXPIRED")), "sessionExpired");
  assert.equal(kindOf(new CloudApiError("Changed", 409, "AUTH_CONTEXT_CHANGED")), "sessionExpired");
});

test("single sign-on required on a row action is its own kind", () => {
  assert.deepEqual(
    classifyRowActionError(new CloudApiError("Sign in with company SSO", 403, "SSO_REQUIRED")),
    { kind: "ssoRequired" }
  );
});

test("a 404 that doesn't name the row proves nothing about it", () => {
  assert.deepEqual(classifyRowActionError(new CloudApiError("API error: 404", 404)), {
    kind: "failed",
  });
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
  const message = "Transfer ownership to another member before leaving the workspace";
  assert.deepEqual(classifyRowActionError(new CloudApiError(message, 400)), {
    kind: "refused",
    message,
  });
});

test("connection and server failures on a row action are failed", () => {
  assert.deepEqual(classifyRowActionError(new CloudApiError("Network", 0)), { kind: "failed" });
  assert.deepEqual(classifyRowActionError(new CloudApiError("Oops", 500)), { kind: "failed" });
  assert.deepEqual(classifyRowActionError(new CloudApiError("API error: 400", 400)), {
    kind: "failed",
  });
  assert.deepEqual(classifyRowActionError(new Error("boom")), { kind: "failed" });
});

test("a seat refusal carries how many fit", () => {
  const error = new CloudApiError("x", 400, "seat_limit_reached", {
    limit: 500,
    available: 3,
    requested: 8,
  });
  assert.deepEqual(classifyInviteError(error), { kind: "seatLimit", available: 3 });
});

test("a seat refusal without details still classifies", () => {
  assert.deepEqual(classifyInviteError(new CloudApiError("x", 400, "seat_limit_reached")), {
    kind: "seatLimit",
  });
  assert.deepEqual(
    classifyInviteError(new CloudApiError("x", 400, "seat_limit_reached", { available: "3" })),
    { kind: "seatLimit" }
  );
});

test("rate limited invitations have their own kind", () => {
  assert.equal(
    kindOf(
      new CloudApiError("Too many invitations right now. Try again later.", 429, "rate_limited")
    ),
    "rateLimited"
  );
});

test("transfer required carries the owners", () => {
  const members = [
    { user_id: "u1", owned_notes: 4, owned_spaces: 1 },
    { user_id: "u2", owned_notes: 0, owned_spaces: 2 },
  ];
  assert.deepEqual(
    classifyRemovalError(
      new CloudApiError("Transfer required", 409, "transfer_required", { members })
    ),
    { kind: "transferRequired", owners: members }
  );
});

test("a malformed transfer_required body still asks for a transfer", () => {
  for (const details of [null, undefined, {}, { members: "u1" }]) {
    assert.deepEqual(
      classifyRemovalError(
        new CloudApiError("Transfer required", 409, "transfer_required", details)
      ),
      { kind: "transferRequired", owners: [] }
    );
  }
});

test("removal refusals map to their reasons", () => {
  assert.deepEqual(classifyRemovalError(new CloudApiError("x", 400, "cannot_remove_owner")), {
    kind: "cannotRemove",
    reason: "owner",
  });
  assert.deepEqual(classifyRemovalError(new CloudApiError("x", 400, "cannot_remove_self")), {
    kind: "cannotRemove",
    reason: "self",
  });
  assert.deepEqual(classifyRemovalError(new CloudApiError("x", 400, "invalid_transfer_target")), {
    kind: "invalidTransferTarget",
  });
});

test("other removal failures fall back to row action kinds", () => {
  assert.deepEqual(classifyRemovalError(new CloudApiError("Forbidden", 403)), {
    kind: "notAllowed",
  });
  assert.deepEqual(classifyRemovalError(new CloudApiError("Network", 0)), { kind: "failed" });
});
