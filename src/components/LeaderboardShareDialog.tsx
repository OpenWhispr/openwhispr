import { useCallback, useState } from "react";
import { Check, Download, Loader2, Share2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Leaderboard, LeaderboardMember, LeaderboardMetric } from "../types/electron";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

interface LeaderboardShareDialogProps {
  leaderboard: Leaderboard;
  metric: LeaderboardMetric;
  periodLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function memberValue(member: LeaderboardMember, metric: LeaderboardMetric): number | null {
  switch (metric) {
    case "words_per_minute":
      return member.averageWpm;
    case "current_daily_streak":
      return member.currentStreakDays;
    case "desktop_words":
      return member.desktopWords;
    case "mobile_words":
      return member.mobileWords;
    case "total_words":
      return member.totalWords;
  }
}

// The card is built to leave the app, so it never carries a full address: an
// unnamed member is shown by the local part alone, as elsewhere in the UI.
function shareName(member: LeaderboardMember): string {
  return member.name || member.email.split("@")[0];
}

function drawRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fill();
}

function createLeaderboardCard(
  leaderboard: Leaderboard,
  metric: LeaderboardMetric,
  metricLabel: string,
  periodLabel: string
): string {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 630;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");

  const gradient = context.createLinearGradient(0, 0, 1200, 630);
  gradient.addColorStop(0, "#111827");
  gradient.addColorStop(0.55, "#172554");
  gradient.addColorStop(1, "#312e81");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 1200, 630);

  context.fillStyle = "rgba(255,255,255,0.07)";
  context.beginPath();
  context.arc(1080, 40, 260, 0, Math.PI * 2);
  context.fill();
  context.beginPath();
  context.arc(80, 650, 230, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = "#a5b4fc";
  context.font = "600 24px Inter, system-ui, sans-serif";
  context.fillText("OPENWHISPR LEADERBOARD", 72, 74);
  context.fillStyle = "#ffffff";
  context.font = "700 50px Inter, system-ui, sans-serif";
  context.fillText(leaderboard.scope.name.slice(0, 34), 72, 135);
  context.fillStyle = "#cbd5e1";
  context.font = "400 22px Inter, system-ui, sans-serif";
  context.fillText(`${metricLabel} · ${periodLabel}`, 72, 174);

  const topMembers = leaderboard.leaders;
  topMembers.forEach((member, index) => {
    const y = 210 + index * 72;
    context.fillStyle = index === 0 ? "rgba(99,102,241,0.42)" : "rgba(255,255,255,0.08)";
    drawRoundedRect(context, 72, y, 1056, 56, 16);
    context.fillStyle = index === 0 ? "#fef3c7" : "#e2e8f0";
    context.font = "700 22px Inter, system-ui, sans-serif";
    context.fillText(`#${member.rank}`, 94, y + 36);
    context.fillStyle = "#ffffff";
    context.font = "600 22px Inter, system-ui, sans-serif";
    context.fillText(shareName(member).slice(0, 38), 180, y + 36);
    context.textAlign = "right";
    context.font = "700 24px Inter, system-ui, sans-serif";
    const value = memberValue(member, metric);
    context.fillText(value == null ? "—" : new Intl.NumberFormat().format(value), 1100, y + 36);
    context.textAlign = "left";
  });

  context.fillStyle = "#94a3b8";
  context.font = "500 18px Inter, system-ui, sans-serif";
  context.fillText("Made with OpenWhispr", 72, 600);
  return canvas.toDataURL("image/png");
}

