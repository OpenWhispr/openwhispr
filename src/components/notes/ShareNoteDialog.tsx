import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Loader2, MoreHorizontal } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { cn } from "../lib/utils";
import ShareVisibilityMenu from "./ShareVisibilityMenu";
import { useAuth } from "../../hooks/useAuth";
import { NoteSharingService } from "../../services/NoteSharingService.js";
import {
  setShareCache,
  updateShareCache,
  useShareCacheEntry,
} from "../../stores/noteStore";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  emailDomain,
  isPersonalEmailDomain,
} from "../../utils/personalEmailDomains";
import type {
  NoteItem,
  NoteShareInvitation,
  ShareSettings,
  ShareVisibility,
} from "../../types/electron";

const SHARE_VIEWER_BASE_URL = "https://notes.openwhispr.com";
const LAST_VISIBILITY_KEY = "openwhispr.shareDefaultVisibility";
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ShareNoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  note: NoteItem;
}

export default function ShareNoteDialog({
  open,
  onOpenChange,
  note,
}: ShareNoteDialogProps) {
  const { user } = useAuth();
  const ownerName: string | null = user?.name ?? null;
  const ownerEmail: string = user?.email ?? "";
  // The desktop has no concept of multi-user workspaces yet — the signed-in
  // user is always the note owner. When workspaces ship, this becomes a
  // server-side flag in the share settings response.
  const isOwner = Boolean(user);
  const { t } = useTranslation();
  const cloudId = note.cloud_id;
  const cached = useShareCacheEntry(cloudId);
  const [defaultVisibility, setDefaultVisibility] = useLocalStorage<ShareVisibility>(
    LAST_VISIBILITY_KEY,
    "invited"
  );

  const [loading, setLoading] = useState(false);
  const [savingVisibility, setSavingVisibility] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const copyTimeoutRef = useRef<number | null>(null);

  const ownerDomain = useMemo(() => emailDomain(ownerEmail), [ownerEmail]);
  const showDomainOption = ownerDomain && !isPersonalEmailDomain(ownerDomain);

  const share = cached?.share ?? null;
  const invitations = cached?.invitations ?? [];

  // Load share state once per open. The dialog is the only place that reads
  // share settings — invalidating on close keeps the cache scoped.
  useEffect(() => {
    if (!open || !cloudId) return;
    let cancelled = false;
    setLoading(true);
    NoteSharingService.getShareSettings(cloudId)
      .then((res) => {
        if (cancelled) return;
        setShareCache(cloudId, {
          share: res.share,
          invitations: res.invitations,
          rawToken: null,
        });
      })
      .catch((err) => {
        if (!cancelled) console.error("Failed to load share settings:", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cloudId]);

  // Apply the user's last-used visibility on first open of a still-private note.
  useEffect(() => {
    if (!open || !cloudId || !share || !isOwner) return;
    if (share.visibility !== "private") return;
    void applyVisibility(defaultVisibility, share);
    // applyVisibility is stable-by-closure; suppressing exhaustive-deps lint
    // would obscure intent. We genuinely only want this on first hit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, share?.visibility]);

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
    return () => {
      if (copyTimeoutRef.current) window.clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const applyVisibility = useCallback(
    async (next: ShareVisibility, current: ShareSettings | null) => {
      if (!cloudId || !current) return;
      if (current.visibility === next) return;
      setSavingVisibility(true);
      const previous = current;
      // Optimistic update so the dropdown feels instant.
      updateShareCache(cloudId, (entry) => ({
        share: {
          ...(entry?.share ?? previous),
          visibility: next,
          domain_allowlist:
            next === "domain" && ownerDomain
              ? entry?.share.domain_allowlist.length
                ? entry.share.domain_allowlist
                : [ownerDomain]
              : entry?.share.domain_allowlist ?? [],
        },
        invitations: entry?.invitations ?? [],
        rawToken: entry?.rawToken ?? null,
      }));
      try {
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
        setDefaultVisibility(next);
      } catch (err) {
        console.error("Failed to update visibility:", err);
        updateShareCache(cloudId, (entry) => ({
          share: previous,
          invitations: entry?.invitations ?? [],
          rawToken: entry?.rawToken ?? null,
        }));
      } finally {
        setSavingVisibility(false);
      }
    },
    [cloudId, ownerDomain, setDefaultVisibility]
  );

  const handleCopyLink = useCallback(async () => {
    if (!cached?.rawToken) {
      setInputError(t("noteEditor.share.dialog.error.linkUnavailable"));
      return;
    }
    const url = `${SHARE_VIEWER_BASE_URL}/n/${encodeURIComponent(cached.rawToken)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (copyTimeoutRef.current) window.clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("Clipboard write failed:", err);
    }
  }, [cached?.rawToken, t]);

  const handleInvite = useCallback(async () => {
    if (!cloudId) return;
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
    } catch (err) {
      console.error("Invite failed:", err);
      setInputError(t("noteEditor.share.dialog.error.inviteFailed"));
    } finally {
      setSubmitting(false);
    }
  }, [cloudId, emailInput, t]);

  const handleRevoke = useCallback(
    async (invitation: NoteShareInvitation) => {
      if (!cloudId) return;
      updateShareCache(cloudId, (entry) => ({
        share: entry?.share ?? share!,
        invitations: (entry?.invitations ?? invitations).filter((i) => i.id !== invitation.id),
        rawToken: entry?.rawToken ?? null,
      }));
      try {
        await NoteSharingService.revokeInvite(cloudId, invitation.id);
      } catch (err) {
        console.error("Revoke failed:", err);
      }
    },
    [cloudId, share, invitations]
  );

  const handleResend = useCallback(
    async (invitation: NoteShareInvitation) => {
      if (!cloudId) return;
      try {
        await NoteSharingService.resendInvite(cloudId, invitation.id);
      } catch (err) {
        console.error("Resend failed:", err);
      }
    },
    [cloudId]
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || (e.metaKey && e.key === "Enter")) {
      e.preventDefault();
      void handleInvite();
    }
  };

  if (!cloudId) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogTitle>{t("noteEditor.share.dialog.title")}</DialogTitle>
          <p className="text-sm text-muted-foreground">
            {t("noteEditor.share.dialog.notSyncedYet")}
          </p>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-3 p-5">
        <DialogTitle className="text-base">{t("noteEditor.share.dialog.title")}</DialogTitle>

        {/* Invite row */}
        <div className="flex items-center gap-2">
          <input
            ref={emailInputRef}
            type="email"
            value={emailInput}
            onChange={(e) => {
              setEmailInput(e.target.value);
              if (inputError) setInputError(null);
            }}
            onKeyDown={onKeyDown}
            placeholder={t("noteEditor.share.dialog.searchPlaceholder")}
            disabled={!isOwner || submitting}
            className={cn(
              "flex-1 h-8 px-2.5 rounded-md text-xs",
              "bg-foreground/4 dark:bg-white/5 text-foreground placeholder:text-foreground/40",
              "border border-transparent",
              "focus:outline-none focus:bg-background dark:focus:bg-surface-1 focus:border-border/60",
              "disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            )}
            aria-label={t("noteEditor.share.dialog.emailLabel")}
          />
          <Button
            size="sm"
            onClick={() => void handleInvite()}
            disabled={!isOwner || submitting || !emailInput.trim()}
            className="h-8 px-3 text-xs"
          >
            {submitting ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              t("noteEditor.share.dialog.shareButton")
            )}
          </Button>
        </div>

        {inputError && (
          <p className="text-xs text-red-500/90 -mt-1">{inputError}</p>
        )}

        {/* Members list */}
        <div className="flex flex-col gap-1.5 mt-1">
          <MemberRow
            primary={ownerName || ownerEmail}
            secondary={ownerEmail}
            trailing={
              <span className="text-[11px] text-foreground/40">
                {t("noteEditor.share.dialog.owner")}
              </span>
            }
          />

          {invitations.map((invitation) => (
            <MemberRow
              key={invitation.id}
              primary={invitation.email}
              secondary={
                invitation.accepted_at
                  ? t("noteEditor.share.dialog.accepted")
                  : t("noteEditor.share.dialog.pending")
              }
              trailing={
                isOwner ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="h-6 w-6 flex items-center justify-center rounded-md hover:bg-foreground/8 dark:hover:bg-white/8 transition-colors"
                        aria-label={t("noteEditor.share.dialog.invitationActions")}
                      >
                        <MoreHorizontal size={13} className="text-foreground/50" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" sideOffset={4}>
                      <DropdownMenuItem
                        className="text-xs"
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
                ) : null
              }
            />
          ))}
        </div>

        {/* Footer: visibility + copy link */}
        <div className="flex items-center gap-2 pt-3 mt-1 border-t border-border/60">
          <ShareVisibilityMenu
            value={(share?.visibility ?? "invited") === "private" ? "invited" : (share?.visibility ?? "invited")}
            ownerDomain={ownerDomain}
            showDomainOption={Boolean(showDomainOption)}
            disabled={!isOwner || loading || savingVisibility}
            onChange={(v) => void applyVisibility(v, share)}
          />
          <div className="flex-1" />
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3 text-xs gap-1.5"
            disabled={!cached?.rawToken || copied}
            onClick={() => void handleCopyLink()}
          >
            {copied ? (
              <>
                <Check size={12} />
                {t("noteEditor.share.dialog.copied")}
              </>
            ) : (
              <>
                <Copy size={12} />
                {t("noteEditor.share.dialog.copyLink")}
              </>
            )}
          </Button>
        </div>

        {!isOwner && (
          <p className="text-[11px] text-foreground/40 -mt-1">
            {t("noteEditor.share.dialog.permissionRequired")}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface MemberRowProps {
  primary: string;
  secondary: string;
  trailing: React.ReactNode;
}

function MemberRow({ primary, secondary, trailing }: MemberRowProps) {
  return (
    <div className="flex items-center gap-2 py-1.5 px-1">
      <div className="flex-1 min-w-0">
        <p className="text-xs text-foreground truncate">{primary}</p>
        <p className="text-[11px] text-foreground/40 truncate">{secondary}</p>
      </div>
      {trailing}
    </div>
  );
}
