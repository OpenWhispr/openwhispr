import { Building2, Loader2 } from "./icons";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";

export default function LeaderboardWorkspaceNudge({
  kind,
  loading,
  onAction,
  pending,
  workspaceName,
}: {
  kind: "accept_invite" | "request_join";
  loading: boolean;
  onAction: () => void;
  pending: boolean;
  workspaceName: string;
}) {
  const { t } = useTranslation();
  const acceptingInvitation = kind === "accept_invite";
  const actionLabel = loading
    ? t(acceptingInvitation ? "insights.leaderboard.joining" : "insights.leaderboard.requesting")
    : acceptingInvitation
      ? t("insights.leaderboard.acceptInviteCta")
      : t(pending ? "insights.leaderboard.requestSent" : "insights.leaderboard.requestJoinCta");

  return (
    <div
      data-leaderboard-state="workspace_nudge"
      className="flex flex-wrap items-center justify-between gap-3 border-b border-border/40 bg-primary/5 px-5 py-3"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Building2 size={15} />
        </div>
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-foreground">
            {t(
              acceptingInvitation
                ? "insights.leaderboard.acceptInviteTitle"
                : "insights.leaderboard.requestJoinTitle",
              { workspace: workspaceName }
            )}
          </p>
          {!acceptingInvitation && (
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{workspaceName}</p>
          )}
        </div>
      </div>
      <Button variant="outline-flat" size="sm" disabled={loading || pending} onClick={onAction}>
        {loading && <Loader2 size={14} className="animate-spin" />}
        {actionLabel}
      </Button>
    </div>
  );
}
