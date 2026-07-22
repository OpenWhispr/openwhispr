import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Link2, Loader2, MoreHorizontal, Users } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
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
import { useAuth } from "../../hooks/useAuth";
import {
  NoteSharingService,
  type AccessPrincipalSuggestion,
  type ShareMutationResponse,
} from "../../services/NoteSharingService.js";
import { syncService } from "../../services/SyncService.js";
import { CloudApiError } from "../../services/cloudApi.js";
import {
  getShareCacheEntry,
  persistNoteShareState,
  updateShareCache,
  useSpaces,
  useShareCacheEntry,
} from "../../stores/noteStore";
import { useToast } from "../ui/useToast";
import MemberAvatar from "../MemberAvatar";
import { emailDomain, isPersonalEmailDomain } from "../../utils/personalEmailDomains";
import type {
  NoteAccessGrant,
  NoteItem,
  NoteShareInvitation,
  ShareVisibility,
} from "../../types/electron";

const SHARE_VIEWER_BASE_URL = "https://notes.openwhispr.com";
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ShareNoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  note: NoteItem;
}

export default function ShareNoteDialog({ open, onOpenChange, note }: ShareNoteDialogProps) {
  const { user } = useAuth();
  const ownerName: string | null = user?.name ?? null;
  const ownerEmail: string = user?.email ?? "";
  const { t } = useTranslation();
  const { toast } = useToast();
  const spaces = useSpaces();
  const space = useMemo(
    () => spaces.find((candidate) => candidate.id === note.space_id) ?? null,
    [spaces, note.space_id]
  );
  const isTeamNote = space?.kind === "team";

  // A note synced from this dialog: markNoteSynced doesn't broadcast, so the
  // note prop can lag behind the local DB until the next note-updated event.
  const [syncedFor, setSyncedFor] = useState<{ noteId: number; cloudId: string } | null>(null);
  const cloudId = note.cloud_id ?? (syncedFor?.noteId === note.id ? syncedFor.cloudId : null);
  const cached = useShareCacheEntry(cloudId);

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [savingVisibility, setSavingVisibility] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [suggestions, setSuggestions] = useState<AccessPrincipalSuggestion[]>([]);
  const [searchingSuggestions, setSearchingSuggestions] = useState(false);
  const [copied, setCopied] = useState(false);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [busyGrantId, setBusyGrantId] = useState<string | null>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const copyTimeoutRef = useRef<number | null>(null);
  const localIsSharedRef = useRef(Boolean(note.is_shared));

  useEffect(() => {
    localIsSharedRef.current = Boolean(note.is_shared);
  }, [note.is_shared]);

  const ownerDomain = useMemo(() => emailDomain(ownerEmail), [ownerEmail]);
  const showDomainOption = Boolean(ownerDomain && !isPersonalEmailDomain(ownerDomain));

  const share = cached?.share ?? null;
  const access = cached?.access;
  const canManageSharing = access?.can_manage_access ?? true;
  // Principal search needs the ACL API; legacy servers only take raw emails.
  const canSearchPrincipals = Boolean(access?.can_manage_access);
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

  // The store's note can miss a cloud_id assigned by a background sync
  // (markNoteSynced doesn't broadcast); read the DB before offering to sync.
  useEffect(() => {
    if (!open || note.cloud_id) return;
    let cancelled = false;
    window.electronAPI
      .getNote?.(note.id)
      ?.then((fresh) => {
        if (!cancelled && fresh?.cloud_id) {
          setSyncedFor({ noteId: note.id, cloudId: fresh.cloud_id });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, note.id, note.cloud_id]);

  // Loading also reconciles the local is_shared flag with server truth.
  useEffect(() => {
    if (!open || !cloudId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    NoteSharingService.getShareSettings(cloudId)
      .then((res) => {
        if (cancelled) return;
        updateShareCache(cloudId, (entry) => ({
          share: res.share,
          invitations: res.invitations,
          access: res.access ?? entry?.access,
          rawToken: entry?.rawToken ?? null,
        }));
        const serverShared = res.share.visibility !== "private";
        if (serverShared !== localIsSharedRef.current) {
          void persistNoteShareState(
            note.id,
            serverShared ? { is_shared: 1 } : { is_shared: 0, share_token: null }
          ).catch((err) => console.error("Share flag persist failed:", err));
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
  }, [open, cloudId, note.id, loadAttempt]);

  useEffect(() => {
    if (open) {
      emailInputRef.current?.focus();
    } else {
      setEmailInput("");
      setInputError(null);
      setCopied(false);
    }
  }, [open]);

  useEffect(() => {
    const query = emailInput.trim();
    if (!open || !cloudId || !canSearchPrincipals || !query) {
      setSuggestions([]);
      setSearchingSuggestions(false);
      return;
    }
    let cancelled = false;
    setSearchingSuggestions(true);
    const timer = window.setTimeout(() => {
      NoteSharingService.searchAccessPrincipals(cloudId, query)
        .then((res) => {
          if (!cancelled) setSuggestions(res.suggestions.filter((item) => !item.existing_grant_id));
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
      if (!cloudId || !canManageSharing) return null;
      const previous = getShareCacheEntry(cloudId);
      if (!previous || previous.share.visibility === next) return null;
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
          title:
            err instanceof CloudApiError && err.code === "upgrade_required"
              ? t("noteEditor.share.dialog.error.upgradeRequired")
              : t("noteEditor.share.dialog.error.visibilityFailed"),
          variant: "destructive",
        });
        return null;
      } finally {
        setSavingVisibility(false);
      }
    },
    [cloudId, canManageSharing, ownerDomain, note.id, t, toast]
  );

  const copyLink = useCallback(
    async (token: string) => {
      try {
        await navigator.clipboard.writeText(
          `${SHARE_VIEWER_BASE_URL}/n/${encodeURIComponent(token)}`
        );
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

  // Legacy shares can predate local token persistence; rotating is the only
  // way to recover a copyable link (the old one stops working by design).
  const rotateAndCopy = useCallback(async () => {
    if (!cloudId) return;
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
      await copyLink(res.raw_token);
    } catch (err) {
      console.error("Share link recovery failed:", err);
      toast({ title: t("noteEditor.share.dialog.error.copyFailed"), variant: "destructive" });
    }
  }, [cloudId, note.id, copyLink, t, toast]);

  const handleLinkButton = useCallback(async () => {
    if (!cloudId || !share || !canManageSharing) return;
    setLinkBusy(true);
    try {
      if (share.visibility === "private") {
        // Create link: the click is the sharing consent.
        const res = await applyVisibility("link");
        if (!res) return;
        const token = res.raw_token ?? note.share_token ?? getShareCacheEntry(cloudId)?.rawToken;
        if (token) await copyLink(token);
        else await rotateAndCopy();
        return;
      }
      const known = note.share_token ?? getShareCacheEntry(cloudId)?.rawToken;
      if (known) await copyLink(known);
      else await rotateAndCopy();
    } finally {
      setLinkBusy(false);
    }
  }, [
    cloudId,
    share,
    canManageSharing,
    note.share_token,
    applyVisibility,
    copyLink,
    rotateAndCopy,
  ]);

  const handleInvite = useCallback(async () => {
    if (!cloudId || !canManageSharing) return;
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
      const refreshed = await NoteSharingService.getShareSettings(cloudId);
      updateShareCache(cloudId, (entry) => ({
        share: refreshed.share,
        invitations: refreshed.invitations,
        rawToken: entry?.rawToken ?? null,
      }));
      // The invite itself is the sharing consent: a still-private note becomes
      // invite-only once an invitation exists.
      if (refreshed.share.visibility === "private" && res.created.length > 0) {
        await applyVisibility("invited");
      }
    } catch (err) {
      console.error("Invite failed:", err);
      setInputError(
        err instanceof CloudApiError && err.code === "upgrade_required"
          ? t("noteEditor.share.dialog.error.upgradeRequired")
          : t("noteEditor.share.dialog.error.inviteFailed")
      );
    } finally {
      setSubmitting(false);
    }
  }, [cloudId, canManageSharing, emailInput, applyVisibility, t]);

  const handlePrincipalGrant = useCallback(
    async (principal: AccessPrincipalSuggestion) => {
      if (!cloudId || !cached?.access?.can_manage_access) return;
      setSubmitting(true);
      setInputError(null);
      try {
        const grant = await NoteSharingService.createAccessGrant(cloudId, {
          principal_type: principal.type,
          ...(principal.id ? { principal_id: principal.id } : {}),
          ...(principal.email ? { email: principal.email } : {}),
          permission: "viewer",
        });
        const refreshed = await NoteSharingService.getShareSettings(cloudId);
        updateShareCache(cloudId, (entry) => ({
          share: refreshed.share,
          invitations: refreshed.invitations,
          access:
            refreshed.access ??
            (entry?.access
              ? { ...entry.access, grants: [...entry.access.grants, grant] }
              : cached.access),
          rawToken: entry?.rawToken ?? cached.rawToken,
        }));
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
    [cloudId, cached, note.id, t]
  );

  const handleShareInput = useCallback(async () => {
    const trimmed = emailInput.trim();
    if (!trimmed || !canManageSharing) return;

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
  }, [access, canManageSharing, emailInput, suggestions, handlePrincipalGrant, handleInvite]);

  const handleRevoke = useCallback(
    async (invitation: NoteShareInvitation) => {
      if (!cloudId || !canManageSharing) return;
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
      }
    },
    [cloudId, canManageSharing, t, toast]
  );

  const handleResend = useCallback(
    async (invitation: NoteShareInvitation) => {
      if (!cloudId || !canManageSharing) return;
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
    [cloudId, canManageSharing, t, toast]
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
      if (!cloudId || grant.permission === permission) return;
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
    [cloudId, replaceAccessGrant, t, toast]
  );

  const handleRemoveGrant = useCallback(
    async (grant: NoteAccessGrant) => {
      if (!cloudId) return;
      setBusyGrantId(grant.id);
      replaceAccessGrant(grant.id, null);
      try {
        await NoteSharingService.removeAccessGrant(cloudId, grant.id);
        const refreshed = await NoteSharingService.getShareSettings(cloudId);
        updateShareCache(cloudId, (entry) => ({
          share: refreshed.share,
          invitations: refreshed.invitations,
          access: refreshed.access ?? entry?.access,
          rawToken: entry?.rawToken ?? null,
        }));
      } catch (err) {
        console.error("Access grant removal failed:", err);
        replaceAccessGrant(grant.id, grant);
        toast({ title: t("noteEditor.share.dialog.error.revokeFailed"), variant: "destructive" });
      } finally {
        setBusyGrantId(null);
      }
    },
    [cloudId, replaceAccessGrant, t, toast]
  );

  const handleSyncAndShare = useCallback(async () => {
    setSyncing(true);
    try {
      const assignedCloudId = await syncService.ensureNoteSynced(note.id);
      if (!assignedCloudId) throw new Error("Note sync did not assign a cloud id");
      setSyncedFor({ noteId: note.id, cloudId: assignedCloudId });
    } catch (err) {
      console.error("Note sync for sharing failed:", err);
      toast({ title: t("noteEditor.share.dialog.error.syncFailed"), variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  }, [note.id, t, toast]);

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

        {!cloudId ? (
          <>
            <DialogDescription className="text-xs text-foreground/50">
              {t("noteEditor.share.dialog.syncPrompt")}
            </DialogDescription>
            <Button
              size="sm"
              onClick={() => void handleSyncAndShare()}
              disabled={syncing}
              className="h-8 px-3 text-xs gap-1.5 justify-self-start"
            >
              {syncing && <Loader2 size={12} className="animate-spin" />}
              {t("noteEditor.share.dialog.syncAndShare")}
            </Button>
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
        ) : (
          <>
            <DialogDescription className="sr-only">
              {t("noteEditor.share.dialog.description")}
            </DialogDescription>

            {/* Invite row */}
            <div className="relative">
              <div className="flex items-center gap-2">
                <input
                  ref={emailInputRef}
                  type="text"
                  value={emailInput}
                  onChange={(e) => {
                    setEmailInput(e.target.value);
                    if (inputError) setInputError(null);
                  }}
                  onKeyDown={onKeyDown}
                  placeholder={t("noteEditor.share.dialog.searchPlaceholder")}
                  disabled={loading || submitting || !canManageSharing}
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
                  disabled={loading || submitting || !canManageSharing || !emailInput.trim()}
                  className="h-8 px-3 text-xs gap-1.5"
                >
                  {submitting && <Loader2 size={12} className="animate-spin" />}
                  {t("noteEditor.share.dialog.shareButton")}
                </Button>
              </div>

              {access && emailInput.trim() && (searchingSuggestions || suggestions.length > 0) && (
                <div className="absolute z-20 top-9 left-0 right-[72px] max-h-44 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
                  {searchingSuggestions && suggestions.length === 0 ? (
                    <div className="h-8 flex items-center justify-center">
                      <Loader2 size={12} className="animate-spin text-foreground/40" />
                    </div>
                  ) : (
                    suggestions.map((principal) => (
                      <button
                        key={`${principal.type}:${principal.id ?? principal.email}`}
                        type="button"
                        onClick={() => void handlePrincipalGrant(principal)}
                        className="flex items-center gap-2 w-full min-w-0 px-2 h-9 rounded-md text-left hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
                          <span className="block text-xs text-foreground truncate">
                            {principal.name || principal.email}
                          </span>
                          {principal.name && principal.email && (
                            <span className="block text-[11px] text-foreground/40 truncate">
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

            <p
              id="share-invite-error"
              aria-live="polite"
              className={cn("text-xs text-red-500/90 -mt-1", !inputError && "sr-only")}
            >
              {inputError}
            </p>

            {/* Members list */}
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
                  trailing={
                    <span className="text-[11px] text-foreground/40">
                      {t("noteEditor.share.dialog.owner")}
                    </span>
                  }
                />
              )}

              {(access?.grants ?? []).map((grant) => (
                <AccessGrantRow
                  key={grant.id}
                  grant={grant}
                  canManage={Boolean(
                    access?.can_manage_access &&
                    (!grant.inherited || access.can_manage_inherited_access)
                  )}
                  busy={busyGrantId === grant.id}
                  onPermissionChange={(permission) => void handleGrantPermission(grant, permission)}
                  onRemove={() => void handleRemoveGrant(grant)}
                />
              ))}

              {isTeamNote &&
                space &&
                !(access?.grants ?? []).some(
                  (grant) =>
                    grant.principal.type === "team" && grant.principal.id === space.cloud_team_id
                ) && (
                  <MemberRow
                    leading={<AudienceIcon />}
                    primary={space.name}
                    secondary={t("noteEditor.share.dialog.teamAudience")}
                    trailing={
                      <span className="text-[11px] text-foreground/40">
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
                  secondary={
                    invitation.accepted_at
                      ? t("noteEditor.share.dialog.accepted")
                      : t("noteEditor.share.dialog.pending")
                  }
                  trailing={
                    canManageSharing ? (
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
                          <DropdownMenuItem
                            className="text-xs"
                            disabled={resendingId === invitation.id}
                            onClick={() => void handleResend(invitation)}
                          >
                            {t("noteEditor.share.dialog.resend")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-xs text-red-500"
                            onClick={() => void handleRevoke(invitation)}
                          >
                            {t("noteEditor.share.dialog.revoke")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <span className="text-[11px] text-foreground/40">
                        {t("noteEditor.share.dialog.viewer")}
                      </span>
                    )
                  }
                />
              ))}
            </div>

            {/* Footer: visibility + link */}
            <div className="flex items-center gap-2 pt-3 mt-1 border-t border-border/60">
              <ShareVisibilityMenu
                value={share?.visibility ?? "private"}
                ownerDomain={ownerDomain}
                showDomainOption={showDomainOption}
                disabled={loading || !share || !canManageSharing || savingVisibility || linkBusy}
                onChange={(v) => void applyVisibility(v)}
              />
              <div className="flex-1" />
              <Button
                variant={isPrivate ? "default" : "outline"}
                size="sm"
                className="h-8 px-3 text-xs gap-1.5"
                disabled={loading || !share || !canManageSharing || savingVisibility || linkBusy}
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
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface MemberRowProps {
  leading?: React.ReactNode;
  primary: string;
  secondary: string | null;
  trailing: React.ReactNode;
}

function MemberRow({ leading, primary, secondary, trailing }: MemberRowProps) {
  return (
    <div className="flex items-center gap-2 py-1.5 px-1">
      {leading}
      <div className="flex-1 min-w-0">
        <p className="text-xs text-foreground truncate">{primary}</p>
        {secondary && <p className="text-[11px] text-foreground/40 truncate">{secondary}</p>}
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
  canManage,
  busy,
  onPermissionChange,
  onRemove,
}: {
  grant: NoteAccessGrant;
  canManage: boolean;
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
      trailing={
        canManage ? (
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
              <DropdownMenuItem
                className="text-xs gap-2"
                onClick={() => onPermissionChange("viewer")}
              >
                {grant.permission === "viewer" && <Check size={11} />}
                {t("noteEditor.share.dialog.viewer")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-xs gap-2"
                onClick={() => onPermissionChange("editor")}
              >
                {grant.permission === "editor" && <Check size={11} />}
                {t("noteEditor.share.dialog.editor")}
              </DropdownMenuItem>
              <DropdownMenuItem className="text-xs text-red-500" onClick={onRemove}>
                {t("noteEditor.share.dialog.revoke")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span className="text-[11px] text-foreground/40">{permissionLabel}</span>
        )
      }
    />
  );
}
