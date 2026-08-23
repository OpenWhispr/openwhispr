const crypto = require("crypto");

const AUTHORIZATION_BOUNDARY_CHANGED = "AUTHORIZATION_BOUNDARY_CHANGED";
const ACTION_UPDATE_FIELDS = new Set([
  "enhanced_content",
  "enhancement_prompt",
  "enhanced_at_content_hash",
  "title",
]);

const authorizationChanged = () => ({
  success: false,
  error: "Authorization changed while the note action was active.",
  code: AUTHORIZATION_BOUNDARY_CHANGED,
});

function validUpdates(updates) {
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) return false;
  const entries = Object.entries(updates);
  return (
    entries.length >= 3 &&
    entries.every(([key, value]) => ACTION_UPDATE_FIELDS.has(key) && typeof value === "string") &&
    typeof updates.enhanced_content === "string" &&
    typeof updates.enhancement_prompt === "string" &&
    typeof updates.enhanced_at_content_hash === "string"
  );
}

function createActionNoteCommitRegistry({
  isBindingCurrent,
  isSameOwner,
  commit,
  createToken = () => crypto.randomUUID(),
  scheduleExpiry = (callback) => setTimeout(callback, 10 * 60 * 1000),
}) {
  const grants = new Map();

  const issue = ({ authorizationBinding, ownerWebContents, noteId, reasoningSignature }) => {
    const commitToken = createToken();
    grants.set(commitToken, {
      authorizationBinding,
      ownerWebContents,
      noteId,
      reasoningSignature,
    });
    const expiryTimer = scheduleExpiry(() => grants.delete(commitToken));
    expiryTimer?.unref?.();
    return commitToken;
  };

  const revoke = () => grants.clear();

  const commitAuthorized = (sender, payload = {}) => {
    const grant = grants.get(payload.commitToken);
    if (
      !grant ||
      !isSameOwner(grant.ownerWebContents, sender) ||
      grant.noteId !== payload.noteId ||
      grant.reasoningSignature !== payload.reasoningSignature ||
      !validUpdates(payload.updates)
    ) {
      return authorizationChanged();
    }
    grants.delete(payload.commitToken);
    // This synchronous check is intentionally the final instruction before the
    // main-owned database mutation in commit().
    if (!isBindingCurrent(grant.authorizationBinding)) return authorizationChanged();
    return commit(grant, payload);
  };

  return { issue, revoke, commitAuthorized };
}

module.exports = { createActionNoteCommitRegistry };
