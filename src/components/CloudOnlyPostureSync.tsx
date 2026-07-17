import { useEffect } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { setSttPosture, type SttPosture } from "../stores/sttPostureStore";
import {
  hasDownloadedLocalModels,
  isCloudTranscriptionActive,
  resolveSttPosture,
} from "../helpers/sttPosture.js";
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
 * Keeps tray tooltip + in-renderer posture cache aligned with local models / cloud config (#1082).
 */
export default function CloudOnlyPostureSync() {
  const useLocalWhisper = useSettingsStore((s) => s.useLocalWhisper);
  const cloudTranscriptionMode = useSettingsStore((s) => s.cloudTranscriptionMode);
  const transcriptionMode = useSettingsStore((s) => s.transcriptionMode);
  const isSignedIn = useSettingsStore((s) => s.isSignedIn);
  const remoteTranscriptionUrl = useSettingsStore((s) => s.remoteTranscriptionUrl);
  const cloudTranscriptionProvider = useSettingsStore((s) => s.cloudTranscriptionProvider);
  const cloudTranscriptionBaseUrl = useSettingsStore((s) => s.cloudTranscriptionBaseUrl);
  const openaiApiKey = useSettingsStore((s) => s.openaiApiKey);
  const groqApiKey = useSettingsStore((s) => s.groqApiKey);
  const xaiApiKey = useSettingsStore((s) => s.xaiApiKey);
  const mistralApiKey = useSettingsStore((s) => s.mistralApiKey);
  const tinfoilApiKey = useSettingsStore((s) => s.tinfoilApiKey);
  const cortiClientId = useSettingsStore((s) => s.cortiClientId);
  const cortiClientSecret = useSettingsStore((s) => s.cortiClientSecret);
  const cortiApiKey = useSettingsStore((s) => s.cortiApiKey);
  const customTranscriptionApiKey = useSettingsStore((s) => s.customTranscriptionApiKey);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const api = window.electronAPI;
      if (!api?.listWhisperModels || !api?.listParakeetModels) return;

      const [whisperResult, parakeetResult, secrets] = await Promise.all([
        api.listWhisperModels().catch(() => ({ models: [] })),
        api.listParakeetModels().catch(() => ({ models: [] })),
        loadTranscriptionSecrets(api),
      ]);
      if (cancelled) return;

      const settings = useSettingsStore.getState();
      const next = resolveSttPosture({
        hasLocalModels: hasDownloadedLocalModels(whisperResult?.models, parakeetResult?.models),
        cloudActive: isCloudTranscriptionActive({
          useLocalWhisper: settings.useLocalWhisper,
          cloudTranscriptionMode: settings.cloudTranscriptionMode,
          transcriptionMode: settings.transcriptionMode,
          isSignedIn: settings.isSignedIn,
          remoteTranscriptionUrl: settings.remoteTranscriptionUrl,
          cloudTranscriptionProvider: settings.cloudTranscriptionProvider,
          cloudTranscriptionBaseUrl: settings.cloudTranscriptionBaseUrl,
          ...secrets,
        }),
      }) as SttPosture;

      setSttPosture(next);
      await api.syncSttPosture?.({ posture: next }).catch(() => {});
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [
    useLocalWhisper,
    cloudTranscriptionMode,
    transcriptionMode,
    isSignedIn,
    remoteTranscriptionUrl,
    cloudTranscriptionProvider,
    cloudTranscriptionBaseUrl,
    openaiApiKey,
    groqApiKey,
    xaiApiKey,
    mistralApiKey,
    tinfoilApiKey,
    cortiClientId,
    cortiClientSecret,
    cortiApiKey,
    customTranscriptionApiKey,
  ]);

  return null;
}
