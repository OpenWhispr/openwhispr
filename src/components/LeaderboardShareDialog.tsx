import { useCallback, useState } from "react";
import { Check, Download, Loader2, Share2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Leaderboard, LeaderboardMetric } from "../types/electron";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

interface LeaderboardShareDialogProps {
  leaderboard: Leaderboard;
  metric: LeaderboardMetric;
  periodLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function createLeaderboardCard(
  leaderboard: Leaderboard,
  cardTitle: string,
  metricLabel: string,
  periodLabel: string,
  locale: string
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
  context.fillText(cardTitle.toLocaleUpperCase(locale), 72, 74);
  context.fillStyle = "#ffffff";
  context.font = "700 104px Inter, system-ui, sans-serif";
  const rank = leaderboard.viewerRank === null ? "—" : `#${leaderboard.viewerRank}`;
  context.fillText(rank, 72, 300);
  context.fillStyle = "#cbd5e1";
  context.font = "500 30px Inter, system-ui, sans-serif";
  context.fillText(`/ ${new Intl.NumberFormat(locale).format(leaderboard.totalMembers)}`, 76, 350);
  context.font = "400 22px Inter, system-ui, sans-serif";
  context.fillText(`${metricLabel} · ${periodLabel}`, 72, 410);
  context.fillStyle = "#94a3b8";
  context.font = "600 18px Inter, system-ui, sans-serif";
  context.fillText("OpenWhispr", 72, 600);
  return canvas.toDataURL("image/png");
}

export default function LeaderboardShareDialog({
  leaderboard,
  metric,
  periodLabel,
  open,
  onOpenChange,
}: LeaderboardShareDialogProps) {
  const { t, i18n } = useTranslation();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [status, setStatus] = useState<"copied" | "saved" | "failed" | null>(null);

  const image = useCallback(
    () =>
      createLeaderboardCard(
        leaderboard,
        `OpenWhispr ${t("insights.leaderboard.title")}`,
        t(`insights.leaderboard.metrics.${metric}`),
        periodLabel,
        i18n.language
      ),
    [i18n.language, leaderboard, metric, periodLabel, t]
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

  const shareText = t("insights.leaderboard.shareText");
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
            {`OpenWhispr ${t("insights.leaderboard.title")}`.toLocaleUpperCase(i18n.language)}
          </p>
          <p className="mt-1 text-xs text-slate-300">
            {t(`insights.leaderboard.metrics.${metric}`)} · {periodLabel}
          </p>
          <div className="mt-6 rounded-lg bg-white/8 px-4 py-5">
            <strong className="text-3xl">
              {leaderboard.viewerRank === null ? "—" : `#${leaderboard.viewerRank}`}
            </strong>
            <span className="ml-2 text-sm text-slate-300">
              / {new Intl.NumberFormat(i18n.language).format(leaderboard.totalMembers)}
            </span>
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
                  "openwhispr-leaderboard.png"
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
            {busyAction === "x" ? <Loader2 className="animate-spin" /> : <span>X</span>}
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
            role="status"
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
