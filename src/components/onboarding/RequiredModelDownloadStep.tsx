import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { ProviderIcon } from "../ui/ProviderIcon";
import { useModelDownload } from "../../hooks/useModelDownload";
import { getParakeetModels, getWhisperModels } from "../../models/ModelRegistry";
import { SETUP_CARD_CLASS } from "./ProviderSetupStep";

type ModelFamily = "whisper" | "parakeet";

interface RequiredModelDownloadStepProps {
  /** Org-required registry ids, from useRequiredLocalModels. */
  required: string[];
  missing: string[];
  loading: boolean;
  refresh: () => Promise<void>;
  onProceed: () => void;
}

/**
 * The blocking download checklist for org-required local models. Downloads
 * auto-start sequentially (the per-family managers reject concurrency) and the
 * container's Continue enables only when every required model is on disk.
 * Deliberately does NOT write pendingLocalModels/localSetupPending: that
 * machinery lets users leave mid-download, the exact behavior this step
 * prevents. Back and Skip are suppressed by the container.
 */
export function RequiredModelDownloadStep({
  required,
  missing,
  loading,
  refresh,
  onProceed,
}: RequiredModelDownloadStepProps) {
  const { t } = useTranslation();
  const whisperCatalog = getWhisperModels();
  const parakeetCatalog = getParakeetModels();

  const whisperDownload = useModelDownload({ modelType: "whisper", onDownloadComplete: refresh });
  const parakeetDownload = useModelDownload({ modelType: "parakeet", onDownloadComplete: refresh });

  const [failedModels, setFailedModels] = useState<Record<string, string>>({});
  const lastStartedRef = useRef<{ family: ModelFamily; id: string } | null>(null);
  const startedAnyRef = useRef(false);
  const autoAdvancedRef = useRef(false);

  const familyOf = useCallback(
    (modelId: string): ModelFamily => (modelId in parakeetCatalog ? "parakeet" : "whisper"),
    [parakeetCatalog]
  );
  const missingSet = useMemo(() => new Set(missing), [missing]);
  const anyDownloadActive = whisperDownload.isDownloading || parakeetDownload.isDownloading;

  // useModelDownload clears its downloading state on error, so the failing
  // model id has to be remembered here to pin the error to its row.
  useEffect(() => {
    const last = lastStartedRef.current;
    if (!last) return;
    const error =
      last.family === "whisper" ? whisperDownload.downloadError : parakeetDownload.downloadError;
    if (!error) return;
    setFailedModels((current) =>
      current[last.id] === error ? current : { ...current, [last.id]: error }
    );
  }, [whisperDownload.downloadError, parakeetDownload.downloadError]);

  const startDownload = useCallback(
    (modelId: string) => {
      startedAnyRef.current = true;
      setFailedModels((current) => {
        if (!(modelId in current)) return current;
        const next = { ...current };
        delete next[modelId];
        return next;
      });
      const family = familyOf(modelId);
      lastStartedRef.current = { family, id: modelId };
      const download = family === "parakeet" ? parakeetDownload : whisperDownload;
      void download.downloadModel(modelId);
    },
    [familyOf, parakeetDownload, whisperDownload]
  );

  // Sequential auto-start: kick off the next missing model whenever nothing is
  // downloading. Rows that already failed wait for an explicit Retry.
  useEffect(() => {
    if (loading || anyDownloadActive) return;
    const next = missing.find((modelId) => !failedModels[modelId]);
    if (next) startDownload(next);
  }, [loading, anyDownloadActive, missing, failedModels, startDownload]);

  // The route raced a completed download (or the requirement was lifted) and
  // everything is already on disk: continue instead of showing a stale
  // blocking screen. Only before any download ran here — after one, the user
  // sees the completed checklist and continues themselves.
  useEffect(() => {
    if (autoAdvancedRef.current || startedAnyRef.current) return;
    if (!loading && missing.length === 0) {
      autoAdvancedRef.current = true;
      onProceed();
    }
  }, [loading, missing, onProceed]);

  const hasFailures = Object.keys(failedModels).length > 0;

  return (
    <section className={`mt-5 ${SETUP_CARD_CLASS}`}>
      <div className="onboarding-scroll-hidden max-h-72 overflow-y-auto rounded-2xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface-secondary)] px-3">
        {required.map((modelId) => {
          const family = familyOf(modelId);
          const info = family === "parakeet" ? parakeetCatalog[modelId] : whisperCatalog[modelId];
          const download = family === "parakeet" ? parakeetDownload : whisperDownload;
          const isDownloading = download.isDownloadingModel(modelId);
          const failure = failedModels[modelId];
          const installed = !loading && !missingSet.has(modelId) && !isDownloading;
          const percentage = Math.round(download.downloadProgress.percentage);

          return (
            <div
              key={modelId}
              className="flex min-h-14 items-center gap-3 border-b border-[var(--onboarding-control-border)] px-1 py-2 last:border-b-0"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)]">
                <ProviderIcon
                  provider={family === "parakeet" ? "nvidia" : "openai"}
                  className="size-5"
                />
              </span>
              <div className="min-w-0 flex-1 text-left">
                <span className="block truncate text-sm font-medium text-[var(--onboarding-text-primary)]">
                  {info?.name ?? modelId}
                </span>
                {failure ? (
                  <span className="mt-0.5 block truncate text-xs text-destructive">{failure}</span>
                ) : (
                  <span className="mt-0.5 block truncate text-xs text-[var(--onboarding-text-secondary)]">
                    {info?.size?.replace(/(?<=\d)(?=[A-Za-z])/, " ") ?? ""}
                  </span>
                )}
              </div>

              {isDownloading ? (
                <span className="relative -mr-2 flex shrink-0 items-center gap-2 overflow-hidden rounded-[38px] border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-3 py-1.5 text-sm font-medium leading-[1.4] text-[var(--onboarding-text-secondary)]">
                  <span
                    className="absolute inset-y-0 left-0 bg-[var(--onboarding-surface-tertiary)] transition-[width] duration-300 ease-out"
                    style={{ width: `${percentage}%` }}
                    aria-hidden="true"
                  />
                  <span className="relative">{percentage}%</span>
                  <span className="relative whitespace-nowrap">
                    {download.isInstalling
                      ? t("onboarding.rehaul.local.installing")
                      : t("onboarding.rehaul.local.downloadingShort")}
                  </span>
                </span>
              ) : failure ? (
                <Button
                  type="button"
                  onClick={() => startDownload(modelId)}
                  className="-mr-2 h-7 gap-1.5 rounded-full border-0! bg-[var(--onboarding-accent)] px-2.5 text-xs font-normal text-[var(--onboarding-accent-foreground)] shadow-none! hover:bg-[var(--onboarding-accent-hover)] hover:shadow-none!"
                >
                  {t("common.retry")}
                </Button>
              ) : installed ? (
                <span className="-mr-2 flex h-7 shrink-0 items-center gap-1 rounded-full bg-[var(--onboarding-accent)] px-3 text-xs text-[var(--onboarding-accent-foreground)]">
                  <Check className="size-3.5" />
                  {t("onboarding.requiredModels.installed")}
                </span>
              ) : (
                <span className="-mr-2 shrink-0 text-xs text-[var(--onboarding-text-secondary)]">
                  {t("onboarding.requiredModels.queued")}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {hasFailures && (
        <div
          role="alert"
          className="mt-3 flex w-full flex-col items-center rounded-2xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-4 py-5 text-center"
        >
          <span className="flex size-10 items-center justify-center rounded-full bg-[var(--onboarding-surface-secondary)] text-[var(--onboarding-accent)]">
            <AlertCircle className="size-5" />
          </span>
          <h2 className="mt-3 text-sm font-semibold text-[var(--onboarding-text-primary)]">
            {t("onboarding.requiredModels.failed.title")}
          </h2>
          <p className="mt-1.5 text-xs leading-5 text-[var(--onboarding-text-secondary)]">
            {t("onboarding.requiredModels.failed.description")}
          </p>
        </div>
      )}
    </section>
  );
}
