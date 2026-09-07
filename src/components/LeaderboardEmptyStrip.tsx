import { Check, Copy, Users } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { useToast } from "./ui/useToast";

export default function LeaderboardEmptyStrip({ missingCount }: { missingCount: number }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const copyNudge = async () => {
    try {
      const result = await window.electronAPI.writeClipboard(t("insights.leaderboard.nudgeText"));
      if (!result.success) throw new Error("Clipboard write failed");
      setCopied(true);
      toast({ title: t("insights.leaderboard.nudgeCopied") });
    } catch (error) {
      console.error("Copying leaderboard nudge failed:", error);
      toast({ title: t("insights.leaderboard.nudgeCopyError"), variant: "destructive" });
    }
  };

  return (
    <div
      data-leaderboard-state="empty_strip"
      className="flex flex-wrap items-center justify-between gap-3 border-b border-border/40 bg-primary/5 px-5 py-3"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Users size={15} />
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("insights.leaderboard.emptyStrip", { count: missingCount })}
        </p>
      </div>
      <Button variant="outline-flat" size="sm" onClick={() => void copyNudge()}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? t("insights.leaderboard.nudgeCopied") : t("insights.leaderboard.copyNudge")}
      </Button>
    </div>
  );
}
