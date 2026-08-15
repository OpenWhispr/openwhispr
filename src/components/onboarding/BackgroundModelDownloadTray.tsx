import { useEffect, useMemo, useState } from "react";
import { CirclePause } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ProviderIcon } from "../ui/ProviderIcon";
import {
  getParakeetModelInfo,
  getWhisperModelInfo,
  modelRegistry,
} from "../../models/ModelRegistry";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  consumePendingLocalModel,
  hasPendingLocalModels,
  type PendingLocalModelKind,
} from "./pendingLocalModels";
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

function downloadDisplay(download: ActiveDownload) {
  if (download.kind === "whisper") {
    return { name: getWhisperModelInfo(download.id)?.name ?? download.id, provider: "openai" };
  }
  if (download.kind === "parakeet") {
    return { name: getParakeetModelInfo(download.id)?.name ?? download.id, provider: "nvidia" };
  }
  const localModel = modelRegistry.getModel(download.id);
  return {
    name: localModel?.model.name ?? download.id,
    provider: localModel?.provider.id ?? "local",
  };
}

function activatePendingLocalModel(kind: PendingLocalModelKind, modelId: string) {
  if (localStorage.getItem("localSetupPending") !== "true") return;
  const selection = consumePendingLocalModel(kind, modelId);
  if (!selection) return;

  const store = useSettingsStore.getState();
  if (kind === "dictation") {
    if (selection.provider === "nvidia") {
      store.setLocalTranscriptionProvider("nvidia");
      store.setParakeetModel(selection.modelId);
    } else {
      store.setLocalTranscriptionProvider("whisper");
      store.setWhisperModel(selection.modelId);
    }
    store.setCloudTranscriptionForAllScopes({ useLocalWhisper: true });
    return;
  }

  store.setChatAgentMode("local");
  store.setChatAgentProvider(selection.provider);
  store.setChatAgentModel(selection.modelId);
  store.setCloudReasoningForAllScopes({
    cleanupCloudMode: "local",
    cleanupProvider: selection.provider,
    cleanupModel: selection.modelId,
    useCleanupModel: true,
    useDictationAgent: true,
  });
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
      if (data.type === "complete") activatePendingLocalModel("dictation", data.model);
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
      if (data.type === "complete") activatePendingLocalModel("assistant", data.modelId);
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
    if (hydrated && activeDownloads.length === 0 && !hasPendingLocalModels()) {
      localStorage.removeItem("localSetupPending");
    }
  }, [activeDownloads.length, hydrated]);

  if (activeDownloads.length === 0) return null;

  return (
    <aside
      className="fixed right-7 top-5 z-50 w-[14.5rem] overflow-hidden rounded-xl border border-neutral-200 bg-white text-neutral-950 shadow-sm"
      aria-label={t("onboarding.rehaul.local.downloads")}
      aria-live="polite"
    >
      <div className="flex h-8 items-center gap-1.5 bg-neutral-100 px-2.5 text-xs text-neutral-500">
        <CirclePause className="size-3.5 text-blue-500" />
        {t("onboarding.rehaul.local.downloadInProgress")}
      </div>
      {activeDownloads.map((download) => (
        <div
          key={downloadKey(download.kind, download.id)}
          className="border-t border-neutral-200 p-2.5"
        >
          <div className="flex items-center gap-2 text-xs">
            <ProviderIcon
              provider={downloadDisplay(download).provider}
              className="size-3.5"
              forceLight
              monochrome={downloadDisplay(download).provider === "qwen"}
            />
            <span className="min-w-0 flex-1 truncate font-medium">
              {downloadDisplay(download).name}
            </span>
            <span className="text-neutral-500">{Math.round(download.percentage)}%</span>
          </div>
          {download.error ? (
            <p className="mt-1 truncate text-[0.625rem] text-destructive">{download.error}</p>
          ) : (
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-neutral-100">
              <div
                className="h-full rounded-full bg-blue-500 transition-[width] motion-reduce:transition-none"
                style={{ width: `${download.percentage}%` }}
              />
            </div>
          )}
        </div>
      ))}
    </aside>
  );
}
