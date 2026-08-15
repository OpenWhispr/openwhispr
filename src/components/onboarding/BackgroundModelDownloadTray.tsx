import { useEffect, useMemo, useState } from "react";
import { Download, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Progress } from "../ui/progress";
import type {
  LocalLLMDownloadProgressEvent,
  ParakeetDownloadProgressData,
  WhisperDownloadProgressData,
} from "../../types/electron";

type DownloadKind = "whisper" | "parakeet" | "llm";

interface ActiveDownload {
  id: string;
  kind: DownloadKind;
  percentage: number;
  installing?: boolean;
  error?: string;
}

function downloadKey(kind: DownloadKind, id: string) {
  return `${kind}:${id}`;
}

function clampPercentage(value: number | undefined) {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? (value ?? 0) : 0));
}

export default function BackgroundModelDownloadTray() {
  const { t } = useTranslation();
  const [downloads, setDownloads] = useState<Record<string, ActiveDownload>>({});
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const hydrate = async () => {
      const [whisper, parakeet, llm] = await Promise.all([
        window.electronAPI?.listWhisperModels?.().catch(() => undefined),
        window.electronAPI?.listParakeetModels?.().catch(() => undefined),
        window.electronAPI?.modelGetAll?.().catch(() => undefined),
      ]);
      if (cancelled) return;

      const active: Record<string, ActiveDownload> = {};
      for (const model of whisper?.models ?? []) {
        if (!model.isDownloading) continue;
        active[downloadKey("whisper", model.model)] = {
          id: model.model,
          kind: "whisper",
          percentage: clampPercentage(model.downloadProgress),
          installing: model.isInstalling,
        };
      }
      for (const model of parakeet?.models ?? []) {
        if (!model.isDownloading) continue;
        active[downloadKey("parakeet", model.model)] = {
          id: model.model,
          kind: "parakeet",
          percentage: clampPercentage(model.downloadProgress),
          installing: model.isInstalling,
        };
      }
      for (const model of llm ?? []) {
        if (!model.isDownloading) continue;
        active[downloadKey("llm", model.id)] = {
          id: model.id,
          kind: "llm",
          percentage: clampPercentage(model.downloadProgress),
        };
      }
      setDownloads((current) => ({ ...active, ...current }));
      setHydrated(true);
    };

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const updateTranscription = (
      kind: Exclude<DownloadKind, "llm">,
      data: WhisperDownloadProgressData | ParakeetDownloadProgressData
    ) => {
      const key = downloadKey(kind, data.model);
      setDownloads((current) => {
        if (data.type === "complete") {
          const next = { ...current };
          delete next[key];
          return next;
        }
        return {
          ...current,
          [key]: {
            id: data.model,
            kind,
            percentage: clampPercentage(data.percentage),
            installing: data.type === "installing",
            error: data.type === "error" ? data.error : undefined,
          },
        };
      });
    };

    const updateLlm = (_event: unknown, data: LocalLLMDownloadProgressEvent) => {
      const key = downloadKey("llm", data.modelId);
      setDownloads((current) => {
        if (data.type === "complete") {
          const next = { ...current };
          delete next[key];
          return next;
        }
        return {
          ...current,
          [key]: {
            id: data.modelId,
            kind: "llm",
            percentage: clampPercentage(data.type === "error" ? 0 : data.progress),
            error: data.type === "error" ? data.error : undefined,
          },
        };
      });
    };

    const disposeWhisper = window.electronAPI?.onWhisperDownloadProgress?.((_event, data) =>
      updateTranscription("whisper", data)
    );
    const disposeParakeet = window.electronAPI?.onParakeetDownloadProgress?.((_event, data) =>
      updateTranscription("parakeet", data)
    );
    const disposeLlm = window.electronAPI?.onModelDownloadProgress?.(updateLlm);

    return () => {
      disposeWhisper?.();
      disposeParakeet?.();
      disposeLlm?.();
    };
  }, []);

  const activeDownloads = useMemo(() => Object.values(downloads), [downloads]);

  useEffect(() => {
    if (hydrated && activeDownloads.length === 0) {
      localStorage.removeItem("localSetupPending");
    }
  }, [activeDownloads.length, hydrated]);

  const cancelDownload = async (download: ActiveDownload) => {
    if (download.kind === "whisper") await window.electronAPI?.cancelWhisperDownload?.();
    else if (download.kind === "parakeet") await window.electronAPI?.cancelParakeetDownload?.();
    else await window.electronAPI?.modelCancelDownload?.(download.id);
  };

  if (activeDownloads.length === 0) return null;

  return (
    <aside
      className="fixed right-5 top-12 z-50 w-[min(22rem,calc(100vw-2.5rem))] space-y-2"
      aria-label={t("onboarding.rehaul.local.downloads")}
      aria-live="polite"
    >
      {activeDownloads.map((download) => (
        <div
          key={downloadKey(download.kind, download.id)}
          className="rounded-2xl border border-border bg-card/95 p-4 shadow-xl backdrop-blur"
        >
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              {download.installing ? (
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <Download className="size-4" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">{download.id}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {download.error
                  ? download.error
                  : download.installing
                    ? t("onboarding.rehaul.local.installing")
                    : t("onboarding.rehaul.local.downloading", {
                        progress: Math.round(download.percentage),
                      })}
              </p>
              {!download.error && <Progress value={download.percentage} className="mt-3 h-1.5" />}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 rounded-full"
              aria-label={t("common.cancel")}
              onClick={() => void cancelDownload(download)}
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>
      ))}
    </aside>
  );
}
