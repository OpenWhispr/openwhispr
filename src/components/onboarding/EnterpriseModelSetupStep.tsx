import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Check, Download, Loader2, RotateCcw } from "lucide-react";
import { Button } from "../ui/button";
import { ProviderIcon } from "../ui/ProviderIcon";
import { useModelDownload } from "../../hooks/useModelDownload";
import {
  getParakeetModelInfo,
  getWhisperModelInfo,
  modelRegistry,
} from "../../models/ModelRegistry";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import { isAgentAllowed, isModeAllowedByPolicy } from "../../stores/policyRules";
import { usePolicyStore } from "../../stores/policyStore";
import {
  selectEffectiveManagedLocalModels,
  useEnterpriseIdentityStore,
} from "../../stores/enterpriseIdentityStore";
import type {
  ManagedEnterpriseLocalModelSelection,
  ManagedEnterpriseLocalModels,
} from "../../types/enterpriseIdentity";
import type { ParakeetCheckResult } from "../../types/electron";
import {
  applyManagedLocalModelSelectionWhenAllowed,
  canChooseManagedLocalModel,
  canInitialSetupApplyManagedLocalModel,
  clearManagedLocalModelCategoryError,
  getManagedLocalModelBindingError,
  getManagedLocalModelInventoryRetryDelay,
  isApprovedManagedLocalModel,
  isManagedLocalModelBindingSelectionCurrent,
  MANAGED_LOCAL_MODEL_ERROR_CODES,
  MANAGED_LOCAL_MODEL_BINDINGS_KEY,
  readManagedLocalModelBinding,
  recordManagedLocalModelDownloadError,
  recordPendingManagedLocalModelError,
  routeManagedLocalModelSetupChoice,
  resolveManagedLocalModelInventorySnapshot,
  setManagedLocalModelBindingError,
  translateManagedLocalModelError,
  writeManagedLocalModelBinding,
  type ManagedLocalModelBinding,
} from "./managedLocalModels";
import {
  forgetPendingLocalModel,
  rememberPendingLocalModel,
  type PendingManagedModelIdentity,
} from "./pendingLocalModels";
import { enforceManagedLocalModelSettings } from "./managedLocalModelSettings";

interface EnterpriseModelSetupIdentity extends PendingManagedModelIdentity {}

interface EnterpriseModelSetupStepProps {
  identity: EnterpriseModelSetupIdentity;
  config: ManagedEnterpriseLocalModels;
  ownsDownloads?: boolean;
  onReadinessChange: (ready: boolean) => void;
}

interface ModelInventory {
  whisper: Set<string>;
  parakeet: Set<string>;
  reasoning: Set<string>;
  whisperKnown: boolean;
  parakeetKnown: boolean;
  reasoningKnown: boolean;
}

interface DisplayModel extends ManagedEnterpriseLocalModelSelection {
  name: string;
  size: string;
  compatible: boolean;
  compatibilityMessage?: string;
}

const emptyInventory = (): ModelInventory => ({
  whisper: new Set<string>(),
  parakeet: new Set<string>(),
  reasoning: new Set<string>(),
  whisperKnown: false,
  parakeetKnown: false,
  reasoningKnown: false,
});

function sameModel(
  left: ManagedEnterpriseLocalModelSelection | null,
  right: ManagedEnterpriseLocalModelSelection
): boolean {
  return Boolean(left && left.provider === right.provider && left.modelId === right.modelId);
}

function displayModel(
  selection: ManagedEnterpriseLocalModelSelection,
  parakeetCapability: ParakeetCheckResult | null | undefined,
  translate: (key: string, options?: { version?: string }) => string
): DisplayModel | null {
  if (selection.provider === "whisper") {
    const model = getWhisperModelInfo(selection.modelId);
    return model ? { ...selection, name: model.name, size: model.size, compatible: true } : null;
  }
  if (selection.provider === "nvidia") {
    const model = getParakeetModelInfo(selection.modelId);
    if (!model) return null;
    return {
      ...selection,
      name: model.name,
      size: model.size,
      compatible: parakeetCapability?.supported === true,
      compatibilityMessage:
        parakeetCapability === undefined
          ? translate("managedLocalModels.compatibility.checking")
          : parakeetCapability === null
            ? translate("managedLocalModels.compatibility.unavailable")
            : parakeetCapability.supported === false
              ? parakeetCapability.code === "PARAKEET_UNSUPPORTED_OS" &&
                parakeetCapability.minimumMacOSVersion
                ? translate("managedLocalModels.compatibility.requiresMacOS", {
                    version: parakeetCapability.minimumMacOSVersion,
                  })
                : translate("managedLocalModels.compatibility.unsupported")
              : undefined,
    };
  }
  const registered = modelRegistry.getModel(selection.modelId);
  if (!registered || registered.provider.id !== selection.provider) return null;
  return {
    ...selection,
    name: registered.model.name,
    size: registered.model.size,
    compatible: true,
  };
}

