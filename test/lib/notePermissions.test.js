const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canOrganizeNote,
  noteCapabilities,
  resolveNotePermission,
  sharedNoteBlocksDelete,
} = require("../../src/lib/notePermissions.ts");

// The scopes where per-note ACLs apply: only cloud-backed personal notes.
const sharedPersonal = { isTeamNote: false, hasCloudCopy: true };
const localPersonal = { isTeamNote: false, hasCloudCopy: false };
const teamNote = { isTeamNote: true, hasCloudCopy: true };

test("sharedNoteBlocksDelete: editors and viewers of a shared personal note lose Delete", () => {
  assert.equal(sharedNoteBlocksDelete("editor", sharedPersonal), true);
  assert.equal(sharedNoteBlocksDelete("viewer", sharedPersonal), true);
  assert.equal(sharedNoteBlocksDelete(null, sharedPersonal), true);
  assert.equal(sharedNoteBlocksDelete("owner", sharedPersonal), false);
});

test("sharedNoteBlocksDelete: never vetoes team or local-only notes", () => {
  // Team notes follow space roles (spacePermissions) — the ACL "editor"
  // fallback must not strip a space admin's delete.
  assert.equal(sharedNoteBlocksDelete("editor", teamNote), false);
  assert.equal(sharedNoteBlocksDelete("viewer", teamNote), false);
  assert.equal(sharedNoteBlocksDelete("editor", localPersonal), false);
  assert.equal(sharedNoteBlocksDelete(null, localPersonal), false);
});

test("canOrganizeNote: re-filing a shared personal note is owner-only", () => {
  assert.equal(canOrganizeNote("owner", sharedPersonal), true);
  assert.equal(canOrganizeNote("editor", sharedPersonal), false);
  assert.equal(canOrganizeNote("viewer", sharedPersonal), false);
  assert.equal(canOrganizeNote(null, sharedPersonal), false);
});

test("canOrganizeNote: team and local-only notes stay freely movable", () => {
  assert.equal(canOrganizeNote("editor", teamNote), true);
  assert.equal(canOrganizeNote("viewer", teamNote), true);
  assert.equal(canOrganizeNote(null, localPersonal), true);
});

test("unknown ACLs keep the owner fallback for personal notes", () => {
  // A note never opened this session (no share-cache entry) resolves through
  // the "unavailable" state and must not lose actions it had before.
  const fallback = resolveNotePermission({
    cachedPermission: undefined,
    aclState: "unavailable",
    isTeamNote: false,
  });
  assert.equal(fallback, "owner");
  assert.equal(sharedNoteBlocksDelete(fallback, sharedPersonal), false);
  assert.equal(canOrganizeNote(fallback, sharedPersonal), true);
});

test("loaded ACLs drive the veto end to end", () => {
  const editor = resolveNotePermission({
    cachedPermission: "editor",
    aclState: "loaded",
    isTeamNote: false,
  });
  assert.equal(noteCapabilities(editor).canDelete, false);
  assert.equal(sharedNoteBlocksDelete(editor, sharedPersonal), true);
  assert.equal(canOrganizeNote(editor, sharedPersonal), false);
});
