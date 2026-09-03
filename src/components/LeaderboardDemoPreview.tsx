import { useState } from "react";
import { useTranslation } from "react-i18next";
import LeaderboardCreateTeamPreview from "./LeaderboardCreateTeamPreview";
import LeaderboardFreePreview from "./LeaderboardFreePreview";
import LeaderboardInvitePreview from "./LeaderboardInvitePreview";
import LeaderboardLockedPreview from "./LeaderboardLockedPreview";
import LeaderboardRequestJoinPreview from "./LeaderboardRequestJoinPreview";

type DemoPreview = "locked" | "free" | "create" | "request" | "requested" | "invite";

const PREVIEWS: DemoPreview[] = ["locked", "free", "create", "request", "requested", "invite"];

export default function LeaderboardDemoPreview({
  onInvite,
  onUpgrade,
}: {
  onInvite: () => void;
  onUpgrade: () => void;
}) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<DemoPreview>("locked");

  return (
    <div className="mt-8" data-leaderboard-demo-preview={preview}>
      <div
        className="ml-auto flex w-fit max-w-full flex-wrap justify-end rounded-lg bg-muted/60 p-0.5"
        aria-label={t("insights.leaderboard.previewScenario")}
      >
        {PREVIEWS.map((value) => (
          <button
            key={value}
            type="button"
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              preview === value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setPreview(value)}
          >
            {t(`insights.leaderboard.${demoLabel(value)}`)}
          </button>
        ))}
      </div>

      {preview === "locked" ? (
        <LeaderboardLockedPreview className="mt-3" onUpgrade={onUpgrade} />
      ) : preview === "free" ? (
        <LeaderboardFreePreview className="mt-3" onUpgrade={onUpgrade} />
      ) : preview === "create" ? (
        <LeaderboardCreateTeamPreview className="mt-3" domain="acme.com" onCreate={onInvite} />
      ) : preview === "request" || preview === "requested" ? (
        <LeaderboardRequestJoinPreview
          className="mt-3"
          workspaceName="Acme"
          pending={preview === "requested"}
          requesting={false}
          onRequest={() => setPreview("requested")}
        />
      ) : (
        <LeaderboardInvitePreview className="mt-3" onInvite={onInvite} />
      )}
    </div>
  );
}

function demoLabel(preview: DemoPreview): string {
  switch (preview) {
    case "locked":
      return "lockedPreview";
    case "free":
      return "freeAccount";
    case "create":
      return "createTeamCta";
    case "request":
      return "requestJoinCta";
    case "requested":
      return "requestSent";
    case "invite":
      return "inviteScenario";
  }
}
