import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Cpu, Check, Download, Loader2 } from "lucide-react";
import { Button } from "../ui/button";
import { getLocalModel, BUILTIN_LOCAL_MODEL_ID } from "../../models/ModelRegistry";
import { useModelAutoDownloadStore } from "../../stores/modelAutoDownloadStore";

const GEMMA_MODEL_ID = BUILTIN_LOCAL_MODEL_ID;

/**
 * Built-in local model card shown for the "local" inference mode. Replaces the
 * full provider/model picker with a single card for the bundled Gemma model:
 * shows name + size, live download status (pulling progress from the shared
 * auto-download store), and a Download button when the model is absent.
 */
export default function GemmaModelCard() {
  const { t } = useTranslation();
  const model = getLocalModel(GEMMA_MODEL_ID);
  const modelName = model?.name ?? "Gemma 4 E4B";
  const modelSize = model?.size ?? "5.4GB";

  const [isDownloaded, setIsDownloaded] = useState(false);
  const [checked, setChecked] = useState(false);

  const auto = useModelAutoDownloadStore(
    useShallow((s) => ({
      isActive: s.isActive,
      modelId: s.modelId,
      percentage: s.progress.percentage,
      isComplete: s.isComplete,
      error: s.error,
    }))
  );

  const isThisModel = auto.modelId === GEMMA_MODEL_ID;
  const isDownloading = isThisModel && auto.isActive;
  // The auto-download store is single-slot: block starting Gemma while ANY
  // model (e.g. Parakeet on first launch) is downloading, or their progress
  // and cancel routing would collide.
  const anotherDownloadActive = auto.isActive && !isThisModel;

  // Initial + on-complete status check.
  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      ?.modelCheck?.(GEMMA_MODEL_ID)
      .then((downloaded) => {
        if (cancelled) return;
        setIsDownloaded(!!downloaded);
        setChecked(true);
      })
      .catch(() => {
        if (!cancelled) setChecked(true);
      });
    return () => {
      cancelled = true;
    };
    // Re-check when this model's download completes.
  }, [isThisModel, auto.isComplete]);

  const handleDownload = () => {
    window.electronAPI?.downloadGemmaBuiltin?.();
  };

  const statusNode = () => {
    if (isDownloading) {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 size={13} className="animate-spin" />
          {t("settingsPage.aiModels.gemmaCard.downloading", {
            percentage: Math.round(auto.percentage),
          })}
        </span>
      );
    }
    if (isDownloaded) {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
          <Check size={13} />
          {t("settingsPage.aiModels.gemmaCard.ready")}
        </span>
      );
    }
    if (isThisModel && auto.error) {
      return (
        <span className="text-xs text-destructive">
          {t("settingsPage.aiModels.gemmaCard.error")}
        </span>
      );
    }
    return (
      <span className="text-xs text-muted-foreground">
        {t("settingsPage.aiModels.gemmaCard.notDownloaded")}
      </span>
    );
  };

  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4">
      <div className="flex items-center gap-3">
        <div className="shrink-0 w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
          <Cpu size={18} className="text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground truncate">{modelName}</span>
            <span className="text-xs text-muted-foreground">{modelSize}</span>
          </div>
          <div className="mt-0.5">{checked || isDownloading ? statusNode() : null}</div>
        </div>
        {!isDownloaded && !isDownloading && (
          <Button
            size="sm"
            onClick={handleDownload}
            disabled={anotherDownloadActive}
            className="text-xs shrink-0"
          >
            <Download size={13} className="mr-1" />
            {t("settingsPage.aiModels.gemmaCard.download")}
          </Button>
        )}
      </div>
      {isDownloading && (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-border">
          <div
            className="h-full rounded-full bg-primary transition-all duration-200"
            style={{ width: `${Math.min(100, Math.max(0, auto.percentage))}%` }}
          />
        </div>
      )}
    </div>
  );
}