export default function EnterpriseModelSetupStep({
  identity,
  config,
  ownsDownloads = true,
  onReadinessChange,
}: EnterpriseModelSetupStepProps): JSX.Element {
  const { t } = useTranslation();
  const policy = usePolicySnapshot();
  const [binding, setBinding] = useState<ManagedLocalModelBinding>(() => {
    const initialBinding = readManagedLocalModelBinding(identity.accountId, identity.workspaceId);
    return {
      configVersion: config.version,
      transcription: isApprovedManagedLocalModel(
        config.transcription,
        initialBinding?.transcription
      )
        ? (initialBinding?.transcription ?? null)
        : null,
      reasoning: isApprovedManagedLocalModel(config.reasoning, initialBinding?.reasoning)
        ? (initialBinding?.reasoning ?? null)
        : null,
      error: initialBinding?.configVersion === config.version ? initialBinding.error : null,
      categoryErrors:
        initialBinding?.configVersion === config.version ? initialBinding.categoryErrors : {},
      retryGeneration:
        initialBinding?.configVersion === config.version
          ? initialBinding.retryGeneration
          : undefined,
    };
  });
  const [inventory, setInventory] = useState<ModelInventory>(emptyInventory);
  const [inventoryRefreshAttempts, setInventoryRefreshAttempts] = useState(0);
  const [resolvedParakeetCapability, setResolvedParakeetCapability] = useState<{
    identityKey: string;
    result: ParakeetCheckResult | null;
  } | null>(null);
  const capabilityIdentityKey = `${identity.accountId}:${identity.workspaceId}:${identity.authGeneration}`;
  const parakeetCapability =
    resolvedParakeetCapability?.identityKey === capabilityIdentityKey
      ? resolvedParakeetCapability.result
      : undefined;

  const refreshInventory = useCallback(async (): Promise<void> => {
    const [whisper, parakeet, reasoning] = await Promise.all([
      window.electronAPI?.listWhisperModels?.().catch(() => undefined),
      window.electronAPI?.listParakeetModels?.().catch(() => undefined),
      window.electronAPI?.modelGetAll?.().catch(() => undefined),
    ]);
    setInventory((current) => {
      const whisperInstalled = resolveManagedLocalModelInventorySnapshot(
        current.whisper,
        whisper === undefined
          ? undefined
          : new Set(whisper.models.filter((model) => model.downloaded).map((model) => model.model))
      );
      const parakeetInstalled = resolveManagedLocalModelInventorySnapshot(
        current.parakeet,
        parakeet === undefined
          ? undefined
          : new Set(parakeet.models.filter((model) => model.downloaded).map((model) => model.model))
      );
      const reasoningInstalled = resolveManagedLocalModelInventorySnapshot(
        current.reasoning,
        reasoning === undefined
          ? undefined
          : new Set(reasoning.filter((model) => model.isDownloaded).map((model) => model.id))
      );
      return {
        whisper: whisperInstalled.value,
        parakeet: parakeetInstalled.value,
        reasoning: reasoningInstalled.value,
        whisperKnown: whisperInstalled.known,
        parakeetKnown: parakeetInstalled.known,
        reasoningKnown: reasoningInstalled.known,
      };
    });
    setInventoryRefreshAttempts((attempts) => attempts + 1);
  }, []);

  const whisperDownload = useModelDownload({
    modelType: "whisper",
    onDownloadComplete: refreshInventory,
    onTerminalError: (modelId, error) => {
      if (
        canInitialSetupApplyManagedLocalModel(
          ownsDownloads,
          localStorage.getItem("onboardingCompleted") === "true"
        )
      ) {
        recordPendingManagedLocalModelError("dictation", modelId, error);
      }
    },
  });
  const parakeetDownload = useModelDownload({
    modelType: "parakeet",
    onDownloadComplete: refreshInventory,
    onTerminalError: (modelId, error) => {
      if (
        canInitialSetupApplyManagedLocalModel(
          ownsDownloads,
          localStorage.getItem("onboardingCompleted") === "true"
        )
      ) {
        recordPendingManagedLocalModelError("dictation", modelId, error);
      }
    },
  });
  const reasoningDownload = useModelDownload({
    modelType: "llm",
    onDownloadComplete: refreshInventory,
    onTerminalError: (modelId, error) => {
      if (
        canInitialSetupApplyManagedLocalModel(
          ownsDownloads,
          localStorage.getItem("onboardingCompleted") === "true"
        )
      ) {
        recordPendingManagedLocalModelError("assistant", modelId, error);
      }
    },
  });

  useEffect(() => {
    let cancelled = false;
    setResolvedParakeetCapability(null);
    void refreshInventory();
    void window.electronAPI
      ?.checkParakeetInstallation?.()
      .then((capability) => {
        if (!cancelled) {
          setResolvedParakeetCapability({ identityKey: capabilityIdentityKey, result: capability });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolvedParakeetCapability({ identityKey: capabilityIdentityKey, result: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [capabilityIdentityKey, refreshInventory]);

  useEffect(() => {
    const transcriptionUnknown = config.transcription.some((selection) =>
      selection.provider === "whisper" ? !inventory.whisperKnown : !inventory.parakeetKnown
    );
    const reasoningUnknown = config.reasoning.length > 0 && !inventory.reasoningKnown;
    if (!transcriptionUnknown && !reasoningUnknown) {
      if (inventoryRefreshAttempts !== 0) setInventoryRefreshAttempts(0);
      return;
    }
    if (inventoryRefreshAttempts === 0) return;
    const delay = getManagedLocalModelInventoryRetryDelay(inventoryRefreshAttempts);
    if (delay === null) return;
    const timer = window.setTimeout(() => void refreshInventory(), delay);
    return () => window.clearTimeout(timer);
  }, [config, inventory, inventoryRefreshAttempts, refreshInventory]);

  useEffect(() => {
    const syncBinding = (): void => {
      const latest = readManagedLocalModelBinding(identity.accountId, identity.workspaceId);
      if (latest?.configVersion === config.version) setBinding(latest);
    };
    const syncBindingFromStorage = (event: StorageEvent): void => {
      if (event.key === MANAGED_LOCAL_MODEL_BINDINGS_KEY) syncBinding();
    };
    window.addEventListener("openwhispr-managed-local-model-binding", syncBinding);
    window.addEventListener("storage", syncBindingFromStorage);
    return () => {
      window.removeEventListener("openwhispr-managed-local-model-binding", syncBinding);
      window.removeEventListener("storage", syncBindingFromStorage);
    };
  }, [config.version, identity.accountId, identity.workspaceId]);

  const transcriptionModels = useMemo(
    () =>
      config.transcription
        .map((model) => displayModel(model, parakeetCapability, t))
        .filter((model): model is DisplayModel => Boolean(model)),
    [config.transcription, parakeetCapability, t]
  );
  const reasoningModels = useMemo(
    () =>
      config.reasoning
        .map((model) => displayModel(model, parakeetCapability, t))
        .filter((model): model is DisplayModel => Boolean(model)),
    [config.reasoning, parakeetCapability, t]
  );

  const isInstalled = useCallback(
    (model: ManagedEnterpriseLocalModelSelection): boolean => {
      if (model.provider === "whisper") return inventory.whisper.has(model.modelId);
      if (model.provider === "nvidia") return inventory.parakeet.has(model.modelId);
      return inventory.reasoning.has(model.modelId);
    },
    [inventory]
  );
  const isDownloading = useCallback(
    (model: ManagedEnterpriseLocalModelSelection): boolean => {
      if (model.provider === "whisper") return whisperDownload.isDownloadingModel(model.modelId);
      if (model.provider === "nvidia") return parakeetDownload.isDownloadingModel(model.modelId);
      return reasoningDownload.isDownloadingModel(model.modelId);
    },
    [parakeetDownload, reasoningDownload, whisperDownload]
  );
  const isInventoryKnown = useCallback(
    (model: ManagedEnterpriseLocalModelSelection): boolean => {
      if (model.provider === "whisper") return inventory.whisperKnown;
      if (model.provider === "nvidia") return inventory.parakeetKnown;
      return inventory.reasoningKnown;
    },
    [inventory.parakeetKnown, inventory.reasoningKnown, inventory.whisperKnown]
  );

  const persistBinding = useCallback(
    (next: ManagedLocalModelBinding): void => {
      setBinding(next);
      writeManagedLocalModelBinding(identity.accountId, identity.workspaceId, next);
    },
    [identity.accountId, identity.workspaceId]
  );

  const applySelection = useCallback(
    (
      category: "transcription" | "reasoning",
      selection: ManagedEnterpriseLocalModelSelection,
      complete = true
    ): boolean => {
      if (
        !canInitialSetupApplyManagedLocalModel(
          ownsDownloads,
          localStorage.getItem("onboardingCompleted") === "true"
        )
      ) {
        return false;
      }
      const enterprise = useEnterpriseIdentityStore.getState();
      const currentConfig = selectEffectiveManagedLocalModels(enterprise);
      const currentBinding = readManagedLocalModelBinding(identity.accountId, identity.workspaceId);
      const approved =
        category === "transcription" ? currentConfig?.transcription : currentConfig?.reasoning;
      if (
        enterprise.accountId !== identity.accountId ||
        enterprise.workspaceId !== identity.workspaceId ||
        enterprise.authGeneration !== identity.authGeneration ||
        currentConfig?.version !== identity.configVersion ||
        !isManagedLocalModelBindingSelectionCurrent(
          currentBinding,
          identity.configVersion,
          category,
          selection
        ) ||
        !approved ||
        !isApprovedManagedLocalModel(approved, selection)
      ) {
        return false;
      }
      const policyScope = category === "transcription" ? "transcription" : "llm";
      return applyManagedLocalModelSelectionWhenAllowed(
        isModeAllowedByPolicy(usePolicyStore.getState(), policyScope, "local"),
        () => {
          enforceManagedLocalModelSettings(
            category,
            selection,
            isAgentAllowed(usePolicyStore.getState())
          );
          if (!complete) return;
          forgetPendingLocalModel(
            category === "reasoning" ? "assistant" : "dictation",
            selection.modelId
          );
          const latest =
            readManagedLocalModelBinding(identity.accountId, identity.workspaceId) ?? binding;
          persistBinding(
            clearManagedLocalModelCategoryError({ ...latest, [category]: selection }, category)
          );
        },
        () => {
          setManagedLocalModelBindingError(
            identity.accountId,
            identity.workspaceId,
            currentConfig.version,
            category === "transcription"
              ? MANAGED_LOCAL_MODEL_ERROR_CODES.policyTranscription
              : MANAGED_LOCAL_MODEL_ERROR_CODES.policyReasoning
          );
        }
      );
    },
    [binding, identity, ownsDownloads, persistBinding]
  );

  const chooseModel = useCallback(
    (category: "transcription" | "reasoning", selection: DisplayModel): void => {
      const policyScope = category === "transcription" ? "transcription" : "llm";
      if (
        !canChooseManagedLocalModel(
          selection.compatible,
          isModeAllowedByPolicy(usePolicyStore.getState(), policyScope, "local")
        )
      ) {
        return;
      }
      const latest =
        readManagedLocalModelBinding(identity.accountId, identity.workspaceId) ?? binding;
      const next = clearManagedLocalModelCategoryError(
        { ...latest, [category]: selection, configVersion: config.version, error: null },
        category
      );
      routeManagedLocalModelSetupChoice(ownsDownloads, isInstalled(selection), {
        persist: () => persistBinding(next),
        apply: () => {
          applySelection(category, selection);
        },
        download: () => {
          if (!applySelection(category, selection, false)) return;
          const kind = category === "reasoning" ? "assistant" : "dictation";
          rememberPendingLocalModel(kind, selection, identity);
          localStorage.setItem("localSetupPending", "true");
          const download =
            selection.provider === "whisper"
              ? whisperDownload
              : selection.provider === "nvidia"
                ? parakeetDownload
                : reasoningDownload;
          const attempt = { identity, category, selection };
          void download
            .downloadModel(
              selection.modelId,
              () => applySelection(category, selection),
              (error) => recordManagedLocalModelDownloadError(attempt, error)
            )
            .then((outcome) => {
              if (outcome === "busy-other") {
                forgetPendingLocalModel(kind, selection.modelId);
              }
            });
        },
      });
    },
    [
      applySelection,
      binding,
      config.version,
      identity,
      isInstalled,
      ownsDownloads,
      parakeetDownload,
      persistBinding,
      reasoningDownload,
      whisperDownload,
    ]
  );

  useEffect(() => {
    if (!ownsDownloads || binding.error) return;
    const transcriptionDownloadBusy =
      whisperDownload.isDownloading || parakeetDownload.isDownloading;
    const selectedTranscription = transcriptionModels.find((model) =>
      sameModel(binding.transcription, model)
    );
    if (
      selectedTranscription &&
      !binding.categoryErrors?.transcription &&
      isInventoryKnown(selectedTranscription) &&
      !isInstalled(selectedTranscription) &&
      !transcriptionDownloadBusy
    ) {
      chooseModel("transcription", selectedTranscription);
    }
    const selectedReasoning = reasoningModels.find((model) => sameModel(binding.reasoning, model));
    if (
      selectedReasoning &&
      !binding.categoryErrors?.reasoning &&
      isInventoryKnown(selectedReasoning) &&
      !isInstalled(selectedReasoning) &&
      !reasoningDownload.isDownloading
    ) {
      chooseModel("reasoning", selectedReasoning);
    }
  }, [
    binding,
    chooseModel,
    isDownloading,
    isInstalled,
    isInventoryKnown,
    ownsDownloads,
    reasoningModels,
    transcriptionModels,
    whisperDownload.isDownloading,
    parakeetDownload.isDownloading,
    reasoningDownload.isDownloading,
  ]);

  const retrySelections = useCallback((): void => {
    if (!ownsDownloads) {
      const latest =
        readManagedLocalModelBinding(identity.accountId, identity.workspaceId) ?? binding;
      persistBinding({
        ...latest,
        error: null,
        categoryErrors: {},
        retryGeneration: (latest.retryGeneration ?? 0) + 1,
      });
      return;
    }
    let restarted = false;
    const selectedTranscription = transcriptionModels.find((model) =>
      sameModel(binding.transcription, model)
    );
    const selectedReasoning = reasoningModels.find((model) => sameModel(binding.reasoning, model));
    if (selectedTranscription) {
      chooseModel("transcription", selectedTranscription);
      restarted = true;
    }
    if (selectedReasoning) {
      chooseModel("reasoning", selectedReasoning);
      restarted = true;
    }
    if (!restarted) persistBinding({ ...binding, error: null });
  }, [
    binding,
    chooseModel,
    identity.accountId,
    identity.workspaceId,
    ownsDownloads,
    persistBinding,
    reasoningModels,
    transcriptionModels,
  ]);

  const transcriptionReady =
    config.transcription.length === 0 ||
    Boolean(
      binding.transcription &&
      (isInstalled(binding.transcription) || isDownloading(binding.transcription))
    );
  const reasoningReady =
    config.reasoning.length === 0 ||
    Boolean(
      binding.reasoning && (isInstalled(binding.reasoning) || isDownloading(binding.reasoning))
    );
  const policyAllows =
    (config.transcription.length === 0 ||
      isModeAllowedByPolicy(policy, "transcription", "local")) &&
    (config.reasoning.length === 0 || isModeAllowedByPolicy(policy, "llm", "local"));
  const transcriptionPolicyAllows = isModeAllowedByPolicy(policy, "transcription", "local");
  const reasoningPolicyAllows = isModeAllowedByPolicy(policy, "llm", "local");
  const bindingError = getManagedLocalModelBindingError(binding);
  const ready = transcriptionReady && reasoningReady && policyAllows && !bindingError;

  useEffect(() => onReadinessChange(ready), [onReadinessChange, ready]);

  return (
    <div className="onboarding-shell-scroll mx-auto mt-5 w-full max-w-2xl space-y-5 overflow-y-auto pb-2">
      {!policyAllows && (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          {t("managedLocalModels.policy.allBlocked")}
        </div>
      )}
      {config.transcription.length > 0 && (
        <ModelCategory
          title={t("managedLocalModels.categories.transcriptionTitle")}
          description={t("managedLocalModels.categories.transcriptionDescription")}
          models={transcriptionModels}
          selected={binding.transcription}
          isInstalled={isInstalled}
          isDownloading={isDownloading}
          policyAllows={transcriptionPolicyAllows}
          onChoose={(model) => chooseModel("transcription", model)}
        />
      )}
      {config.reasoning.length > 0 && (
        <ModelCategory
          title={t("managedLocalModels.categories.reasoningTitle")}
          description={t("managedLocalModels.categories.reasoningDescription")}
          models={reasoningModels}
          selected={binding.reasoning}
          isInstalled={isInstalled}
          isDownloading={isDownloading}
          policyAllows={reasoningPolicyAllows}
          onChoose={(model) => chooseModel("reasoning", model)}
        />
      )}
      {bindingError && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
          <span>{translateManagedLocalModelError(bindingError, t)}</span>
          <Button variant="outline" size="sm" onClick={retrySelections}>
            <RotateCcw className="mr-1.5 size-3.5" /> {t("common.retry")}
          </Button>
        </div>
      )}
    </div>
  );
}

function ModelCategory({
  title,
  description,
  models,
  selected,
  isInstalled,
  isDownloading,
  policyAllows,
  onChoose,
}: {
  title: string;
  description: string;
  models: DisplayModel[];
  selected: ManagedEnterpriseLocalModelSelection | null;
  isInstalled: (model: ManagedEnterpriseLocalModelSelection) => boolean;
  isDownloading: (model: ManagedEnterpriseLocalModelSelection) => boolean;
  policyAllows: boolean;
  onChoose: (model: DisplayModel) => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <section className="rounded-2xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] p-4">
      <h2 className="text-sm font-semibold text-[var(--onboarding-text-primary)]">{title}</h2>
      <p className="mt-1 text-xs text-[var(--onboarding-text-secondary)]">{description}</p>
      <div className="mt-3 divide-y divide-[var(--onboarding-control-border)]">
        {models.map((model) => {
          const installed = isInstalled(model);
          const downloading = isDownloading(model);
          const active = sameModel(selected, model);
          return (
            <div
              key={`${model.provider}:${model.modelId}`}
              className="flex min-h-14 items-center gap-3 py-2"
            >
              <ProviderIcon
                provider={model.provider === "whisper" ? "openai" : model.provider}
                className="size-5"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-[var(--onboarding-text-primary)]">
                  {model.name}
                </p>
                <p className="truncate text-xs text-[var(--onboarding-text-secondary)]">
                  {model.size}
                  {model.compatibilityMessage ? ` · ${model.compatibilityMessage}` : ""}
                </p>
              </div>
              {downloading ? (
                <span className="flex items-center gap-1.5 text-xs text-[var(--onboarding-text-secondary)]">
                  <Loader2 className="size-3.5 animate-spin" />
                  {t("onboarding.rehaul.local.downloadingShort")}
                </span>
              ) : active && installed ? (
                <span className="flex items-center gap-1 text-xs font-medium text-[var(--onboarding-accent)]">
                  <Check className="size-3.5" /> {t("onboarding.rehaul.local.selected")}
                </span>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  disabled={!canChooseManagedLocalModel(model.compatible, policyAllows)}
                  onClick={() => onChoose(model)}
                  className="h-7 rounded-full px-3 text-xs"
                >
                  {installed ? (
                    <Check className="mr-1 size-3.5" />
                  ) : (
                    <Download className="mr-1 size-3.5" />
                  )}
                  {installed ? t("onboarding.rehaul.local.use") : t("common.download")}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