export default function LeaderboardShareDialog({
  leaderboard,
  metric,
  periodLabel,
  open,
  onOpenChange,
}: LeaderboardShareDialogProps) {
  const { t } = useTranslation();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [status, setStatus] = useState<"copied" | "saved" | "failed" | null>(null);

  const image = useCallback(
    () =>
      createLeaderboardCard(
        leaderboard,
        metric,
        t(`insights.leaderboard.metrics.${metric}`),
        periodLabel
      ),
    [leaderboard, metric, periodLabel, t]
  );

  const copyImage = useCallback(async () => {
    const result = await window.electronAPI.copyLeaderboardImage(image());
    if (!result.success) throw new Error(result.error || "Copy failed");
    setStatus("copied");
  }, [image]);

  const run = useCallback(async (action: string, operation: () => Promise<void>) => {
    setBusyAction(action);
    setStatus(null);
    try {
      await operation();
    } catch (error) {
      console.error("Sharing leaderboard failed:", error);
      setStatus("failed");
    } finally {
      setBusyAction(null);
    }
  }, []);

  const shareText = t("insights.leaderboard.shareText", {
    workspace: leaderboard.scope.name,
  });
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) setStatus(null);
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("insights.leaderboard.shareTitle")}</DialogTitle>
          <DialogDescription>{t("insights.leaderboard.shareDescription")}</DialogDescription>
        </DialogHeader>

        <div className="rounded-xl bg-gradient-to-br from-slate-950 via-blue-950 to-indigo-900 p-5 text-white">
          <p className="text-[10px] font-semibold tracking-[0.18em] text-indigo-200">
            OPENWHISPR LEADERBOARD
          </p>
          <p className="mt-1 text-xl font-semibold">{leaderboard.scope.name}</p>
          <p className="mt-1 text-xs text-slate-300">
            {t(`insights.leaderboard.metrics.${metric}`)} · {periodLabel}
          </p>
          <div className="mt-4 space-y-1.5">
            {leaderboard.leaders.slice(0, 3).map((member) => (
              <div
                key={member.userId}
                className="flex items-center justify-between rounded-lg bg-white/8 px-3 py-2 text-sm"
              >
                <span className="truncate">
                  <strong className="mr-3 text-indigo-200">#{member.rank}</strong>
                  {shareName(member)}
                </span>
                <strong className="ml-3">
                  {memberValue(member, metric) == null
                    ? "—"
                    : new Intl.NumberFormat().format(memberValue(member, metric) ?? 0)}
                </strong>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            disabled={busyAction !== null}
            onClick={() => void run("copy", copyImage)}
          >
            {busyAction === "copy" ? <Loader2 className="animate-spin" /> : <Share2 />}
            {t("insights.leaderboard.copyImage")}
          </Button>
          <Button
            variant="outline"
            disabled={busyAction !== null}
            onClick={() =>
              void run("download", async () => {
                const result = await window.electronAPI.saveLeaderboardImage(
                  image(),
                  `${leaderboard.scope.name}-leaderboard.png`
                );
                if (!result.success) throw new Error(result.error || "Save failed");
                if (!result.canceled) setStatus("saved");
              })
            }
          >
            {busyAction === "download" ? <Loader2 className="animate-spin" /> : <Download />}
            {t("insights.leaderboard.download")}
          </Button>
          <Button
            variant="outline"
            disabled={busyAction !== null}
            onClick={() =>
              void run("x", async () => {
                await copyImage();
                const opened = await window.electronAPI.openExternal(
                  `https://x.com/intent/post?text=${encodeURIComponent(shareText)}`
                );
                if (!opened.success) throw new Error(opened.error || "Opening X failed");
              })
            }
          >
            {busyAction === "x" ? <Loader2 className="animate-spin" /> : <span>𝕏</span>}
            {t("insights.leaderboard.shareX")}
          </Button>
          <Button
            variant="outline"
            disabled={busyAction !== null}
            onClick={() =>
              void run("linkedin", async () => {
                await copyImage();
                const opened = await window.electronAPI.openExternal(
                  "https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fopenwhispr.com"
                );
                if (!opened.success) throw new Error(opened.error || "Opening LinkedIn failed");
              })
            }
          >
            {busyAction === "linkedin" ? (
              <Loader2 className="animate-spin" />
            ) : (
              <span className="font-bold">in</span>
            )}
            {t("insights.leaderboard.shareLinkedIn")}
          </Button>
        </div>
        {status && (
          <p
            className={
              status === "failed"
                ? "text-center text-xs text-destructive"
                : "flex items-center justify-center gap-1 text-xs text-emerald-600"
            }
          >
            {status !== "failed" && <Check size={13} />}
            {t(`insights.leaderboard.${status}`)}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
