import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import { isLlmSelectionAllowed, isTranscriptionSelectionAllowed } from "../../stores/policyRules";
import { MAX_FALLBACK_TARGETS } from "../../helpers/modelFallback";
import {
  getFallbackProviders,
  getDownloadedFallbackModels,
  type FallbackStage,
} from "../../helpers/modelFallbackModels";
import FallbackKeySelect from "./FallbackKeySelect";
import { Toggle } from "../ui/toggle";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

export default function ModelFallbackSettings({ stage }: { stage: FallbackStage }) {
  const { t } = useTranslation();
  const id = useId();
  const policy = usePolicySnapshot();
  const enabled = useSettingsStore((s) =>
    stage === "cleanup" ? s.cleanupFallbackEnabled : s.transcriptionFallbackEnabled
  );
  const targets = useSettingsStore((s) =>
    stage === "cleanup" ? s.cleanupFallbackModels : s.transcriptionFallbackModels
  );
  const setEnabled = useSettingsStore((s) =>
    stage === "cleanup" ? s.setCleanupFallbackEnabled : s.setTranscriptionFallbackEnabled
  );
  const setTargets = useSettingsStore((s) =>
    stage === "cleanup" ? s.setCleanupFallbackModels : s.setTranscriptionFallbackModels
  );
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [keyId, setKeyId] = useState("");
  const [profiles, setProfiles] = useState<Array<{ id: string; provider: string; label: string }>>(
    []
  );
  const [downloaded, setDownloaded] = useState(new Set<string>());
  const providers = getFallbackProviders(stage);
  const isAllowed = (provider: (typeof providers)[number]) => {
    const selection = {
      mode: provider.local ? ("local" as const) : ("providers" as const),
      provider: provider.id,
    };
    return stage === "cleanup"
      ? isLlmSelectionAllowed(policy, selection)
      : isTranscriptionSelectionAllowed(policy, selection);
  };
  const selectable = providers.filter(isAllowed);
  const selectedProvider = selectable.find((provider) => provider.id === providerId);
  const models =
    selectedProvider?.models.filter(
      (model) => !selectedProvider.local || downloaded.has(model.id)
    ) ?? [];
  const supportsKeys =
    selectedProvider &&
    !selectedProvider.local &&
    !(stage === "transcription" && providerId === "corti");
  const canAdd =
    targets.length < MAX_FALLBACK_TARGETS &&
    (!keyId ||
      profiles.some((profile) => profile.id === keyId && profile.provider === providerId)) &&
    !!selectedProvider &&
    !!modelId.trim() &&
    (selectedProvider.customModel || models.some((model) => model.id === modelId)) &&
    !targets.some(
      (target) =>
        target.provider === providerId &&
        target.model === modelId.trim() &&
        (target.keyId ?? "") === keyId
    );

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const loadProfiles = async () => {
      const result = await window.electronAPI?.listFallbackKeys?.();
      if (!disposed && result?.success) setProfiles(result.profiles ?? []);
    };
    void loadProfiles().catch(() => {});
    const unsubscribe = window.electronAPI?.onFallbackKeysChanged?.(() => {
      void loadProfiles().catch(() => {});
    });
    getDownloadedFallbackModels(stage)
      .then((models) => {
        if (!disposed) setDownloaded(models);
      })
      .catch(() => {
        if (!disposed) setDownloaded(new Set());
      });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [stage, enabled]);

  const move = (index: number, offset: number) => {
    const next = [...targets];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    setTargets(next);
  };

  return (
    <section className="space-y-3 border-t border-border pt-3" aria-labelledby={`${id}-title`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 id={`${id}-title`} className="text-sm font-medium">
            {t("modelFallback.title")}
          </h4>
          <p className="text-xs text-muted-foreground">{t("modelFallback.description")}</p>
        </div>
        <Toggle checked={enabled} onChange={setEnabled} ariaLabel={t("modelFallback.title")} />
      </div>
      {enabled && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{t("modelFallback.credentials")}</p>
          {targets.length > 0 ? (
            <ol className="space-y-2" aria-label={t("modelFallback.order")}>
              {targets.map((target, index) => {
                const provider = providers.find((entry) => entry.id === target.provider);
                const name =
                  provider?.models.find((model) => model.id === target.model)?.name ?? target.model;
                const available =
                  provider &&
                  isAllowed(provider) &&
                  (!provider.local || downloaded.has(target.model)) &&
                  (!target.keyId ||
                    profiles.some(
                      (profile) =>
                        profile.id === target.keyId && profile.provider === target.provider
                    ));
                return (
                  <li
                    key={`${target.provider}:${target.model}:${target.keyId ?? "default"}`}
                    className="flex items-center gap-2 rounded-lg border p-2"
                  >
                    <span className="text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm" title={target.model}>
                        {name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {provider?.name ?? target.provider}
                        {target.keyId &&
                          ` · ${profiles.find((profile) => profile.id === target.keyId)?.label ?? t("modelFallback.missingKey")}`}
                        {!available && ` · ${t("modelFallback.unavailable")}`}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                      aria-label={t("modelFallback.moveUp", { model: name })}
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={index === targets.length - 1}
                      onClick={() => move(index, 1)}
                      aria-label={t("modelFallback.moveDown", { model: name })}
                    >
                      ↓
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setTargets(targets.filter((_, i) => i !== index))}
                      aria-label={t("modelFallback.remove", { model: name })}
                    >
                      ×
                    </Button>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="text-xs text-muted-foreground">{t("modelFallback.empty")}</p>
          )}
          {(targets.length < MAX_FALLBACK_TARGETS || providerId) && (
            <div className="space-y-2">
              <Select
                value={providerId}
                onValueChange={(value) => {
                  setProviderId(value);
                  setModelId("");
                  setKeyId("");
                }}
              >
                <SelectTrigger aria-label={t("modelFallback.provider")}>
                  <SelectValue placeholder={t("modelFallback.provider")} />
                </SelectTrigger>
                <SelectContent>
                  {selectable.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>
                      {provider.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedProvider?.customModel ? (
                <Input
                  dir="ltr"
                  aria-label={t("modelFallback.model")}
                  value={modelId}
                  onChange={(event) => setModelId(event.target.value)}
                  placeholder={t("modelFallback.modelId")}
                  maxLength={256}
                />
              ) : (
                selectedProvider && (
                  <Select value={modelId} onValueChange={setModelId}>
                    <SelectTrigger aria-label={t("modelFallback.model")}>
                      <SelectValue placeholder={t("modelFallback.model")} />
                    </SelectTrigger>
                    <SelectContent>
                      {models.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          {model.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )
              )}
              {selectedProvider?.local && models.length === 0 && (
                <p className="text-xs text-muted-foreground">{t("modelFallback.downloadLocal")}</p>
              )}
              {supportsKeys && (
                <FallbackKeySelect
                  key={providerId}
                  provider={providerId}
                  value={keyId}
                  onChange={setKeyId}
                  profiles={profiles}
                  onProfilesChange={setProfiles}
                />
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canAdd}
                onClick={() => {
                  setTargets([
                    ...targets,
                    { provider: providerId, model: modelId.trim(), ...(keyId ? { keyId } : {}) },
                  ]);
                  setModelId("");
                }}
              >
                {t("modelFallback.add")}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
