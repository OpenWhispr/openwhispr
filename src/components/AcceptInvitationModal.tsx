import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { InvitationsService } from "../services/InvitationsService";
import {
  storePendingInvitationToken,
  clearPendingInvitationToken,
} from "../utils/pendingInvitationToken";
import { useAuth } from "../hooks/useAuth";
import { signOut } from "../lib/auth";
import { syncService } from "../services/SyncService.js";
import { afterWorkspaceJoined } from "../services/membershipActions";
import { useToast } from "./ui/useToast";
import SignInDialog from "./SignInDialog";
import type { InvitationPreview } from "../types/electron";

interface Props {
  token: string | null;
  onClose: () => void;
  onAccepted?: (entry: { workspaceId: string; teamIds: string[] }) => void;
}

export default function AcceptInvitationModal({ token, onClose, onAccepted }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { isSignedIn, user } = useAuth();
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);

  useEffect(() => {
    setPreview(null);
    setError(null);
    if (!token) return;
    setLoading(true);
    // Ignore stale resolutions: a slower preview for a previous token must
    // not overwrite the current one, or the modal would describe invitation
    // A while accepting B.
    let cancelled = false;
    InvitationsService.preview(token)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t("common.unknownError"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, t]);

  const wrongAccount =
    isSignedIn &&
    !!preview &&
    !!user?.email &&
    user.email.toLowerCase() !== preview.email.toLowerCase();

  async function handleAccept() {
    if (!token) return;
    if (!isSignedIn) {
      storePendingInvitationToken(token);
      setSignInOpen(true);
      return;
    }
    setAccepting(true);
    try {
      const accepted = await InvitationsService.accept(token);
      clearPendingInvitationToken();
      await afterWorkspaceJoined();
      toast({
        title: t("workspaces.accept.successTitle"),
        description: preview
          ? t("workspaces.accept.successDescription", { name: preview.workspace_name })
          : undefined,
      });
      onClose();
      // Navigate with the accept response, not the preview: the invitation
      // may have been re-targeted since it was previewed, and the server's
      // team_ids are authoritative. The preview only fills in for API
      // responses that predate team_ids.
      onAccepted?.({
        workspaceId: accepted.workspace_id,
        teamIds: accepted.team_ids ?? preview?.team_ids ?? [],
      });
    } catch (err) {
      toast({
        title: t("workspaces.accept.errorTitle"),
        description: err instanceof Error ? err.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setAccepting(false);
    }
  }

  function handleDecline() {
    if (token) clearPendingInvitationToken();
    onClose();
  }

  // Stored token survives the sign-out reload, so the modal resurfaces for
  // the next account. The old account's team content must not leak into the
  // new one (the purge never blocks the switch).
  async function handleSwitchAccount() {
    if (token) storePendingInvitationToken(token);
    await syncService.purgeTeamSpacesForSignOut();
    await signOut();
  }

  return (
    <>
      <Dialog open={!!token} onOpenChange={(open) => !open && handleDecline()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("workspaces.accept.title")}</DialogTitle>
            {preview && (
              <>
                <DialogDescription>
                  {t("workspaces.accept.description", {
                    inviter: preview.inviter_name || preview.inviter_email || "",
                    workspace: preview.workspace_name,
                    role: t(`settingsPage.workspace.role.${preview.workspace_role}`),
                  })}
                </DialogDescription>
                {(preview.team_ids?.length ?? 0) > 0 && (
                  // The preview endpoint returns team ids only, so show a count.
                  <DialogDescription className="text-xs text-muted-foreground/80 mt-1">
                    {t("notes.spaces.invitedTo", { count: preview.team_ids.length })}
                  </DialogDescription>
                )}
                {wrongAccount ? (
                  <DialogDescription className="text-xs text-destructive mt-1">
                    {t("workspaces.accept.wrongAccount", {
                      email: preview.email,
                      current: user?.email,
                    })}
                  </DialogDescription>
                ) : (
                  <DialogDescription className="text-xs text-muted-foreground/80 mt-1">
                    {t("workspaces.accept.sentTo", { email: preview.email })}
                  </DialogDescription>
                )}
              </>
            )}
            {error && <DialogDescription className="text-destructive">{error}</DialogDescription>}
            {loading && (
              <DialogDescription className="flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" />
                {t("workspaces.accept.loading")}
              </DialogDescription>
            )}
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={handleDecline} disabled={accepting}>
              {t("common.cancel")}
            </Button>
            {wrongAccount && (
              <Button variant="outline" onClick={() => void handleSwitchAccount()}>
                {t("workspaces.accept.switchAccount")}
              </Button>
            )}
            <Button
              onClick={handleAccept}
              disabled={loading || !preview || accepting || !!error || wrongAccount}
            >
              {accepting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  {t("workspaces.accept.accepting")}
                </>
              ) : isSignedIn ? (
                t("workspaces.accept.accept")
              ) : (
                t("workspaces.accept.signInToAccept")
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SignInDialog open={signInOpen} onOpenChange={setSignInOpen} />
    </>
  );
}
