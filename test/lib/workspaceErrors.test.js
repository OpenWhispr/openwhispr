const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyInviteError,
  classifyRemovalError,
  classifyRowActionError,
  classifySpaceError,
  classifyTeamError,
  rowActionErrorOf,
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

test("a rate limit on a row action is its own kind", () => {
  const message = "Too many invitations right now. Try again later.";
  assert.deepEqual(classifyRowActionError(new CloudApiError(message, 429, "rate_limited")), {
    kind: "rateLimited",
  });
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

test("directory_managed names who the identity provider assigns", () => {
  assert.deepEqual(
    classifyRemovalError(
      new CloudApiError("Remove them in your identity provider instead", 409, "directory_managed", {
        user_ids: ["u1", "u2"],
      })
    ),
    { kind: "directoryManaged", userIds: ["u1", "u2"] }
  );
});

test("a malformed directory_managed list keeps only string ids", () => {
  for (const [details, userIds] of [
    [null, []],
    [undefined, []],
    [{}, []],
    [{ user_ids: "u1" }, []],
    [{ user_ids: [1, null, { id: "u1" }] }, []],
    [{ user_ids: ["u1", 2, null, "u3"] }, ["u1", "u3"]],
  ]) {
    assert.deepEqual(
      classifyRemovalError(new CloudApiError("x", 409, "directory_managed", details)),
      { kind: "directoryManaged", userIds },
      JSON.stringify(details)
    );
  }
});

test("other removal failures fall back to row action kinds", () => {
  assert.deepEqual(classifyRemovalError(new CloudApiError("Forbidden", 403)), {
    kind: "notAllowed",
  });
  assert.deepEqual(classifyRemovalError(new CloudApiError("Network", 0)), { kind: "failed" });
});

test("a rate-limited invite keeps how many fit and the daily limit", () => {
  const message = "Too many invitations right now. Try again later.";
  const limited = (details) => new CloudApiError(message, 429, "rate_limited", details);

  assert.deepEqual(classifyInviteError(limited({ limit: 50, available: 20, requested: 60 })), {
    kind: "rateLimited",
    available: 20,
    limit: 50,
  });
  // An older answer without the numbers has nothing to trim to.
  assert.deepEqual(classifyInviteError(limited(undefined)), { kind: "rateLimited" });
});

test("space refusals map to their kinds by code", () => {
  const cases = [
    [new CloudApiError("x", 409, "space_name_taken"), { kind: "nameTaken" }],
    [new CloudApiError("x", 409, "last_space_admin"), { kind: "lastAdmin" }],
    [new CloudApiError("x", 403, "space_not_open"), { kind: "notOpen" }],
    [new CloudApiError("x", 410, "space_archived"), { kind: "archived" }],
    [new CloudApiError("x", 404, "space_not_found"), { kind: "gone" }],
  ];
  for (const [error, expected] of cases) {
    assert.deepEqual(classifySpaceError(error), expected, error.code);
  }
});

test("access revoked reads as not allowed, which no retry changes", () => {
  assert.deepEqual(classifySpaceError(new CloudApiError("x", 403, "space_access_revoked")), {
    kind: "notAllowed",
  });
});

test("not_workspace_members names the people who are not in the workspace", () => {
  assert.deepEqual(
    classifySpaceError(
      new CloudApiError("Some of these people aren't members", 400, "not_workspace_members", {
        user_ids: ["u1", "u2"],
      })
    ),
    { kind: "notWorkspaceMembers", userIds: ["u1", "u2"] }
  );
});

test("not_workspace_members without a list gives an empty list", () => {
  for (const details of [null, undefined, {}, { user_ids: "u1" }]) {
    assert.deepEqual(
      classifySpaceError(new CloudApiError("x", 400, "not_workspace_members", details)),
      { kind: "notWorkspaceMembers", userIds: [] }
    );
  }
});

test("not_workspace_members keeps only the string ids", () => {
  assert.deepEqual(
    classifySpaceError(
      new CloudApiError("x", 400, "not_workspace_members", { user_ids: ["u1", 2, null, "u3"] })
    ),
    { kind: "notWorkspaceMembers", userIds: ["u1", "u3"] }
  );
});

test("a space failure without a space code falls back to the row action kinds", () => {
  assert.deepEqual(classifySpaceError(new CloudApiError("Insufficient role", 403)), {
    kind: "notAllowed",
  });
  assert.deepEqual(classifySpaceError(new CloudApiError("x", 429, "rate_limited")), {
    kind: "rateLimited",
  });
  assert.deepEqual(classifySpaceError(new CloudApiError("Name is too long", 400)), {
    kind: "refused",
    message: "Name is too long",
  });
});

test("an unknown 500 reads as failed", () => {
  assert.deepEqual(classifySpaceError(new CloudApiError("API error: 500", 500)), {
    kind: "failed",
  });
  assert.deepEqual(classifySpaceError(new Error("offline")), { kind: "failed" });
});

test("a space failure that no row dialog has a screen for reads as failed", () => {
  for (const failure of [
    { kind: "nameTaken" },
    { kind: "lastAdmin" },
    { kind: "notOpen" },
    { kind: "archived" },
    { kind: "notWorkspaceMembers", userIds: ["u1"] },
  ]) {
    assert.deepEqual(rowActionErrorOf(failure), { kind: "failed" });
  }
  assert.deepEqual(rowActionErrorOf(undefined), { kind: "failed" });
});

test("a row action failure passes through a space failure unchanged", () => {
  for (const failure of [
    { kind: "gone" },
    { kind: "notAllowed" },
    { kind: "ssoRequired" },
    { kind: "rateLimited" },
    { kind: "refused", message: "Cannot leave a directory-managed teamspace" },
    { kind: "failed" },
  ]) {
    assert.deepEqual(rowActionErrorOf(failure), failure);
  }
});

test("each team code has its kind", () => {
  const cases = [
    ["team_plan_required", 403, { kind: "planRequired" }],
    ["team_name_taken", 409, { kind: "nameTaken" }],
    ["last_team_admin", 409, { kind: "lastAdmin" }],
  ];
  for (const [code, status, expected] of cases) {
    assert.deepEqual(classifyTeamError(new CloudApiError("x", status, code)), expected, code);
  }
  assert.deepEqual(
    classifyTeamError(
      new CloudApiError("x", 400, "not_workspace_members", { user_ids: ["u1", 7, "u2"] })
    ),
    { kind: "notWorkspaceMembers", userIds: ["u1", "u2"] }
  );
  assert.deepEqual(classifyTeamError(new CloudApiError("x", 400, "not_workspace_members")), {
    kind: "notWorkspaceMembers",
    userIds: [],
  });
});

test("a missing team reads as gone", () => {
  assert.deepEqual(classifyTeamError(new CloudApiError("Team not found", 404)), { kind: "gone" });
  assert.notDeepEqual(classifyTeamError(new CloudApiError("Not found", 404)), { kind: "gone" });
});

test("an unknown team failure reads as failed", () => {
  assert.deepEqual(classifyTeamError(new Error("boom")), { kind: "failed" });
  assert.deepEqual(classifyTeamError(new CloudApiError("x", 403)), { kind: "notAllowed" });
});
