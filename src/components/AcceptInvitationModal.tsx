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
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useAuth } from "../hooks/useAuth";
import { signOut } from "../lib/auth";
import { syncService } from "../services/SyncService.js";
import { useToast } from "./ui/useToast";
import SignInDialog from "./SignInDialog";
import type { InvitationPreview } from "../types/electron";

interface Props {
  token: string | null;
  onClose: () => void;
}

export default function AcceptInvitationModal({ token, onClose }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { isSignedIn, user } = useAuth();
  const refresh = useWorkspaceStore((s) => s.refresh);
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
    InvitationsService.preview(token)
      .then(setPreview)
      .catch((err) => setError(err instanceof Error ? err.message : t("common.unknownError")))
      .finally(() => setLoading(false));
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
      await InvitationsService.accept(token);
      clearPendingInvitationToken();
      await refresh();
      toast({
        title: t("workspaces.accept.successTitle"),
        description: preview
          ? t("workspaces.accept.successDescription", { name: preview.workspace_name })
          : undefined,
      });
      onClose();
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
