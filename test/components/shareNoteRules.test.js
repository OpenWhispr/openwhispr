const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/components/notes/shareNoteRules.ts");

const PREFIX = "ow_share_abc1234";
const TOKEN = `${PREFIX}${"x".repeat(25)}`;
// A token minted before a rotation on another device: same format, other prefix.
const ROTATED_AWAY_TOKEN = `ow_share_zzz9999${"y".repeat(25)}`;

function grant(overrides = {}) {
  return {
    id: "grant-1",
    principal: { type: "user", id: "u1", email: "a@b.co", name: null, image: null },
    permission: "viewer",
    source: "direct",
    inherited: false,
    pending: false,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

function access(overrides = {}) {
  return {
    owner: { type: "user", id: "owner", email: "o@b.co", name: null, image: null },
    grants: [],
    my_permission: "owner",
    can_manage_access: true,
    can_manage_inherited_access: true,
    ...overrides,
  };
}

test("a stored token is current only while it starts with the note's prefix", async () => {
  const { currentShareToken } = await load();

  assert.equal(currentShareToken(TOKEN, PREFIX), TOKEN);
  assert.equal(currentShareToken(ROTATED_AWAY_TOKEN, PREFIX), null);
  assert.equal(currentShareToken(TOKEN, null), null);
  assert.equal(currentShareToken(null, PREFIX), null);
  assert.equal(currentShareToken(undefined, PREFIX), null);
});

test("an invite-only note copies the invitation link, which needs no raw token", async () => {
  const { resolveShareLink } = await load();

  assert.deepEqual(resolveShareLink({ visibility: "invited", token_prefix: PREFIX }, []), {
    kind: "copy",
    url: `https://notes.openwhispr.com/invite/${PREFIX}`,
  });
});

// The bearer link would open the note for anyone if visibility later widens.
test("an invite-only note copies the invitation link even when the raw token is known", async () => {
  const { resolveShareLink } = await load();

  assert.deepEqual(resolveShareLink({ visibility: "invited", token_prefix: PREFIX }, [TOKEN]), {
    kind: "copy",
    url: `https://notes.openwhispr.com/invite/${PREFIX}`,
  });
});

test("a link share copies the viewer URL for a current token", async () => {
  const { resolveShareLink } = await load();

  for (const visibility of ["link", "domain"]) {
    assert.deepEqual(resolveShareLink({ visibility, token_prefix: PREFIX }, [TOKEN]), {
      kind: "copy",
      url: `https://notes.openwhispr.com/n/${TOKEN}`,
    });
  }
});

test("a token rotated away elsewhere is skipped in favor of a current one", async () => {
  const { resolveShareLink } = await load();

  assert.deepEqual(
    resolveShareLink({ visibility: "link", token_prefix: PREFIX }, [ROTATED_AWAY_TOKEN, TOKEN]),
    { kind: "copy", url: `https://notes.openwhispr.com/n/${TOKEN}` }
  );
});

// Rotating changes the prefix, which kills every emailed /invite/<prefix> link.
test("a link share with no current token asks before replacing the link", async () => {
  const { resolveShareLink } = await load();

  for (const visibility of ["link", "domain"]) {
    for (const known of [[], [null, undefined], [ROTATED_AWAY_TOKEN]]) {
      assert.deepEqual(resolveShareLink({ visibility, token_prefix: PREFIX }, known), {
        kind: "rotate",
        needsConfirmation: true,
      });
    }
  }
});

test("a shared note with no prefix at all mints one without asking: nothing can break", async () => {
  const { resolveShareLink } = await load();

  for (const visibility of ["invited", "link", "domain"]) {
    assert.deepEqual(resolveShareLink({ visibility, token_prefix: null }, [TOKEN]), {
      kind: "rotate",
      needsConfirmation: false,
    });
  }
});

test("reconciling leaves a note alone when it already matches the server", async () => {
  const { reconcileLocalShareState } = await load();

  assert.equal(
    reconcileLocalShareState(
      { isShared: true, shareToken: TOKEN },
      { visibility: "link", token_prefix: PREFIX }
    ),
    null
  );
  assert.equal(
    reconcileLocalShareState(
      { isShared: true, shareToken: null },
      { visibility: "invited", token_prefix: PREFIX }
    ),
    null
  );
  assert.equal(
    reconcileLocalShareState(
      { isShared: false, shareToken: null },
      { visibility: "private", token_prefix: null }
    ),
    null
  );
});

// Every share-state write re-pushes a shared note, and while share mutations
// bump the cloud version that push can 409 into a conflict banner. A stale
// token is already ignored when copying, so it never earns a write alone.
test("a stale token alone does not cause a write", async () => {
  const { reconcileLocalShareState } = await load();

  assert.equal(
    reconcileLocalShareState(
      { isShared: true, shareToken: ROTATED_AWAY_TOKEN },
      { visibility: "link", token_prefix: PREFIX }
    ),
    null
  );
  assert.equal(
    reconcileLocalShareState(
      { isShared: false, shareToken: TOKEN },
      { visibility: "private", token_prefix: null }
    ),
    null
  );
});

test("a flag write also clears a stored token that a rotation elsewhere made stale", async () => {
  const { reconcileLocalShareState } = await load();

  assert.deepEqual(
    reconcileLocalShareState(
      { isShared: false, shareToken: ROTATED_AWAY_TOKEN },
      { visibility: "domain", token_prefix: PREFIX }
    ),
    { is_shared: 1, share_token: null }
  );
});

test("reconciling follows the server's shared flag", async () => {
  const { reconcileLocalShareState } = await load();

  assert.deepEqual(
    reconcileLocalShareState(
      { isShared: false, shareToken: null },
      { visibility: "invited", token_prefix: PREFIX }
    ),
    { is_shared: 1 }
  );
  assert.deepEqual(
    reconcileLocalShareState(
      { isShared: true, shareToken: TOKEN },
      { visibility: "private", token_prefix: null }
    ),
    { is_shared: 0, share_token: null }
  );
});

test("a direct grant is manageable by someone who manages access", async () => {
  const { canManageAccessGrant } = await load();

  assert.equal(canManageAccessGrant(access(), grant()), true);
  assert.equal(canManageAccessGrant(access({ can_manage_access: false }), grant()), false);
  assert.equal(canManageAccessGrant(undefined, grant()), false);
});

test("an inherited grant needs inherited-access management", async () => {
  const { canManageAccessGrant } = await load();
  const inherited = grant({ inherited: true, source: "team" });

  assert.equal(canManageAccessGrant(access(), inherited), true);
  assert.equal(
    canManageAccessGrant(access({ can_manage_inherited_access: false }), inherited),
    false
  );
});

// Space/workspace membership rows are synthesized by the API, which rejects
// PATCH/DELETE on them with 400.
test("a synthetic scope row is never manageable", async () => {
  const { canManageAccessGrant } = await load();

  for (const id of ["scope:workspace:w1", "scope:team:t1"]) {
    assert.equal(
      canManageAccessGrant(access(), grant({ id, inherited: true, source: "workspace" })),
      false
    );
    assert.equal(canManageAccessGrant(access(), grant({ id })), false);
  }
});
