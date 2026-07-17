import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "./ui/useToast";
import { useSettingsStore } from "../stores/settingsStore";
import {
  hasDownloadedLocalModels,
  isCloudTranscriptionActive,
  resolveSttPosture,
} from "../helpers/sttPosture.js";
import { isControlPanelWindow } from "../utils/windowContext";

const PROMPT_SEEN_KEY = "sttSetupPromptSeen";

async function loadTranscriptionSecrets(api: Window["electronAPI"]) {
  const [
    openaiApiKey,
    groqApiKey,
    xaiApiKey,
    mistralApiKey,
    tinfoilApiKey,
    cortiClientId,
    cortiClientSecret,
    cortiApiKey,
    customTranscriptionApiKey,
  ] = await Promise.all([
    api?.getOpenAIKey?.().catch(() => ""),
    api?.getGroqKey?.().catch(() => ""),
    api?.getXaiKey?.().catch(() => ""),
    api?.getMistralKey?.().catch(() => ""),
    api?.getTinfoilKey?.().catch(() => ""),
    api?.getCortiClientId?.().catch(() => ""),
    api?.getCortiClientSecret?.().catch(() => ""),
    api?.getCortiKey?.().catch(() => ""),
    api?.getCustomTranscriptionKey?.().catch(() => ""),
  ]);

  return {
    openaiApiKey: openaiApiKey || "",
    groqApiKey: groqApiKey || "",
    xaiApiKey: xaiApiKey || "",
    mistralApiKey: mistralApiKey || "",
    tinfoilApiKey: tinfoilApiKey || "",
    cortiClientId: cortiClientId || "",
    cortiClientSecret: cortiClientSecret || "",
    cortiApiKey: cortiApiKey || "",
    customTranscriptionApiKey: customTranscriptionApiKey || "",
  };
}

/**
 * One-time actionable toast when the app has no local models and no cloud/self-hosted
 * STT provider configured (#1079). Cloud-only users are left alone.
 */
export default function SttSetupToastListener() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const ranRef = useRef(false);

  useEffect(() => {
    if (!isControlPanelWindow()) return;
    if (ranRef.current) return;
    if (typeof window === "undefined") return;
    if (localStorage.getItem(PROMPT_SEEN_KEY) === "1") return;
    if (localStorage.getItem("onboardingCompleted") !== "true") return;

    let cancelled = false;

    const run = async () => {
      const api = window.electronAPI;
      if (!api?.listWhisperModels || !api?.listParakeetModels) return;

      const [whisperResult, parakeetResult, secrets] = await Promise.all([
        api.listWhisperModels().catch(() => ({ models: [] })),
        api.listParakeetModels().catch(() => ({ models: [] })),
        loadTranscriptionSecrets(api),
      ]);
      if (cancelled || ranRef.current) return;

      // Read non-secret prefs after awaits so a concurrent settings write is visible.
      const settings = useSettingsStore.getState();
      const hasLocalModels = hasDownloadedLocalModels(
        whisperResult?.models,
        parakeetResult?.models
      );
      const cloudActive = isCloudTranscriptionActive({
        useLocalWhisper: settings.useLocalWhisper,
        cloudTranscriptionMode: settings.cloudTranscriptionMode,
        transcriptionMode: settings.transcriptionMode,
        isSignedIn: settings.isSignedIn,
        remoteTranscriptionUrl: settings.remoteTranscriptionUrl,
        cloudTranscriptionProvider: settings.cloudTranscriptionProvider,
        cloudTranscriptionBaseUrl: settings.cloudTranscriptionBaseUrl,
        ...secrets,
      });

      const posture = resolveSttPosture({ hasLocalModels, cloudActive });
      ranRef.current = true;

      // Cloud-only / local-ready: stay silent. Only unconfigured users get a one-time nudge.
      if (posture !== "unconfigured") return;

      localStorage.setItem(PROMPT_SEEN_KEY, "1");
      toast({
        title: t("app.toasts.sttSetupNeeded.title"),
        description: t("app.toasts.sttSetupNeeded.description"),
        duration: 12000,
      });
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [toast, t]);

  return null;
}
