import { useCallback, useEffect, useState } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { subscribeToAnalyticsRefresh } from "../services/AnalyticsService";
import { TONE_STYLE_PROMPT_MIN_WORDS } from "../config/toneStyle";

const BANNER_DISMISSED_KEY = "toneStyleBannerDismissed";
const SETUP_PROMPTED_KEY = "toneStyleSetupPrompted";

const readFlag = (key: string) => localStorage.getItem(key) === "true";

export const dismissToneStyleBanner = () => localStorage.setItem(BANNER_DISMISSED_KEY, "true");

/**
 * Tone & Style's Home entry points, offered once the user has dictated
 * TONE_STYLE_PROMPT_MIN_WORDS words: the banner until it is set up or
 * dismissed, and the setup dialog, opened by itself the first time. The word
 * count is local history's, so with history off only Settings offers it.
 */
export function useToneStylePrompt() {
  const toneStyleEnabled = useSettingsStore((s) => s.toneStyleEnabled);
  const [bannerDismissed, setBannerDismissed] = useState(() => readFlag(BANNER_DISMISSED_KEY));
  const [totalWords, setTotalWords] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const pending = !toneStyleEnabled && !bannerDismissed;

  useEffect(() => {
    if (!pending || !window.electronAPI?.getAnalyticsSummary) return;
    return subscribeToAnalyticsRefresh(async () => {
      const summary = await window.electronAPI.getAnalyticsSummary();
      setTotalWords(summary.totalWords);
    }, false);
  }, [pending]);

  const eligible = pending && totalWords >= TONE_STYLE_PROMPT_MIN_WORDS;

  useEffect(() => {
    if (!eligible || readFlag(SETUP_PROMPTED_KEY)) return;
    localStorage.setItem(SETUP_PROMPTED_KEY, "true");
    setDialogOpen(true);
  }, [eligible]);

  const dismissBanner = useCallback(() => {
    dismissToneStyleBanner();
    setBannerDismissed(true);
  }, []);

  // Once Tone & Style is set up, Home stops offering it.
  useEffect(() => {
    if (toneStyleEnabled) dismissBanner();
  }, [toneStyleEnabled, dismissBanner]);

  return { showBanner: eligible, dialogOpen, setDialogOpen, dismissBanner };
}
