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
  getPendingLocalModelAvailability,
  hasPendingLocalModels,
  readPendingLocalModels,
  type PendingLocalModelKind,
  type PendingLocalModelSelection,
} from "./pendingLocalModels";
import type {
  LocalLLMDownloadProgressEvent,
  ParakeetDownloadProgressData,
  WhisperDownloadProgressData,
} from "../../types/electron";
import { mergeHydratedDownloads } from "./localDownloadState";
import { ONBOARDING_SESSION_KEY, isRequiredModelsOnboardingStepActive } from "./flow";

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

// How long a cancelled key swallows in-flight progress events. Long enough for
// chunk events queued before the abort lands, short enough that a deliberate
// re-download of the same model renders promptly.
const CANCEL_SUPPRESSION_MS = 4000;

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
// Colours come from the app theme tokens (see the note on the <aside> below), so
// the glyph tracks light/dark on the control panel instead of Figma's literals.
function CancelGlyph() {
  return (
    <svg width={24} height={24} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect width={24} height={24} rx={12} fill="var(--color-muted)" />
      <path
        d="M16 8L8 16"
        stroke="var(--color-muted-foreground)"
        strokeWidth={1.33333}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 8L16 16"
        stroke="var(--color-muted-foreground)"
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
  const hydrationInProgress = useRef(true);
  const removedDuringHydration = useRef<Set<string>>(new Set());
  // An abort emits no terminal progress event (the IPC handlers exclude
  // DOWNLOAD_CANCELLED from the error emit), but chunk events already queued
  // when the user clicks cancel still arrive and would resurrect the removed
  // row. Suppress a cancelled key for a short grace window: in-flight events
  // are dropped, a completion always wins (the model really installed), and a
  // later re-download of the same model renders — and errors — normally.
  const cancelledKeys = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    // Hydration only exists to re-surface downloads the onboarding flow kicked
    // off before this mount, and those always travel with the local-setup
    // bookkeeping below. When neither marker is set there is nothing to recover,
    // so skip the three disk-scanning IPC calls — this is safe because any
    // download started after mount reaches us through the progress listeners in
    // the next effect regardless.
    if (localStorage.getItem("localSetupPending") !== "true" && !hasPendingLocalModels()) {
      hydrationInProgress.current = false;
      setHydrated(true);
      return;
    }

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

      const inventory = {
        whisper: whisper?.models,
        parakeet: parakeet?.models,
        llm,
      };
      const canActivate = localStorage.getItem("localSetupPending") === "true";
      for (const [kind, selection] of Object.entries(readPendingLocalModels()) as [
        PendingLocalModelKind,
        PendingLocalModelSelection,
      ][]) {
        const availability = getPendingLocalModelAvailability(kind, selection, inventory);
        if (availability === "downloaded" && canActivate) {
          activatePendingLocalModel(kind, selection.modelId);
        } else if (availability === "downloaded" || availability === "missing") {
          forgetPendingLocalModel(kind, selection.modelId);
        }
      }

      setDownloads((current) =>
        mergeHydratedDownloads(active, current, removedDuringHydration.current)
      );
      hydrationInProgress.current = false;
      setHydrated(true);
    };

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // The three progress channels carry the same lifecycle in different field
    // names, so each is normalized to this shape and fed through one apply
    // function — cancel suppression, pending-model activation, and the upsert /
    // delete-on-complete logic then only exist once.
    const applyProgress = (event: {
      kind: DownloadKind;
      id: string;
      type: "progress" | "installing" | "complete" | "error";
      percentage: number | undefined;
      error?: string;
    }) => {
      // The required-models onboarding step owns its downloads: it renders its
      // own per-row progress, and cancelling from here cannot stick because the
      // step auto-restarts org-mandated downloads. Suppress row creation while
      // that step is active; completions still pass so any pre-existing row
      // (a resumed local-setup download) can clear and activate normally.
      if (
        event.type !== "complete" &&
        isRequiredModelsOnboardingStepActive(localStorage.getItem(ONBOARDING_SESSION_KEY))
      ) {
        return;
      }
      const key = downloadKey(event.kind, event.id);
      const cancelledAt = cancelledKeys.current.get(key);
      if (cancelledAt !== undefined && event.type !== "complete") {
        if (Date.now() - cancelledAt < CANCEL_SUPPRESSION_MS) {
          // Consume the suppression only on a terminal event; a progress chunk
          // must keep it, or the next queued chunk resurrects the row.
          if (event.type === "error") cancelledKeys.current.delete(key);
          return;
        }
        cancelledKeys.current.delete(key);
      }
      if (event.type === "complete") {
        if (hydrationInProgress.current) removedDuringHydration.current.add(key);
        cancelledKeys.current.delete(key);
        activatePendingLocalModel(event.kind === "llm" ? "assistant" : "dictation", event.id);
      }
      setDownloads((current) => {
        if (event.type === "complete") {
          const next = { ...current };
          delete next[key];
          return next;
        }
        return {
          ...current,
          [key]: {
            id: event.id,
            kind: event.kind,
            percentage: clampPercentage(event.percentage),
            installing: event.type === "installing",
            error: event.type === "error" ? event.error : undefined,
          },
        };
      });
    };

    const normalizeTranscription = (
      kind: Exclude<DownloadKind, "llm">,
      data: WhisperDownloadProgressData | ParakeetDownloadProgressData
    ) =>
      applyProgress({
        kind,
        id: data.model,
        type: data.type,
        percentage: data.percentage,
        error: data.error,
      });

    const normalizeLlm = (_event: unknown, data: LocalLLMDownloadProgressEvent) =>
      applyProgress({
        kind: "llm",
        id: data.modelId,
        type: data.type ?? "progress",
        percentage: data.type === "error" ? 0 : data.progress,
        error: data.type === "error" ? data.error : undefined,
      });

    const disposeWhisper = window.electronAPI?.onWhisperDownloadProgress?.((_event, data) =>
      normalizeTranscription("whisper", data)
    );
    const disposeParakeet = window.electronAPI?.onParakeetDownloadProgress?.((_event, data) =>
      normalizeTranscription("parakeet", data)
    );
    const disposeLlm = window.electronAPI?.onModelDownloadProgress?.(normalizeLlm);

    return () => {
      disposeWhisper?.();
      disposeParakeet?.();
      disposeLlm?.();
    };
  }, []);

  const cancelDownload = useCallback(async (download: ActiveDownload) => {
    const key = downloadKey(download.kind, download.id);
    const pendingKind = download.kind === "llm" ? "assistant" : "dictation";

    // An error row represents a transfer that has already stopped. Its X is a
    // dismiss action, so no cancellation IPC is needed (and would be refused).
    if (download.error) {
      setDownloads((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      forgetPendingLocalModel(pendingKind, download.id);
      return;
    }

    if (hydrationInProgress.current) removedDuringHydration.current.add(key);
    cancelledKeys.current.set(key, Date.now());
    // Drop the row on click rather than waiting for the main process: the cancel
    // handlers resolve after the transfer unwinds, and a row that lingers reads as
    // a click that did nothing.
    setDownloads((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    let result: { success: boolean } | undefined;
    try {
      result =
        download.kind === "whisper"
          ? await window.electronAPI?.cancelWhisperDownload?.()
          : download.kind === "parakeet"
            ? await window.electronAPI?.cancelParakeetDownload?.()
            : await window.electronAPI?.modelCancelDownload?.(download.id);
    } catch {
      result = { success: false };
    }

    // The main process can refuse: Parakeet returns INSTALLATION_IN_PROGRESS once
    // extraction starts, and modelManagerBridge returns false when the request has
    // already gone. Put the row back rather than leaving the user believing a
    // download that is still running was stopped.
    if (result?.success !== true) {
      cancelledKeys.current.delete(key);
      setDownloads((current) => ({ ...current, [key]: download }));
      return;
    }

    // Only discard the intended selection once the transfer actually stopped.
    // If cancellation is refused, keeping it lets a finishing installation
    // activate the exact model the user originally chose.
    forgetPendingLocalModel(pendingKind, download.id);
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
    // stroke, no shadow. Colours bind to the app's standard theme tokens
    // (bg-card & co.) rather than --onboarding-*: the tray is mounted as a
    // sibling of the onboarding canvas / control panel in AppRouter, so the
    // onboarding tokens are out of scope post-onboarding and their light-mode
    // literals would break on a dark control panel. The app tokens resolve in
    // both contexts and match the Figma light values within a couple of hex
    // steps.
    <aside
      className="fixed right-7 bottom-5 z-50 w-[341px] overflow-hidden rounded-[12px] border border-border bg-card text-card-foreground"
      aria-label={t("onboarding.rehaul.local.downloads")}
      aria-live="polite"
    >
      {/* Frame 2147259037: #F7F7F7 strip, 7/8 padding, gap 5, 12/140% label. */}
      <div className="flex items-center gap-[5px] bg-muted px-2 py-[7px] text-xs leading-[1.4] text-muted-foreground">
        <BrandMark className="size-[11.2px] shrink-0 text-primary" />
        {t("onboarding.rehaul.local.downloadInProgress")}
      </div>
      {activeDownloads.map((download, index) => (
        // Frame 2147258983: a row of 8/10 padding and gap 10, holding the growing
        // Frame 17 column and the cancel control. Only the rows after the first
        // carry a hairline — the header strip separates the first one.
        <div
          key={downloadKey(download.kind, download.id)}
          className={`flex items-center gap-2.5 px-2.5 py-2 ${
            index === 0 ? "" : "border-t border-border"
          }`}
        >
          {/* Frame 17: fills the row, col gap 8. */}
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-center justify-between gap-2 text-xs leading-[1.4]">
              <span className="flex min-w-0 items-center gap-[7px]">
                <ProviderIcon
                  provider={downloadDisplay(download).provider}
                  className="size-[14.55px] shrink-0"
                  monochrome={downloadDisplay(download).provider === "qwen"}
                />
                <span className="min-w-0 truncate font-medium">
                  {downloadDisplay(download).name}
                </span>
              </span>
              <span className="shrink-0 font-medium text-muted-foreground">
                {Math.round(download.percentage)}%
              </span>
            </div>
            {download.error ? (
              <p className="truncate text-[0.625rem] text-destructive">{download.error}</p>
            ) : (
              // Frame 2147259038: 12 tall track on #F7F7F7 at radius 9, brand fill
              // at radius 11.
              <div className="h-3 overflow-hidden rounded-[9px] bg-muted">
                <div
                  className="h-full rounded-[11px] bg-primary transition-[width] motion-reduce:transition-none"
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
            className="shrink-0 rounded-full transition-opacity hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-default disabled:opacity-40 disabled:hover:opacity-40"
          >
            <CancelGlyph />
          </button>
        </div>
      ))}
    </aside>
  );
}
