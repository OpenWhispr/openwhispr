import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, FileText, Link2, Loader2, MoreHorizontal, Users } from "../icons";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { cn } from "../lib/utils";
import ShareVisibilityMenu from "./ShareVisibilityMenu";
import { notesInputClass } from "./shared";
import {
  canManageAccessGrant,
  currentShareToken,
  privateShareState,
  reconcileLocalShareState,
  resolveShareLink,
  shareReachesAnyone,
  type LocalShareState,
} from "./shareNoteRules";
import { useAuth } from "../../hooks/useAuth";
import { useSpacesInWorkspaceScope, useWorkspace } from "../../hooks/useWorkspace";
import type { NoteMoveTarget } from "../../hooks/useNoteDragAndDrop";
import { spaceTransferAction } from "../../lib/spacePermissions";
import { localMutationErrorKey } from "../../lib/localMutationError";
import {
  NoteSharingService,
  type AccessPrincipalSuggestion,
  type ShareMutationResponse,
  type ShareStateResponse,
} from "../../services/NoteSharingService.js";
import { syncService } from "../../services/SyncService.js";
import {
  getShareCacheEntry,
  persistNoteShareState,
  updateShareCache,
  useSpaces,
  useShareCacheEntry,
} from "../../stores/noteStore";
import { useToast } from "../ui/useToast";
import MemberAvatar from "../MemberAvatar";
import {
  filterShareVisibilityOptions,
  isShareActionAllowed,
  type SharePolicyAction,
} from "../../stores/policyRules";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import { emailDomain, isPersonalEmailDomain } from "../../utils/personalEmailDomains";
import { EMAIL_REGEX } from "../../utils/validation";
import type {
  NoteAccessGrant,
  NoteAccessState,
  NoteItem,
  NoteMutationResult,
  NoteShareInvitation,
  ShareVisibility,
  SpaceItem,
} from "../../types/electron";

const SHARE_VISIBILITY_OPTIONS: Array<{ id: ShareVisibility }> = [
  { id: "private" },
  { id: "invited" },
  { id: "link" },
  { id: "domain" },
];

export interface NoteExportOption {
  id: string;
  label: string;
  onSelect: () => void;
}

interface ShareNoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  note: NoteItem;
  /** Local export formats offered below the sharing controls. */
  exportOptions?: NoteExportOption[];
  /** Opened from the link segment of the Share button: copy the link as soon as it is usable. */
  copyLinkOnOpen?: boolean;
  /** Whether the user may move the note to another space: a private note shares by moving. */
  canMoveNote?: boolean;
  /** The notes view's move, which also takes the view along with the open note. */
  onMoveNote?: (noteId: number, target: NoteMoveTarget) => Promise<NoteMutationResult | void>;
  /** Opens Settings › Teamspaces, where teamspaces are made. */
  onOpenTeamspaces?: () => void;
}

