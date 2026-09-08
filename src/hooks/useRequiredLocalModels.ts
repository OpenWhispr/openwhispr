import { useCallback, useEffect, useMemo, useState } from "react";
import { usePolicySnapshot } from "./usePolicy";
import { LOCAL_MODELS_CHANGED_EVENT } from "./useModelDownload";
import { missingRequiredLocalModels, requiredLocalModelIds } from "../stores/policyRules";

export interface RequiredLocalModelsState {
  /** Org-required model ids this build's registry knows how to download. */
  required: string[];
  /** Required ids not yet on disk. Empty while `loading` — check that flag. */
  missing: string[];
  /** True until the disk check for the current required list settles. */
  loading: boolean;
  /** Re-run the disk check. Call after a download completes or a model is deleted. */
  refresh: () => Promise<void>;
}

/**
 * Joins the org's required-download policy with disk truth — the same
 * listWhisperModels/listParakeetModels fan-out LocalModelSetupStep uses.
 * Policy updates arrive reactively (workspace-policy-changed → policy store →
 * usePolicySnapshot) and re-run the disk check. Shared by the onboarding
 * required-models step and the ControlPanel fleet banner.
 */
export function useRequiredLocalModels(): RequiredLocalModelsState {
  const snapshot = usePolicySnapshot();
  // Key on content: policy refreshes swap object identities every few minutes
  // without changing the list, and the disk fan-out shouldn't rerun for that.
  const requiredKey = useMemo(() => requiredLocalModelIds(snapshot).join("\n"), [snapshot]);
  const required = useMemo(() => (requiredKey ? requiredKey.split("\n") : []), [requiredKey]);
  const [installed, setInstalled] = useState<string[] | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const [whisper, parakeet] = await Promise.all([
      window.electronAPI?.listWhisperModels?.().catch(() => undefined),
      window.electronAPI?.listParakeetModels?.().catch(() => undefined),
    ]);
    setInstalled([
      ...(whisper?.models ?? []).filter((model) => model.downloaded).map((model) => model.model),
      ...(parakeet?.models ?? []).filter((model) => model.downloaded).map((model) => model.model),
    ]);
  }, []);

  useEffect(() => {
    // Nothing required (the common case) — skip the IPC fan-out entirely.
    if (!requiredKey) return;
    void refresh();

    // Downloads and deletions elsewhere in this window (Settings, the
    // background tray) change disk truth without going through this hook.
    const handleModelsChanged = () => void refresh();
    window.addEventListener(LOCAL_MODELS_CHANGED_EVENT, handleModelsChanged);
    window.addEventListener("openwhispr-models-cleared", handleModelsChanged);
    return () => {
      window.removeEventListener(LOCAL_MODELS_CHANGED_EVENT, handleModelsChanged);
      window.removeEventListener("openwhispr-models-cleared", handleModelsChanged);
    };
  }, [requiredKey, refresh]);

  const missing = useMemo(
    () =>
      required.length === 0 || installed === null
        ? []
        : missingRequiredLocalModels(required, installed),
    [required, installed]
  );

  return {
    required,
    missing,
    loading: required.length > 0 && installed === null,
    refresh,
  };
}
