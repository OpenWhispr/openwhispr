import { isLegacySharedPrivateNote } from "../../services/syncPassPolicy";
import type {
  NoteAccessGrant,
  NoteAccessState,
  NoteItem,
  ShareSettings,
  SpaceItem,
} from "../../types/electron";

const SHARE_VIEWER_BASE_URL = "https://notes.openwhispr.com";

type ShareLinkSettings = Pick<ShareSettings, "visibility" | "token_prefix">;

type ShareLinkResolution =
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

/**
 * New shares belong to a teamspace. Existing personal shares keep their audience.
 * A Backup cloud identity alone does not mean a Private note is shared.
 */
export type PrivateShareState = "moveToShare" | "legacyShared" | "team";

export function privateShareState(
  note: Pick<NoteItem, "is_shared" | "cloud_id">,
  space: Pick<SpaceItem, "kind"> | null | undefined
): PrivateShareState {
  if (space?.kind === "team") return "team";
  return isLegacySharedPrivateNote(note) ? "legacyShared" : "moveToShare";
}

type ShareAudience = {
  share: Pick<ShareSettings, "visibility">;
  invitations: ReadonlyArray<unknown>;
  access?: Pick<NoteAccessState, "grants"> | null;
};

/**
 * A Private note syncs independently of Backup only while its share reaches someone.
 * An invite-only share naming nobody does not establish that audience.
 */
export function reconcileNoteShareFlag(
  local: LocalShareState,
  state: ShareAudience & { share: ShareLinkSettings },
  { privateNote }: { privateNote: boolean }
): LocalShareStateUpdate | null {
  const update = reconcileLocalShareState(local, state.share);
  if (privateNote && update?.is_shared === 1 && !shareReachesAnyone(state)) return null;
  return update;
}

/**
 * Whether anyone but the owner can open a note shared this way. Private visibility shuts out
 * every invitation and grant (the API's kill switch), a link or domain share is open to whoever
 * has the link, and an invite-only share reaches only the people it still names.
 */
export function shareReachesAnyone(state: ShareAudience): boolean {
  if (state.share.visibility === "private") return false;
  if (state.share.visibility !== "invited") return true;
  return state.invitations.length > 0 || (state.access?.grants.length ?? 0) > 0;
}
