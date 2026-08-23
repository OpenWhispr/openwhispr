const crypto = require("crypto");

const AUTHORIZATION_BOUNDARY_CHANGED = "AUTHORIZATION_BOUNDARY_CHANGED";

const authorizationChanged = () => ({
  success: false,
  error: "Transcription authorization changed. Retry the request.",
  code: AUTHORIZATION_BOUNDARY_CHANGED,
});

function createMeetingTranscriptCommitRegistry({
  isBindingCurrent,
  isSameOwner,
  commit,
  createToken = () => crypto.randomUUID(),
  scheduleExpiry = (callback) => setTimeout(callback, 30 * 60 * 1000),
}) {
  const grants = new Map();

  const issue = ({ authorizationBinding, ownerWebContents, sessionId, noteId }) => {
    const commitToken = createToken();
    grants.set(commitToken, { authorizationBinding, ownerWebContents, sessionId, noteId });
    const expiryTimer = scheduleExpiry(() => grants.delete(commitToken));
    expiryTimer?.unref?.();
    return commitToken;
  };

  const revoke = (identityKey = null) => {
    for (const [commitToken, grant] of grants) {
      if (identityKey && grant.authorizationBinding?.identityKey !== identityKey) continue;
      grants.delete(commitToken);
    }
  };

  const revokeWorkspacePolicy = (workspacePolicyIdentityKey) => {
    for (const [commitToken, grant] of grants) {
      if (
        workspacePolicyIdentityKey &&
        grant.authorizationBinding?.workspacePolicyIdentityKey !== workspacePolicyIdentityKey
      ) {
        continue;
      }
      grants.delete(commitToken);
    }
  };

  const remove = (commitToken) => grants.delete(commitToken);

  const commitAuthorized = (sender, payload = {}) => {
    const grant = grants.get(payload.commitToken);
    if (
      !grant ||
      !isSameOwner(grant.ownerWebContents, sender) ||
      grant.noteId == null ||
      grant.noteId !== payload.noteId ||
      (payload.kind !== "final" && payload.kind !== "diarization") ||
      typeof payload.transcript !== "string"
    ) {
      return authorizationChanged();
    }
    // The callback must remain synchronous. This check is intentionally the
    // final instruction before the main-owned database mutation.
    if (!isBindingCurrent(grant.authorizationBinding)) return authorizationChanged();
    return commit(grant, payload);
  };

  return { issue, revoke, revokeWorkspacePolicy, remove, commitAuthorized };
}

module.exports = { createMeetingTranscriptCommitRegistry };
