import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ProviderIcon } from "../ui/ProviderIcon";
import { BrandMark } from "./OnboardingShell";
import {
  getParakeetModelInfo,
  getWhisperModelInfo,
  modelRegistry,
} from "../../models/ModelRegistry";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  consumePendingLocalModel,
  forgetPendingLocalModel,
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

// The X on each row (Figma "Frame 25"), inlined rather than drawn with lucide so
// the 8px glyph inside the 24px circle and the 1.333 stroke come out exactly as
// exported instead of needing to be back-scaled out of lucide's 24 viewBox.
function CancelGlyph() {
  return (
    <svg width={24} height={24} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect width={24} height={24} rx={12} fill="var(--onboarding-surface-secondary,#f7f7f7)" />
      <path
        d="M16 8L8 16"
        stroke="#8C7575"
        strokeWidth={1.33333}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 8L16 16"
        stroke="#8C7575"
        strokeWidth={1.33333}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function BackgroundModelDownloadTray() {
  const { t } = useTranslation();
  const [downloads, setDownloads] = useState<Record<string, ActiveDownload>>({});
  const [hydrated, setHydrated] = useState(false);
  // Aborting a download makes the underlying transfer reject, which arrives here
  // as an error-type progress event. After an explicit cancel that error is noise,
  // so swallow exactly one per cancelled key. Any non-error event for the key
  // means a fresh download started, which clears the suppression.
  const cancelledKeys = useRef<Set<string>>(new Set());

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
      if (data.type === "error" && cancelledKeys.current.delete(key)) return;
      if (data.type !== "error") cancelledKeys.current.delete(key);
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
      if (data.type === "error" && cancelledKeys.current.delete(key)) return;
      if (data.type !== "error") cancelledKeys.current.delete(key);
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

  const cancelDownload = useCallback(async (download: ActiveDownload) => {
    const key = downloadKey(download.kind, download.id);
    cancelledKeys.current.add(key);
    // Drop the row on click rather than waiting for the main process: the cancel
    // handlers resolve after the transfer unwinds, and a row that lingers reads as
    // a click that did nothing.
    setDownloads((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    // Otherwise a half-downloaded model stays queued and activatePendingLocalModel
    // would select it the moment any later download of the same kind completes.
    forgetPendingLocalModel(download.kind === "llm" ? "assistant" : "dictation", download.id);

    const result =
      download.kind === "whisper"
        ? await window.electronAPI?.cancelWhisperDownload?.()
        : download.kind === "parakeet"
          ? await window.electronAPI?.cancelParakeetDownload?.()
          : await window.electronAPI?.modelCancelDownload?.(download.id);

    // The main process can refuse: Parakeet returns INSTALLATION_IN_PROGRESS once
    // extraction starts, and modelManagerBridge returns false when the request has
    // already gone. Put the row back rather than leaving the user believing a
    // download that is still running was stopped.
    if (result?.success === false) {
      cancelledKeys.current.delete(key);
      setDownloads((current) => ({ ...current, [key]: download }));
    }
  }, []);

  const activeDownloads = useMemo(() => Object.values(downloads), [downloads]);

  useEffect(() => {
    if (hydrated && activeDownloads.length === 0 && !hasPendingLocalModels()) {
      localStorage.removeItem("localSetupPending");
    }
  }, [activeDownloads.length, hydrated]);

  if (activeDownloads.length === 0) return null;

  return (
    // Figma "Onboarding / Frame 2147259036": 341 wide, radius 12, #E3E3E3
    // stroke, no shadow. Colours are var(token, literal) because the tray also
    // shows over the control panel: index.css hands the --onboarding-* tokens to
    // body:has(.onboarding-canvas), so they resolve during onboarding and the
    // literals cover the panel, where the tokens are not defined.
    <aside
      className="fixed right-7 top-5 z-50 w-[341px] overflow-hidden rounded-[12px] border border-[var(--onboarding-control-border,#e3e3e3)] bg-white text-black"
      aria-label={t("onboarding.rehaul.local.downloads")}
      aria-live="polite"
    >
      {/* Frame 2147259037: #F7F7F7 strip, 7/8 padding, gap 5, 12/140% label. */}
      <div className="flex items-center gap-[5px] bg-[var(--onboarding-surface-secondary,#f7f7f7)] px-2 py-[7px] text-xs leading-[1.4] text-[var(--onboarding-text-secondary,#656565)]">
        <BrandMark className="size-[11.2px] shrink-0 text-[var(--onboarding-accent,#4079ed)]" />
        {t("onboarding.rehaul.local.downloadInProgress")}
      </div>
      {activeDownloads.map((download, index) => (
        // Frame 2147258983: a row of 8/10 padding and gap 10, holding the growing
        // Frame 17 column and the cancel control. Only the rows after the first
        // carry a hairline — the header strip separates the first one.
        <div
          key={downloadKey(download.kind, download.id)}
          className={`flex items-center gap-2.5 px-2.5 py-2 ${
            index === 0 ? "" : "border-t border-[var(--onboarding-control-border,#e3e3e3)]"
          }`}
        >
          {/* Frame 17: fills the row, col gap 8. */}
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-center justify-between gap-2 text-xs leading-[1.4]">
              <span className="flex min-w-0 items-center gap-[7px]">
                <ProviderIcon
                  provider={downloadDisplay(download).provider}
                  className="size-[14.55px] shrink-0"
                  forceLight
                  monochrome={downloadDisplay(download).provider === "qwen"}
                />
                <span className="min-w-0 truncate font-medium">
                  {downloadDisplay(download).name}
                </span>
              </span>
              <span className="shrink-0 font-medium text-[var(--onboarding-text-tertiary,#969393)]">
                {Math.round(download.percentage)}%
              </span>
            </div>
            {download.error ? (
              <p className="truncate text-[0.625rem] text-destructive">{download.error}</p>
            ) : (
              // Frame 2147259038: 12 tall track on #F7F7F7 at radius 9, brand fill
              // at radius 11.
              <div className="h-3 overflow-hidden rounded-[9px] bg-[var(--onboarding-surface-secondary,#f7f7f7)]">
                <div
                  className="h-full rounded-[11px] bg-[var(--onboarding-accent,#4079ed)] transition-[width] motion-reduce:transition-none"
                  style={{ width: `${download.percentage}%` }}
                />
              </div>
            )}
          </div>
          {/* Disabled during install because extraction genuinely cannot be undone
              — Parakeet answers INSTALLATION_IN_PROGRESS — so the control should
              not invite a click it would have to walk back. */}
          <button
            type="button"
            onClick={() => void cancelDownload(download)}
            disabled={download.installing}
            aria-label={t("onboarding.rehaul.local.cancelDownload", {
              model: downloadDisplay(download).name,
            })}
            className="shrink-0 rounded-full transition-opacity hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--onboarding-accent,#4079ed)_30%,transparent)] disabled:cursor-default disabled:opacity-40 disabled:hover:opacity-40"
          >
            <CancelGlyph />
          </button>
        </div>
      ))}
    </aside>
  );
}
