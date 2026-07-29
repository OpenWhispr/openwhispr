import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Cpu, X } from "lucide-react";
import { Button } from "./ui/button";
import { useModelAutoDownloadStore } from "../stores/modelAutoDownloadStore";

const GEMMA_PROMPT_KEY = "gemmaDownloadPromptDismissed";
const GEMMA_MODEL_ID = "gemma-4-e4b-it-q4_k_m";

/**
 * One-time modal that offers to download the built-in Gemma model for offline
 * meeting-note generation. Shown once, after any active model auto-download
 * (e.g. Parakeet on first launch) has finished — showing it mid-download would
 * stack a modal on top of the download banner. Dismissal (accept, decline, or
 * X) is persisted so it never appears again.
 */
export default function GemmaDownloadPrompt() {
  const { t } = useTranslation();
  const [eligible, setEligible] = useState(false);
  const isAutoDownloadActive = useModelAutoDownloadStore((s) => s.isActive);

  useEffect(() => {
    // Never show again once dismissed.
    if (localStorage.getItem(GEMMA_PROMPT_KEY) === "true") return;

    let cancelled = false;
    window.electronAPI
      ?.modelCheck?.(GEMMA_MODEL_ID)
      .then((downloaded) => {
        if (cancelled) return;
        if (downloaded) {
          // Already have it — mark done so we never prompt.
          localStorage.setItem(GEMMA_PROMPT_KEY, "true");
        } else {
          setEligible(true);
        }
      })
      .catch(() => {
        // If the check fails, don't block the app — just skip the prompt.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleAccept = () => {
    localStorage.setItem(GEMMA_PROMPT_KEY, "true");
    setEligible(false);
    window.electronAPI?.downloadGemmaBuiltin?.();
  };

  const handleDecline = () => {
    localStorage.setItem(GEMMA_PROMPT_KEY, "true");
    setEligible(false);
  };

  // Hold the prompt back until any active auto-download (Parakeet) completes.
  if (!eligible || isAutoDownloadActive) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card border border-border rounded-xl shadow-lg max-w-md w-full mx-4 p-6">
        <div className="flex items-start gap-4">
          <div className="shrink-0 w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <Cpu size={20} className="text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-foreground mb-1">
              {t("gemmaPrompt.title")}
            </h3>
            <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
              {t("gemmaPrompt.description")}
            </p>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={handleAccept} className="text-xs">
                {t("gemmaPrompt.accept")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleDecline}
                className="text-xs text-muted-foreground"
              >
                {t("gemmaPrompt.decline")}
              </Button>
            </div>
          </div>
          <button
            onClick={handleDecline}
            aria-label={t("gemmaPrompt.decline")}
            className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
