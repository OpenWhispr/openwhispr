import type { NoteAccessGrant, NoteAccessState, ShareSettings } from "../../types/electron";

const SHARE_VIEWER_BASE_URL = "https://notes.openwhispr.com";

type ShareLinkSettings = Pick<ShareSettings, "visibility" | "token_prefix">;

export type ShareLinkResolution =
  | { kind: "copy"; url: string }
  // Rotating mints a new prefix, which kills every emailed /invite/<prefix>
  // link, so it needs consent whenever a prefix already exists.
  | { kind: "rotate"; needsConfirmation: boolean };

export type LocalShareState = { isShared: boolean; shareToken: string | null };

type LocalShareStateUpdate = { is_shared: number; share_token?: null };

/** A raw token only opens the note while it belongs to the current prefix. */
export function currentShareToken(
  token: string | null | undefined,
  prefix: string | null
): string | null {
  return token && prefix && token.startsWith(prefix) ? token : null;
}

/** A private note has no link: callers handle it before asking. */
export function resolveShareLink(
  share: ShareLinkSettings,
  knownTokens: ReadonlyArray<string | null | undefined>
): ShareLinkResolution {
  const prefix = share.token_prefix;
  // Invitation emails carry this link. It admits exactly the invited
  // audience and, unlike the bearer link, stays closed if visibility widens.
  if (share.visibility === "invited" && prefix) {
    return { kind: "copy", url: `${SHARE_VIEWER_BASE_URL}/invite/${encodeURIComponent(prefix)}` };
  }
  for (const candidate of knownTokens) {
    const token = currentShareToken(candidate, prefix);
    if (token) {
      return { kind: "copy", url: `${SHARE_VIEWER_BASE_URL}/n/${encodeURIComponent(token)}` };
    }
  }
  return { kind: "rotate", needsConfirmation: prefix !== null };
}

/**
 * The DB write that brings a note's local share flag in line with the server,
 * or null when it already agrees. Every write re-pushes a shared note, so a
 * stale stored token never triggers one on its own; it is cleared only when
 * the flag is written anyway (resolveShareLink never copies it).
 */
export function reconcileLocalShareState(
  local: LocalShareState,
  share: ShareLinkSettings
): LocalShareStateUpdate | null {
  const serverShared = share.visibility !== "private";
  if (serverShared === local.isShared) return null;
  if (!serverShared) return { is_shared: 0, share_token: null };
  return local.shareToken && !currentShareToken(local.shareToken, share.token_prefix)
    ? { is_shared: 1, share_token: null }
    : { is_shared: 1 };
}

/**
 * Mirrors the mobile rule. `scope:` rows are synthesized from space or
 * workspace membership, and the API rejects changing or removing them.
 */
export function canManageAccessGrant(
  access: NoteAccessState | undefined,
  grant: NoteAccessGrant
): boolean {
  return Boolean(
    access?.can_manage_access &&
    !grant.id.startsWith("scope:") &&
    (!grant.inherited || access.can_manage_inherited_access)
  );
}