export default function ShareNoteDialog({
  open,
  onOpenChange,
  note,
  exportOptions = [],
  copyLinkOnOpen = false,
  canMoveNote = false,
  onMoveNote,
  onOpenTeamspaces,
}: ShareNoteDialogProps) {
  const { user } = useAuth();
  const ownerName: string | null = user?.name ?? null;
  const ownerEmail: string = user?.email ?? "";
  const { t } = useTranslation();
  const { toast } = useToast();
  const spaces = useSpaces();
  // A note this dialog moved into a teamspace: the note prop lags behind the
  // move until the next note-updated event.
  const [moved, setMoved] = useState<{
    noteId: number;
    fromSpaceId: number;
    toSpaceId: number;
  } | null>(null);
  const spaceId =
    moved?.noteId === note.id && moved.fromSpaceId === note.space_id
      ? moved.toSpaceId
      : note.space_id;
  const space = useMemo(
    () => spaces.find((candidate) => candidate.id === spaceId) ?? null,
    [spaces, spaceId]
  );
  const shareState = privateShareState(note, space);
  const isTeamNote = shareState === "team";

  // A note synced from this dialog: the create acknowledgement doesn't
  // broadcast, so the note prop can lag behind the local DB until the next
  // note-updated event.
  const [syncedFor, setSyncedFor] = useState<{ noteId: number; cloudId: string } | null>(null);
  const knownCloudId = note.cloud_id ?? (syncedFor?.noteId === note.id ? syncedFor.cloudId : null);
  // A private note that isn't shared has nothing to share from: a cloud id on
  // it is the old Backup's copy, and sharing that would start syncing it again.
  const cloudId = shareState === "moveToShare" ? null : knownCloudId;
  const cached = useShareCacheEntry(cloudId);

  const { defaultWorkspaceId } = useWorkspace();
  const scopedSpaces = useSpacesInWorkspaceScope(spaces);
  // The active workspace's teamspaces the note can move into, as the tree offers them.
  const moveTargets = useMemo(
    () =>
      space
        ? scopedSpaces.filter(
            (target) =>
              target.kind === "team" &&
              spaceTransferAction(space, target, { defaultWorkspaceId }) === "move"
          )
        : [],
    [space, scopedSpaces, defaultWorkspaceId]
  );
  const canOfferMove = canMoveNote && Boolean(onMoveNote);
  const [confirmMove, setConfirmMove] = useState<{ target: SpaceItem; open: boolean } | null>(null);
  const [movingTo, setMovingTo] = useState<number | null>(null);

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [savingVisibility, setSavingVisibility] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [suggestions, setSuggestions] = useState<AccessPrincipalSuggestion[]>([]);
  const [searchingSuggestions, setSearchingSuggestions] = useState(false);
  // True once a search resolved for the current input, so zero matches can say so.
  const [suggestionsSettled, setSuggestionsSettled] = useState(false);
  const [copied, setCopied] = useState(false);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [busyGrantId, setBusyGrantId] = useState<string | null>(null);
  const [confirmingReplaceLink, setConfirmingReplaceLink] = useState(false);
  // Copy on open waits for this: the cached share can be hours old.
  const [refreshedCloudId, setRefreshedCloudId] = useState<string | null>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const copyTimeoutRef = useRef<number | null>(null);
  const localShareStateRef = useRef<LocalShareState>({
    isShared: Boolean(note.is_shared),
    shareToken: note.share_token ?? null,
  });

  useEffect(() => {
    localShareStateRef.current = {
      isShared: Boolean(note.is_shared),
      shareToken: note.share_token ?? null,
    };
  }, [note.is_shared, note.share_token]);

  const policyState = usePolicySnapshot();

  const ownerDomain = useMemo(() => emailDomain(ownerEmail), [ownerEmail]);
  const showDomainOption = Boolean(ownerDomain && !isPersonalEmailDomain(ownerDomain));

  const share = cached?.share ?? null;
  const access = cached?.access;
  const currentVisibility = share?.visibility ?? "private";
  const shareActionAllowed = useCallback(
    (action: SharePolicyAction, visibility: ShareVisibility = currentVisibility) =>
      isShareActionAllowed(policyState, action, visibility),
    [currentVisibility, policyState]
  );
  const canManageAccess = access?.can_manage_access ?? true;
  const inviteAllowedByPolicy = shareActionAllowed("invite");
  const canInvite = canManageAccess && inviteAllowedByPolicy;
  const linkActionAllowedByPolicy = shareActionAllowed(
    currentVisibility === "private" ? "create-link" : "copy-link"
  );
  const canUseLink = canManageAccess && linkActionAllowedByPolicy;
  const visibleShareVisibilities = useMemo(
    () => filterShareVisibilityOptions(SHARE_VISIBILITY_OPTIONS, policyState).map(({ id }) => id),
    [policyState]
  );
  // Principal search needs the ACL API; legacy servers only take raw emails.
  const canSearchPrincipals = canInvite && Boolean(access?.can_manage_access);
  const invitations = useMemo(() => cached?.invitations ?? [], [cached?.invitations]);
  const accessInvitationEmails = useMemo(
    () =>
      new Set(
        (access?.grants ?? [])
          .map((grant) => grant.principal.email?.toLowerCase())
          .filter((email): email is string => Boolean(email))
      ),
    [access?.grants]
  );
  const visibleInvitations = useMemo(
    () =>
      invitations.filter(
        (invitation) => !accessInvitationEmails.has(invitation.email.toLowerCase())
      ),
    [invitations, accessInvitationEmails]
  );
  // While server state loads, the persisted flag keeps the footer honest.
  const isPrivate = share ? share.visibility === "private" : !note.is_shared;

  const refreshShareCache = useCallback(
    async (
      resolveFallbackAccess?: (current: NoteAccessState | undefined) => NoteAccessState | undefined
    ): Promise<ShareStateResponse | null> => {
      if (!cloudId) return null;
      const refreshed = await NoteSharingService.getShareSettings(cloudId);
      updateShareCache(cloudId, (entry) => ({
        share: refreshed.share,
        invitations: refreshed.invitations,
        access: refreshed.access ?? resolveFallbackAccess?.(entry?.access) ?? entry?.access,
        rawToken: currentShareToken(entry?.rawToken, refreshed.share.token_prefix),
      }));
      return refreshed;
    },
    [cloudId]
  );

  // A team note shares from its cloud copy. One without a cloud id here
  // (not uploaded yet, just moved in to share, or one a background sync gave
  // an id the note prop doesn't have) gets it now: team notes upload anyway,
  // so this asks nothing.
  useEffect(() => {
    if (!open || !isTeamNote || knownCloudId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    syncService
      .ensureNoteSynced(note.id)
      .then((assignedCloudId) => {
        if (cancelled) return;
        if (!assignedCloudId) throw new Error("Note sync did not assign a cloud id");
        // Loading carries on into the share settings' load.
        setSyncedFor({ noteId: note.id, cloudId: assignedCloudId });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Note sync for sharing failed:", err);
        setLoadError(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, isTeamNote, knownCloudId, note.id, loadAttempt]);

  // Loading also reconciles the local is_shared flag with server truth.
  useEffect(() => {
    if (!open || !cloudId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    refreshShareCache()
      .then((res) => {
        if (cancelled || !res) return;
        setRefreshedCloudId(cloudId);
        const update = reconcileLocalShareState(localShareStateRef.current, res.share);
        if (update) {
          void persistNoteShareState(note.id, update).catch((err) =>
            console.error("Share flag persist failed:", err)
          );
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to load share settings:", err);
        setLoadError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cloudId, note.id, loadAttempt, refreshShareCache]);

  useEffect(() => {
    if (open) {
      emailInputRef.current?.focus();
    } else {
      setEmailInput("");
      setInputError(null);
      setCopied(false);
      setConfirmingReplaceLink(false);
      setConfirmMove(null);
      setRefreshedCloudId(null);
    }
  }, [open]);

  useEffect(() => {
    const query = emailInput.trim();
    if (!open || !cloudId || !canSearchPrincipals || !query) {
      setSuggestions([]);
      setSearchingSuggestions(false);
      setSuggestionsSettled(false);
      return;
    }
    let cancelled = false;
    setSearchingSuggestions(true);
    setSuggestionsSettled(false);
    const timer = window.setTimeout(() => {
      NoteSharingService.searchAccessPrincipals(cloudId, query)
        .then((res) => {
          if (!cancelled) {
            setSuggestions(res.suggestions.filter((item) => !item.existing_grant_id));
            setSuggestionsSettled(true);
          }
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        })
        .finally(() => {
          if (!cancelled) setSearchingSuggestions(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, cloudId, canSearchPrincipals, emailInput]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) window.clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const applyVisibility = useCallback(
    async (next: ShareVisibility): Promise<ShareMutationResponse | null> => {
      if (!cloudId || !canManageAccess) return null;
      const previous = getShareCacheEntry(cloudId);
      if (!previous || previous.share.visibility === next) return null;
      const action: SharePolicyAction =
        next === "private"
          ? "make-private"
          : next === "link"
            ? "create-link"
            : next === "domain"
              ? "set-domain"
              : "invite";
      if (!shareActionAllowed(action, previous.share.visibility)) return null;
      setSavingVisibility(true);
      // Optimistic update so the dropdown feels instant.
      updateShareCache(cloudId, (entry) => ({
        share: {
          ...(entry?.share ?? previous.share),
          visibility: next,
          domain_allowlist:
            next === "domain" && ownerDomain
              ? entry?.share.domain_allowlist.length
                ? entry.share.domain_allowlist
                : [ownerDomain]
              : (entry?.share.domain_allowlist ?? []),
        },
        invitations: entry?.invitations ?? [],
        rawToken: entry?.rawToken ?? null,
      }));
      try {
        if (next === "private") {
          const res = await NoteSharingService.clearShare(cloudId);
          updateShareCache(cloudId, (entry) => ({
            share: res.share,
            invitations: entry?.invitations ?? [],
            rawToken: null,
          }));
          // Local bookkeeping must not roll back a succeeded server call; the
          // dialog-open reconcile heals a failed flag write.
          void persistNoteShareState(note.id, { is_shared: 0, share_token: null }).catch((err) =>
            console.error("Share flag persist failed:", err)
          );
          return null;
        }
        const res = await NoteSharingService.updateShareSettings(
          cloudId,
          next,
          next === "domain" && ownerDomain ? [ownerDomain] : []
        );
        updateShareCache(cloudId, (entry) => ({
          share: res.share,
          invitations: entry?.invitations ?? [],
          rawToken: res.raw_token ?? entry?.rawToken ?? null,
        }));
        void persistNoteShareState(
          note.id,
          res.raw_token ? { is_shared: 1, share_token: res.raw_token } : { is_shared: 1 }
        ).catch((err) => console.error("Share flag persist failed:", err));
        return res;
      } catch (err) {
        console.error("Failed to update sharing:", err);
        updateShareCache(cloudId, (entry) => ({
          share: previous.share,
          invitations: entry?.invitations ?? previous.invitations,
          rawToken: previous.rawToken,
        }));
        toast({
          title: t("noteEditor.share.dialog.error.visibilityFailed"),
          variant: "destructive",
        });
        return null;
      } finally {
        setSavingVisibility(false);
      }
    },
    [cloudId, canManageAccess, ownerDomain, note.id, t, toast, shareActionAllowed]
  );

  // A shared private note syncs only while its share lasts. Once removing
  // someone leaves nobody but the owner, ending the share keeps the note on
  // this device: the server confirms it private and the local flag follows.
  const endLegacyShareIfUnreachable = useCallback(
    async (state: ShareStateResponse | null): Promise<void> => {
      if (shareState !== "legacyShared" || !state || shareReachesAnyone(state)) return;
      await applyVisibility("private");
    },
    [shareState, applyVisibility]
  );

  const copyLink = useCallback(
    async (url: string) => {
      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        if (copyTimeoutRef.current) window.clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = window.setTimeout(() => setCopied(false), 1500);
      } catch (err) {
        console.error("Clipboard write failed:", err);
        toast({ title: t("noteEditor.share.dialog.error.copyFailed"), variant: "destructive" });
      }
    },
    [t, toast]
  );

  // The raw token is returned only on generate or rotate, so a share made on
  // another device, or by an invite, leaves none here; rotating is the only
  // way to recover a copyable link (the old one stops working by design).
  const rotateAndCopy = useCallback(
    async (visibility: ShareVisibility) => {
      if (!cloudId || !canManageAccess || !shareActionAllowed("rotate-link", visibility)) {
        toast({ title: t("noteEditor.share.dialog.error.copyFailed"), variant: "destructive" });
        return;
      }
      try {
        const res = await NoteSharingService.rotateToken(cloudId);
        updateShareCache(cloudId, (entry) => ({
          share: res.share,
          invitations: entry?.invitations ?? [],
          rawToken: res.raw_token,
        }));
        void persistNoteShareState(note.id, { is_shared: 1, share_token: res.raw_token }).catch(
          (err) => console.error("Share flag persist failed:", err)
        );
        const link = resolveShareLink(res.share, [res.raw_token]);
        if (link.kind !== "copy") throw new Error("Rotated share has no copyable link");
        await copyLink(link.url);
      } catch (err) {
        console.error("Share link recovery failed:", err);
        toast({ title: t("noteEditor.share.dialog.error.copyFailed"), variant: "destructive" });
      }
    },
    [cloudId, canManageAccess, note.id, copyLink, t, toast, shareActionAllowed]
  );

  // Reads the cache rather than render state: a Create link click, or a
  // refresh that lands while the replace confirm is open, may have changed it.
  const copyCurrentLink = useCallback(
    async (replaceConfirmed: boolean) => {
      const entry = cloudId ? getShareCacheEntry(cloudId) : null;
      if (!entry || entry.share.visibility === "private") {
        toast({ title: t("noteEditor.share.dialog.error.copyFailed"), variant: "destructive" });
        return;
      }
      const link = resolveShareLink(entry.share, [note.share_token, entry.rawToken]);
      if (link.kind === "copy") await copyLink(link.url);
      else if (link.needsConfirmation && !replaceConfirmed) setConfirmingReplaceLink(true);
      else await rotateAndCopy(entry.share.visibility);
    },
    [cloudId, note.share_token, copyLink, rotateAndCopy, t, toast]
  );

  const handleLinkButton = useCallback(async () => {
    if (!cloudId || !share || !canUseLink) return;
    setLinkBusy(true);
    try {
      // Create link: the click is the sharing consent.
      if (share.visibility === "private" && !(await applyVisibility("link"))) return;
      await copyCurrentLink(false);
    } finally {
      setLinkBusy(false);
    }
  }, [cloudId, share, canUseLink, applyVisibility, copyCurrentLink]);

  const handleReplaceLink = useCallback(async () => {
    // The confirm stays clickable through its exit animation, and a second
    // rotation can leave this device holding a dead token.
    if (linkBusy) return;
    setLinkBusy(true);
    try {
      await copyCurrentLink(true);
    } finally {
      setLinkBusy(false);
    }
  }, [linkBusy, copyCurrentLink]);

  const copyIntentHandled = useRef(false);
  useEffect(() => {
    if (!open) {
      copyIntentHandled.current = false;
      return;
    }
    if (
      copyLinkOnOpen &&
      !copyIntentHandled.current &&
      share &&
      refreshedCloudId === cloudId &&
      canUseLink
    ) {
      copyIntentHandled.current = true;
      void handleLinkButton();
    }
  }, [open, copyLinkOnOpen, share, refreshedCloudId, cloudId, canUseLink, handleLinkButton]);

  const handleInvite = useCallback(async () => {
    if (!cloudId || !canInvite) return;
    const trimmed = emailInput.trim();
    if (!trimmed) return;
    if (!EMAIL_REGEX.test(trimmed)) {
      setInputError(t("noteEditor.share.dialog.error.invalidEmail"));
      return;
    }
    setInputError(null);
    setSubmitting(true);
    try {
      const res = await NoteSharingService.inviteEmails(cloudId, [trimmed]);
      if (res.already_invited.length > 0) {
        setInputError(
          t("noteEditor.share.dialog.error.alreadyInvited", { email: res.already_invited[0] })
        );
      } else {
        setEmailInput("");
      }
      // Re-fetch invitations so any new + still-pending rows appear.
      const refreshed = await refreshShareCache();
      if (!refreshed) return;
      // The invite itself is the sharing consent: a still-private note becomes
      // invite-only once an invitation exists.
      if (refreshed.share.visibility === "private" && res.created.length > 0) {
        await applyVisibility("invited");
      }
    } catch (err) {
      console.error("Invite failed:", err);
      setInputError(t("noteEditor.share.dialog.error.inviteFailed"));
    } finally {
      setSubmitting(false);
    }
  }, [cloudId, canInvite, emailInput, applyVisibility, refreshShareCache, t]);

  const handlePrincipalGrant = useCallback(
    async (principal: AccessPrincipalSuggestion) => {
      if (!cloudId || !canInvite || !cached?.access?.can_manage_access) return;
      setSubmitting(true);
      setInputError(null);
      try {
        const grant = await NoteSharingService.createAccessGrant(cloudId, {
          principal_type: principal.type,
          ...(principal.id ? { principal_id: principal.id } : {}),
          ...(principal.email ? { email: principal.email } : {}),
          permission: "viewer",
        });
        const refreshed = await refreshShareCache((currentAccess) =>
          currentAccess
            ? { ...currentAccess, grants: [...currentAccess.grants, grant] }
            : cached.access
        );
        if (!refreshed) return;
        if (refreshed.share.visibility !== "private") {
          void persistNoteShareState(note.id, { is_shared: 1 }).catch((err) =>
            console.error("Share flag persist failed:", err)
          );
        }
        setEmailInput("");
        setSuggestions([]);
      } catch (err) {
        console.error("Access grant creation failed:", err);
        setInputError(t("noteEditor.share.dialog.error.inviteFailed"));
      } finally {
        setSubmitting(false);
      }
    },
    [cloudId, canInvite, cached, note.id, refreshShareCache, t]
  );

  const handleShareInput = useCallback(async () => {
    const trimmed = emailInput.trim();
    if (!trimmed || !canInvite) return;

    if (access) {
      const matchingSuggestion = suggestions.find(
        (principal) =>
          principal.email?.toLowerCase() === trimmed.toLowerCase() ||
          principal.name?.toLowerCase() === trimmed.toLowerCase()
      );
      if (matchingSuggestion) {
        await handlePrincipalGrant(matchingSuggestion);
        return;
      }
      if (EMAIL_REGEX.test(trimmed)) {
        await handlePrincipalGrant({
          type: "email",
          id: null,
          email: trimmed,
          name: null,
          image: null,
          member_count: null,
          existing_grant_id: null,
        });
        return;
      }
    }

    await handleInvite();
  }, [access, canInvite, emailInput, suggestions, handlePrincipalGrant, handleInvite]);

  const handleRevoke = useCallback(
    async (invitation: NoteShareInvitation) => {
      if (!cloudId || !canManageAccess || !shareActionAllowed("revoke-invitation")) return;
      const previous = getShareCacheEntry(cloudId);
      if (!previous) return;
      updateShareCache(cloudId, (entry) => ({
        share: entry?.share ?? previous.share,
        invitations: (entry?.invitations ?? previous.invitations).filter(
          (i) => i.id !== invitation.id
        ),
        rawToken: entry?.rawToken ?? previous.rawToken,
      }));
      try {
        await NoteSharingService.revokeInvite(cloudId, invitation.id);
      } catch (err) {
        console.error("Revoke failed:", err);
        updateShareCache(cloudId, (entry) => ({
          share: entry?.share ?? previous.share,
          invitations: previous.invitations,
          rawToken: entry?.rawToken ?? previous.rawToken,
        }));
        toast({ title: t("noteEditor.share.dialog.error.revokeFailed"), variant: "destructive" });
        return;
      }
      if (shareState === "legacyShared") {
        await endLegacyShareIfUnreachable(await refreshShareCache().catch(() => null));
      }
    },
    [
      cloudId,
      canManageAccess,
      shareActionAllowed,
      shareState,
      endLegacyShareIfUnreachable,
      refreshShareCache,
      t,
      toast,
    ]
  );

  const handleResend = useCallback(
    async (invitation: NoteShareInvitation) => {
      if (!cloudId || !canManageAccess || !shareActionAllowed("resend-invitation")) return;
      setResendingId(invitation.id);
      try {
        const res = await NoteSharingService.resendInvite(cloudId, invitation.id);
        if (res.resent) {
          toast({ title: t("noteEditor.share.dialog.resendSent"), variant: "success" });
        } else {
          toast({ title: t("noteEditor.share.dialog.resendThrottled") });
        }
      } catch (err) {
        console.error("Resend failed:", err);
        toast({ title: t("noteEditor.share.dialog.error.resendFailed"), variant: "destructive" });
      } finally {
        setResendingId(null);
      }
    },
    [cloudId, canManageAccess, shareActionAllowed, t, toast]
  );

  const replaceAccessGrant = useCallback(
    (grantId: string, replacement: NoteAccessGrant | null) => {
      if (!cloudId || !cached) return;
      updateShareCache(cloudId, (entry) => ({
        share: entry?.share ?? cached.share,
        invitations: entry?.invitations ?? cached.invitations,
        access: entry?.access
          ? {
              ...entry.access,
              grants: replacement
                ? entry.access.grants.map((grant) => (grant.id === grantId ? replacement : grant))
                : entry.access.grants.filter((grant) => grant.id !== grantId),
            }
          : undefined,
        rawToken: entry?.rawToken ?? cached.rawToken,
      }));
    },
    [cloudId, cached]
  );

  const handleGrantPermission = useCallback(
    async (grant: NoteAccessGrant, permission: NoteAccessGrant["permission"]) => {
      if (
        !cloudId ||
        !canManageAccess ||
        !shareActionAllowed("change-grant") ||
        grant.permission === permission
      ) {
        return;
      }
      setBusyGrantId(grant.id);
      replaceAccessGrant(grant.id, { ...grant, permission });
      try {
        replaceAccessGrant(
          grant.id,
          await NoteSharingService.updateAccessGrant(cloudId, grant.id, permission)
        );
      } catch (err) {
        console.error("Access grant update failed:", err);
        replaceAccessGrant(grant.id, grant);
        toast({
          title: t("noteEditor.share.dialog.error.visibilityFailed"),
          variant: "destructive",
        });
      } finally {
        setBusyGrantId(null);
      }
    },
    [cloudId, canManageAccess, shareActionAllowed, replaceAccessGrant, t, toast]
  );

  const handleRemoveGrant = useCallback(
    async (grant: NoteAccessGrant) => {
      if (!cloudId || !canManageAccess || !shareActionAllowed("remove-grant")) return;
      setBusyGrantId(grant.id);
      replaceAccessGrant(grant.id, null);
      try {
        await NoteSharingService.removeAccessGrant(cloudId, grant.id);
        await endLegacyShareIfUnreachable(await refreshShareCache());
      } catch (err) {
        console.error("Access grant removal failed:", err);
        replaceAccessGrant(grant.id, grant);
        toast({ title: t("noteEditor.share.dialog.error.revokeFailed"), variant: "destructive" });
      } finally {
        setBusyGrantId(null);
      }
    },
    [
      cloudId,
      canManageAccess,
      shareActionAllowed,
      refreshShareCache,
      replaceAccessGrant,
      endLegacyShareIfUnreachable,
      t,
      toast,
    ]
  );

  // Moves the private note into a teamspace. The dialog then shares it from
  // there: the team share view gets the note's cloud id from its upload.
  const handleMoveToShare = useCallback(
    async (target: SpaceItem) => {
      if (!onMoveNote || !canMoveNote || movingTo !== null) return;
      const fromSpaceId = note.space_id;
      setMovingTo(target.id);
      let result: NoteMutationResult | null;
      try {
        result = (await onMoveNote(note.id, { spaceId: target.id, folderId: null })) || null;
      } catch (err) {
        console.error("Move to share failed:", err);
        result = { success: false, error: err instanceof Error ? err.message : undefined };
      } finally {
        setMovingTo(null);
      }
      if (result?.success === false) {
        toast({
          title: t("notes.spaces.couldNotMoveNote"),
          description: t(localMutationErrorKey(result.error)),
          variant: "destructive",
        });
        return;
      }
      setMoved({ noteId: note.id, fromSpaceId, toSpaceId: target.id });
    },
    [onMoveNote, canMoveNote, movingTo, note.id, note.space_id, t, toast]
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || (e.metaKey && e.key === "Enter")) {
      e.preventDefault();
      void handleShareInput();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-3 p-5">
        <DialogTitle className="text-base">{t("noteEditor.share.dialog.title")}</DialogTitle>

        {shareState === "moveToShare" ? (
          <>
            <DialogDescription className="text-xs text-foreground/50">
              {t(
                canMoveNote
                  ? "noteEditor.share.dialog.moveToShare"
                  : "noteEditor.share.dialog.cantMoveToShare"
              )}
            </DialogDescription>
            {canOfferMove &&
              (moveTargets.length > 0 ? (
                <div className="flex flex-col gap-0.5">
                  {moveTargets.map((target) => (
                    <Button
                      key={target.id}
                      variant="ghost"
                      size="sm"
                      disabled={movingTo !== null}
                      onClick={() => setConfirmMove({ target, open: true })}
                      className="h-9 w-full justify-start gap-2 rounded-md px-1 text-xs font-normal"
                    >
                      {target.emoji ? (
                        <span
                          aria-hidden="true"
                          className="w-7 h-7 rounded-md bg-foreground/5 flex items-center justify-center text-sm shrink-0"
                        >
                          {target.emoji}
                        </span>
                      ) : (
                        <AudienceIcon />
                      )}
                      <span dir="auto" className="min-w-0 flex-1 truncate text-start">
                        {target.name}
                      </span>
                      {movingTo === target.id && (
                        <Loader2 size={12} className="animate-spin text-foreground/45" />
                      )}
                    </Button>
                  ))}
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2 py-1">
                  <p className="text-xs text-foreground/50">
                    {t("noteEditor.share.dialog.noTeamspaces")}
                  </p>
                  {onOpenTeamspaces && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => {
                        onOpenChange(false);
                        onOpenTeamspaces();
                      }}
                    >
                      {t("noteEditor.share.dialog.openTeamspaces")}
                    </Button>
                  )}
                </div>
              ))}
          </>
        ) : loadError ? (
          <div className="flex items-center justify-between gap-2 py-1">
            <p className="text-xs text-foreground/50">
              {t("noteEditor.share.dialog.error.loadFailed")}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => setLoadAttempt((a) => a + 1)}
            >
              {t("noteEditor.share.dialog.error.retry")}
            </Button>
          </div>
        ) : !cloudId ? (
          <div className="flex items-center justify-center py-6">
            <DialogDescription className="sr-only">
              {t("noteEditor.share.dialog.description")}
            </DialogDescription>
            <Loader2 size={14} className="animate-spin text-foreground/45" />
          </div>
        ) : (
          <>
            <DialogDescription className="sr-only">
              {t("noteEditor.share.dialog.description")}
            </DialogDescription>

            {shareState === "legacyShared" && (
              <p className="rounded-lg border border-border/70 bg-foreground/3 px-3 py-2 text-[11px] leading-relaxed text-foreground/60 dark:border-white/10 dark:bg-white/4">
                {t("noteEditor.share.dialog.legacySharedBanner")}
              </p>
            )}

            {inviteAllowedByPolicy && (
              <div className="relative">
                <div className="flex items-center gap-2">
                  <input
                    dir="auto"
                    ref={emailInputRef}
                    type="text"
                    value={emailInput}
                    onChange={(e) => {
                      setEmailInput(e.target.value);
                      if (inputError) setInputError(null);
                    }}
                    onKeyDown={onKeyDown}
                    placeholder={t("noteEditor.share.dialog.searchPlaceholder")}
                    disabled={loading || submitting || !canInvite}
                    className={cn(
                      notesInputClass,
                      "flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
                    )}
                    aria-label={t("noteEditor.share.dialog.emailLabel")}
                    aria-invalid={inputError ? true : undefined}
                    aria-describedby={inputError ? "share-invite-error" : undefined}
                  />
                  <Button
                    size="sm"
                    onClick={() => void handleShareInput()}
                    disabled={loading || submitting || !canInvite || !emailInput.trim()}
                    className="h-8 px-3 text-xs gap-1.5"
                  >
                    {submitting && <Loader2 size={12} className="animate-spin" />}
                    {t("noteEditor.share.dialog.shareButton")}
                  </Button>
                </div>

                {access &&
                  emailInput.trim() &&
                  (searchingSuggestions || suggestions.length > 0 || suggestionsSettled) && (
                    <div className="absolute z-20 top-9 start-0 end-[72px] max-h-44 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
                      {searchingSuggestions && suggestions.length === 0 ? (
                        <div className="h-8 flex items-center justify-center">
                          <Loader2 size={12} className="animate-spin text-foreground/45" />
                        </div>
                      ) : suggestions.length === 0 ? (
                        <div className="h-8 flex items-center justify-center">
                          <span className="text-xs text-foreground/45">
                            {t("noteEditor.share.dialog.noResults")}
                          </span>
                        </div>
                      ) : (
                        suggestions.map((principal) => (
                          <button
                            key={`${principal.type}:${principal.id ?? principal.email}`}
                            type="button"
                            onClick={() => void handlePrincipalGrant(principal)}
                            className="flex items-center gap-2 w-full min-w-0 px-2 h-9 rounded-md text-start hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            {principal.type === "team" ||
                            principal.type === "folder" ||
                            principal.type === "workspace" ? (
                              <AudienceIcon />
                            ) : (
                              <MemberAvatar
                                name={principal.name}
                                email={principal.email ?? principal.name ?? ""}
                                image={principal.image}
                              />
                            )}
                            <span className="min-w-0 flex-1">
                              <span dir="auto" className="block text-xs text-foreground truncate">
                                {principal.name || principal.email}
                              </span>
                              {principal.name && principal.email && (
                                <span
                                  dir="ltr"
                                  className="block text-[11px] text-foreground/45 truncate"
                                >
                                  {principal.email}
                                </span>
                              )}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
              </div>
            )}

            {inviteAllowedByPolicy && (
              <p
                id="share-invite-error"
                aria-live="polite"
                className={cn("text-xs text-red-500/90 -mt-1", !inputError && "sr-only")}
              >
                {inputError}
              </p>
            )}

            <div className="flex flex-col gap-1.5 mt-1">
              {(access?.owner || !isTeamNote) && (
                <MemberRow
                  leading={
                    <MemberAvatar
                      name={access?.owner.name ?? ownerName}
                      email={access?.owner.email ?? ownerEmail}
                      image={access?.owner.image}
                    />
                  }
                  primary={access?.owner.name || access?.owner.email || ownerName || ownerEmail}
                  secondary={
                    access?.owner.name ? access.owner.email : ownerName ? ownerEmail : null
                  }
                  secondaryDir="ltr"
                  trailing={
                    <span className="text-[11px] text-foreground/45">
                      {t("noteEditor.share.dialog.owner")}
                    </span>
                  }
                />
              )}

              {(access?.grants ?? []).map((grant) => (
                <AccessGrantRow
                  key={grant.id}
                  grant={grant}
                  canChangePermission={
                    canManageAccessGrant(access, grant) && shareActionAllowed("change-grant")
                  }
                  showPermissionActions={shareActionAllowed("change-grant")}
                  canRemove={
                    canManageAccessGrant(access, grant) && shareActionAllowed("remove-grant")
                  }
                  busy={busyGrantId === grant.id}
                  onPermissionChange={(permission) => void handleGrantPermission(grant, permission)}
                  onRemove={() => void handleRemoveGrant(grant)}
                />
              ))}

              {isTeamNote &&
                space &&
                !(access?.grants ?? []).some(
                  (grant) =>
                    grant.principal.type === "team" &&
                    space.teams.some((team) => team.id === grant.principal.id)
                ) && (
                  <MemberRow
                    leading={<AudienceIcon />}
                    primary={space.name}
                    secondary={t("noteEditor.share.dialog.teamAudience")}
                    trailing={
                      <span className="text-[11px] text-foreground/45">
                        {t("noteEditor.share.dialog.editor")}
                      </span>
                    }
                  />
                )}

              {visibleInvitations.map((invitation) => (
                <MemberRow
                  key={invitation.id}
                  leading={<MemberAvatar name={null} email={invitation.email} size="md" />}
                  primary={invitation.email}
                  primaryDir="ltr"
                  secondary={
                    invitation.accepted_at
                      ? t("noteEditor.share.dialog.accepted")
                      : t("noteEditor.share.dialog.pending")
                  }
                  trailing={
                    canManageAccess ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className={cn(
                              "h-6 w-6 flex items-center justify-center rounded-md",
                              "hover:bg-foreground/8 dark:hover:bg-white/8",
                              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                              "transition-colors"
                            )}
                            aria-label={t("noteEditor.share.dialog.invitationActions")}
                          >
                            <MoreHorizontal size={13} className="text-foreground/50" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" sideOffset={4}>
                          {shareActionAllowed("resend-invitation") && (
                            <DropdownMenuItem
                              className="text-xs"
                              disabled={resendingId === invitation.id}
                              onClick={() => void handleResend(invitation)}
                            >
                              {t("noteEditor.share.dialog.resend")}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            className="text-xs text-red-500"
                            onClick={() => void handleRevoke(invitation)}
                          >
                            {t("noteEditor.share.dialog.revoke")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <span className="text-[11px] text-foreground/45">
                        {t("noteEditor.share.dialog.viewer")}
                      </span>
                    )
                  }
                />
              ))}
            </div>

            <div className="flex items-center gap-2 pt-3 mt-1 border-t border-border/70">
              <ShareVisibilityMenu
                value={share?.visibility ?? "private"}
                ownerDomain={ownerDomain}
                showDomainOption={showDomainOption}
                visibleOptions={visibleShareVisibilities}
                disabled={loading || !share || !canManageAccess || savingVisibility || linkBusy}
                onChange={(v) => void applyVisibility(v)}
              />
              <div className="flex-1" />
              {linkActionAllowedByPolicy && (
                <Button
                  variant={isPrivate ? "default" : "outline"}
                  size="sm"
                  className="h-8 px-3 text-xs gap-1.5"
                  disabled={loading || !share || !canUseLink || savingVisibility || linkBusy}
                  onClick={() => void handleLinkButton()}
                >
                  {linkBusy ? (
                    <>
                      <Loader2 size={12} className="animate-spin" />
                      {isPrivate
                        ? t("noteEditor.share.dialog.createLink")
                        : t("noteEditor.share.dialog.copyLink")}
                    </>
                  ) : copied ? (
                    <>
                      <Check size={12} />
                      {t("noteEditor.share.dialog.copied")}
                    </>
                  ) : isPrivate ? (
                    <>
                      <Link2 size={12} />
                      {t("noteEditor.share.dialog.createLink")}
                    </>
                  ) : (
                    <>
                      <Copy size={12} />
                      {t("noteEditor.share.dialog.copyLink")}
                    </>
                  )}
                </Button>
              )}
            </div>
          </>
        )}

        {exportOptions.length > 0 && (
          <div className="mt-1 border-t border-border/70 pt-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground/55">
              {t("noteEditor.share.dialog.export")}
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {exportOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    option.onSelect();
                    onOpenChange(false);
                  }}
                  className="flex items-center gap-2.5 rounded-xl border border-border/70 px-3 py-2.5 text-start text-xs font-medium text-foreground/80 transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/30 dark:border-white/10 dark:hover:bg-surface-2"
                >
                  <FileText size={14} className="shrink-0 text-foreground/55" />
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <ConfirmDialog
          open={confirmingReplaceLink}
          onOpenChange={setConfirmingReplaceLink}
          title={t("noteEditor.share.dialog.replaceLink.title")}
          description={t("noteEditor.share.dialog.replaceLink.description")}
          confirmText={t("noteEditor.share.dialog.replaceLink.confirm")}
          cancelText={t("common.cancel")}
          variant="destructive"
          onConfirm={() => void handleReplaceLink()}
        />

        <ConfirmDialog
          open={confirmMove?.open ?? false}
          onOpenChange={(next) => {
            if (!next) setConfirmMove((current) => current && { ...current, open: false });
          }}
          title={t("noteEditor.share.dialog.moveConfirmTitle", {
            space: confirmMove?.target.name ?? "",
          })}
          description={t("notes.spaces.confirmMoveIn", { space: confirmMove?.target.name ?? "" })}
          confirmText={t("notes.spaces.moveConfirm")}
          cancelText={t("common.cancel")}
          onConfirm={() => {
            if (confirmMove) void handleMoveToShare(confirmMove.target);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

interface MemberRowProps {
  leading?: React.ReactNode;
  primary: string;
  primaryDir?: "auto" | "ltr";
  secondary: string | null;
  secondaryDir?: "auto" | "ltr";
  trailing: React.ReactNode;
}

function MemberRow({
  leading,
  primary,
  primaryDir = "auto",
  secondary,
  secondaryDir = "auto",
  trailing,
}: MemberRowProps) {
  return (
    <div className="flex items-center gap-2 py-1.5 px-1">
      {leading}
      <div className="flex-1 min-w-0">
        <p dir={primaryDir} className="text-xs text-foreground truncate">
          {primary}
        </p>
        {secondary && (
          <p dir={secondaryDir} className="text-[11px] text-foreground/45 truncate">
            {secondary}
          </p>
        )}
      </div>
      {trailing}
    </div>
  );
}

function AudienceIcon() {
  return (
    <span className="w-7 h-7 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
      <Users size={14} />
    </span>
  );
}

function AccessGrantRow({
  grant,
  canChangePermission,
  showPermissionActions,
  canRemove,
  busy,
  onPermissionChange,
  onRemove,
}: {
  grant: NoteAccessGrant;
  canChangePermission: boolean;
  showPermissionActions: boolean;
  canRemove: boolean;
  busy: boolean;
  onPermissionChange: (permission: NoteAccessGrant["permission"]) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const principal = grant.principal;
  const isGroup =
    principal.type === "team" || principal.type === "folder" || principal.type === "workspace";
  const primary = principal.name || principal.email || "";
  const secondary = grant.pending
    ? t("noteEditor.share.dialog.pending")
    : principal.type === "team"
      ? t("noteEditor.share.dialog.teamAudience")
      : principal.name
        ? principal.email
        : null;

  const permissionLabel = t(
    grant.permission === "editor"
      ? "noteEditor.share.dialog.editor"
      : "noteEditor.share.dialog.viewer"
  );

  return (
    <MemberRow
      leading={
        isGroup ? (
          <AudienceIcon />
        ) : (
          <MemberAvatar
            name={principal.name}
            email={principal.email ?? primary}
            image={principal.image}
          />
        )
      }
      primary={primary}
      secondary={secondary}
      secondaryDir={
        !grant.pending && principal.type !== "team" && principal.name && principal.email
          ? "ltr"
          : "auto"
      }
      trailing={
        canChangePermission || canRemove ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={busy}
                aria-label={t("noteEditor.share.dialog.invitationActions")}
                className={cn(
                  "h-7 px-2 flex items-center gap-1 rounded-md text-[11px] text-foreground/50",
                  "hover:bg-foreground/8 dark:hover:bg-white/8",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  "disabled:opacity-50 transition-colors"
                )}
              >
                {busy && <Loader2 size={11} className="animate-spin" />}
                {permissionLabel}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={4}>
              {showPermissionActions && (
                <>
                  <DropdownMenuItem
                    className="text-xs gap-2"
                    disabled={!canChangePermission}
                    onClick={() => onPermissionChange("viewer")}
                  >
                    {grant.permission === "viewer" && <Check size={11} />}
                    {t("noteEditor.share.dialog.viewer")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-xs gap-2"
                    disabled={!canChangePermission}
                    onClick={() => onPermissionChange("editor")}
                  >
                    {grant.permission === "editor" && <Check size={11} />}
                    {t("noteEditor.share.dialog.editor")}
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuItem
                className="text-xs text-red-500"
                disabled={!canRemove}
                onClick={onRemove}
              >
                {t("noteEditor.share.dialog.revoke")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span className="text-[11px] text-foreground/45">{permissionLabel}</span>
        )
      }
    />
  );
}
