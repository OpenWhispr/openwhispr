import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { useToast } from "./ui/useToast";
import type { InvitationPreview } from "../types/electron";

interface Props {
  token: string | null;
  onClose: () => void;
  isSignedIn: boolean;
  onSignIn: () => void;
}

export default function AcceptInvitationModal({ token, onClose, isSignedIn, onSignIn }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const refresh = useWorkspaceStore((s) => s.refresh);
  const setActive = useWorkspaceStore((s) => s.setActiveWorkspaceId);
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setPreview(null);
      setError(null);
      return;
    }
    setLoading(true);
    InvitationsService.preview(token)
      .then(setPreview)
      .catch((err) => setError(err instanceof Error ? err.message : t("common.unknownError")))
      .finally(() => setLoading(false));
  }, [token, t]);

  async function handleAccept() {
    if (!token) return;
    if (!isSignedIn) {
      storePendingInvitationToken(token);
      onSignIn();
      return;
    }
    setAccepting(true);
    try {
      const result = await InvitationsService.accept(token);
      clearPendingInvitationToken();
      await refresh();
      setActive(result.workspace_id);
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

  return (
    <Dialog open={!!token} onOpenChange={(open) => !open && handleDecline()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("workspaces.accept.title")}</DialogTitle>
          {preview && (
            <DialogDescription>
              {t("workspaces.accept.description", {
                inviter: preview.inviter_name || preview.inviter_email || "",
                workspace: preview.workspace_name,
                role: preview.workspace_role,
              })}
            </DialogDescription>
          )}
          {error && <DialogDescription className="text-destructive">{error}</DialogDescription>}
          {loading && <DialogDescription>{t("workspaces.accept.loading")}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={handleDecline} disabled={accepting}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleAccept} disabled={!preview || accepting || !!error}>
            {accepting
              ? t("workspaces.accept.accepting")
              : isSignedIn
                ? t("workspaces.accept.accept")
                : t("workspaces.accept.signInToAccept")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
