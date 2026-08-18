import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { useToast } from "./ui/useToast";
import MemberAvatar from "./MemberAvatar";
import { WorkspacesService } from "../services/WorkspacesService";
import { afterWorkspaceJoined } from "../services/membershipActions";
import { cn } from "./lib/utils";
import type { JoinableWorkspace } from "../types/electron";

interface Props {
  joinable: JoinableWorkspace[];
  /** Domain the matches were found on, for the headline. */
  domain: string | null;
  onDismiss: () => void;
  onRequested: (workspaceId: string) => void;
  onJoined?: (entry: { workspaceId: string }) => void;
}

function workspaceMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0][0]}${words[1][0]}` : name.slice(0, 2);
  return letters.toUpperCase();
}

/**
 * Post-signup catch for teammates who install the app and sign up directly
 * instead of clicking the link in their invitation email — previously they
 * landed in a personal workspace with no way back to their team.
 */
export default function JoinYourTeamModal({
  joinable,
  domain,
  onDismiss,
  onRequested,
  onJoined,
}: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function handleJoin(entry: JoinableWorkspace) {
    setBusyId(entry.workspace_id);
    try {
      await WorkspacesService.join(entry.workspace_id);
      await afterWorkspaceJoined();
      toast({
        title: t("workspaces.join.successTitle"),
        description: t("workspaces.join.successDescription", { workspace: entry.workspace_name }),
      });
      onDismiss();
      onJoined?.({ workspaceId: entry.workspace_id });
    } catch (error) {
      toast({
        title: t("workspaces.join.errorTitle"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  }

  async function handleRequest(entry: JoinableWorkspace) {
    setBusyId(entry.workspace_id);
    try {
      await WorkspacesService.requestJoin(entry.workspace_id);
      // Flip this row to "Requested" in place rather than closing: with several
      // matches the user may well want to ask more than one.
      onRequested(entry.workspace_id);
      toast({
        title: t("workspaces.join.requestedTitle"),
        description: t("workspaces.join.requestedDescription", {
          workspace: entry.workspace_name,
        }),
      });
    } catch (error) {
      toast({
        title: t("workspaces.join.requestErrorTitle"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  }

  const invited = joinable.some((entry) => entry.source === "invitation");

  return (
    <Dialog open={joinable.length > 0} onOpenChange={(open) => !open && onDismiss()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {invited || !domain
              ? t("workspaces.join.title")
              : t("workspaces.join.domainTitle", { domain })}
          </DialogTitle>
          <DialogDescription>
            {invited ? t("workspaces.join.invitedDescription") : t("workspaces.join.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          {joinable.map((entry) => {
            const pending = entry.request_state === "pending";
            const busy = busyId === entry.workspace_id;
            return (
              <div
                key={entry.workspace_id}
                className="flex items-center gap-3 rounded-md border border-border/50 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 px-3 py-2.5"
              >
                <span className="w-8 h-8 shrink-0 rounded-md bg-primary/10 text-primary text-[11px] font-semibold flex items-center justify-center">
                  {workspaceMonogram(entry.workspace_name)}
                </span>

                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-foreground truncate">
                    {entry.workspace_name}
                  </p>
                  <div className="flex items-center gap-1.5 mt-1">
                    {entry.members.length > 0 && (
                      <div className="flex -space-x-1.5">
                        {entry.members.map((member) => (
                          <span
                            key={member.email}
                            className="ring-1 ring-card dark:ring-surface-2 rounded-full"
                          >
                            <MemberAvatar
                              name={member.name}
                              email={member.email}
                              image={member.image}
                              size="sm"
                            />
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="text-[11px] text-muted-foreground truncate">
                      {entry.source === "invitation"
                        ? t("workspaces.join.invitedBy", {
                            inviter: entry.inviter_name || entry.inviter_email || "",
                            role: t(`settingsPage.workspace.role.${entry.role}`),
                          })
                        : t("workspaces.join.memberCount", { count: entry.member_count })}
                    </p>
                  </div>
                </div>

                {pending ? (
                  <span
                    className={cn(
                      "shrink-0 inline-flex items-center gap-1 h-7 px-2 rounded-md",
                      "text-[11px] font-medium text-muted-foreground bg-foreground/5"
                    )}
                  >
                    <Check className="h-3 w-3" />
                    {t("workspaces.join.requested")}
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant={entry.mode === "join" ? "default" : "outline"}
                    className="shrink-0"
                    onClick={() =>
                      void (entry.mode === "join" ? handleJoin(entry) : handleRequest(entry))
                    }
                    disabled={busyId !== null}
                  >
                    {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                    {entry.mode === "join"
                      ? t("workspaces.join.join")
                      : t("workspaces.join.request")}
                  </Button>
                )}
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onDismiss} disabled={busyId !== null}>
            {t("workspaces.join.notNow")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
