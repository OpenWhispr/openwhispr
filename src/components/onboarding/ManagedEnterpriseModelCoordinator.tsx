import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle } from "lucide-react";
import { useModelDownload } from "../../hooks/useModelDownload";
import { modelRegistry } from "../../models/ModelRegistry";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { isAgentAllowed, isModeAllowedByPolicy } from "../../stores/policyRules";
import { usePolicyStore } from "../../stores/policyStore";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import {
  selectEffectiveManagedLocalModels,
  useEnterpriseIdentityStore,
} from "../../stores/enterpriseIdentityStore";
import type { ManagedEnterpriseLocalModelSelection } from "../../types/enterpriseIdentity";
import EnterpriseModelSetupStep from "./EnterpriseModelSetupStep";
import {
  EnterpriseConfigErrorActions,
  ManagedSetupFooterActions,
} from "./ManagedSetupBlockedActions";
import {
  applyManagedLocalModelSelectionWhenAllowed,
  beginManagedLocalModelReplacement,
  canAutomaticallyStartManagedLocalModelReplacement,
  clearManagedLocalModelCategoryError,
  createResolvedManagedLocalModelBinding,
  createManagedLocalModelRetryBinding,
  finishManagedLocalModelReplacement,
  getManagedLocalModelInventoryRetryDelay,
  getManagedLocalModelBindingError,
  isManagedLocalModelDownloadActive,
  isManagedLocalModelBindingSelectionCurrent,
  MANAGED_LOCAL_MODEL_ERROR_CODES,
  MANAGED_LOCAL_MODEL_BINDINGS_KEY,
  recordManagedLocalModelDownloadError,
  readManagedLocalModelBinding,
  requiresManagedLocalModels,
  recordPendingManagedLocalModelError,
  resolveManagedLocalModelSelection,
  resolveManagedLocalModelInventorySnapshot,
  resolveManagedLocalSetupReadiness,
  runWithManagedLocalModelReconciliationLock,
  setManagedLocalModelCategoryError,
  setManagedLocalModelBindingError,
  shouldRecoverManagedLocalModelFromInventory,
  updateManagedLocalSetupReadiness,
  translateManagedLocalModelError,
  writeManagedLocalModelBinding,
  type ManagedLocalModelBinding,
} from "./managedLocalModels";
import { forgetPendingLocalModel, rememberPendingLocalModel } from "./pendingLocalModels";
import {
  enforceManagedLocalModelSettings,
  reconcileManagedLocalModelSettings,
} from "./managedLocalModelSettings";

interface InstalledModels {
  whisper: Set<string>;
  parakeet: Set<string>;
  reasoning: Set<string>;
  downloadingWhisper: Set<string>;
  downloadingParakeet: Set<string>;
  downloadingReasoning: Set<string>;
  whisperKnown: boolean;
  parakeetKnown: boolean;
  reasoningKnown: boolean;
}

function emptyInstalledModels(): InstalledModels {
  return {
    whisper: new Set(),
    parakeet: new Set(),
    reasoning: new Set(),
    downloadingWhisper: new Set(),
    downloadingParakeet: new Set(),
    downloadingReasoning: new Set(),
    whisperKnown: false,
    parakeetKnown: false,
    reasoningKnown: false,
  };
}

function keepManagedSetupDialogOpen(_open: boolean): void {}

function preventManagedSetupDialogDismissal(event: Event): void {
  event.preventDefault();
}

export default function ManagedEnterpriseModelCoordinator({
  showUi = true,
}: {
  showUi?: boolean;
}): JSX.Element | null {
  const { t } = useTranslation();
  const accountId = useEnterpriseIdentityStore((state) => state.accountId);
  const workspaceId = useEnterpriseIdentityStore((state) => state.workspaceId);
  const authGeneration = useEnterpriseIdentityStore((state) => state.authGeneration);
  const config = useEnterpriseIdentityStore(selectEffectiveManagedLocalModels);
  const enterpriseStatus = useEnterpriseIdentityStore((state) => state.status);
  const enterpriseFailClosed = useEnterpriseIdentityStore((state) => state.failClosed);
  const authoritativeLocalModels = useEnterpriseIdentityStore(
    (state) => state.config?.localModels ?? null
  );
  const policy = usePolicySnapshot();
  const [installed, setInstalled] = useState<InstalledModels>(emptyInstalledModels);
  const [inventoryReady, setInventoryReady] = useState(false);
  const [inventoryRefreshAttempts, setInventoryRefreshAttempts] = useState(0);
  const [resolvedParakeetCapability, setResolvedParakeetCapability] = useState<{
    identityKey: string;
    supported: boolean | null;
  } | null>(null);
  const [focusedReadiness, setFocusedReadiness] = useState({
    identityKey: "",
    ready: false,
  });
  const [dismissedIdentity, setDismissedIdentity] = useState<string | null>(null);
  const [, setBindingRevision] = useState(0);
  const [ownsReconciliation, setOwnsReconciliation] = useState(false);
  const ownsReconciliationRef = useRef(false);
  const startedReplacements = useRef(new Set<string>());
  const seenRetryGeneration = useRef<number | null>(null);
  const appliedSelectionKeys = useRef<{
    transcription: string | null;
    reasoning: string | null;
  }>({ transcription: null, reasoning: null });
  const completed = localStorage.getItem("onboardingCompleted") === "true";
  const capabilityIdentityKey = `${accountId ?? ""}:${workspaceId ?? ""}:${authGeneration ?? ""}`;
  const parakeetSupported =
    resolvedParakeetCapability?.identityKey === capabilityIdentityKey
      ? resolvedParakeetCapability.supported
      : null;

  const refreshInstalled = useCallback(async (): Promise<void> => {
    const [whisper, parakeet, reasoning] = await Promise.all([
      window.electronAPI?.listWhisperModels?.().catch(() => undefined),
      window.electronAPI?.listParakeetModels?.().catch(() => undefined),
      window.electronAPI?.modelGetAll?.().catch(() => undefined),
    ]);
    setInstalled((current) => {
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
        downloadingWhisper:
          whisper === undefined
            ? current.downloadingWhisper
            : new Set(
                whisper.models.filter((model) => model.isDownloading).map((model) => model.model)
              ),
        downloadingParakeet:
          parakeet === undefined
            ? current.downloadingParakeet
            : new Set(
                parakeet.models.filter((model) => model.isDownloading).map((model) => model.model)
              ),
        downloadingReasoning:
          reasoning === undefined
            ? current.downloadingReasoning
            : new Set(reasoning.filter((model) => model.isDownloading).map((model) => model.id)),
        whisperKnown: whisperInstalled.known,
        parakeetKnown: parakeetInstalled.known,
        reasoningKnown: reasoningInstalled.known,
      };
    });
    setInventoryReady(true);
    setInventoryRefreshAttempts((attempts) => attempts + 1);
  }, []);
  const whisperDownload = useModelDownload({
    modelType: "whisper",
    onDownloadComplete: refreshInstalled,
    onTerminalError: (modelId, error) => {
      if (ownsReconciliationRef.current) {
        recordPendingManagedLocalModelError("dictation", modelId, error);
      }
    },
  });
  const parakeetDownload = useModelDownload({
    modelType: "parakeet",
    onDownloadComplete: refreshInstalled,
    onTerminalError: (modelId, error) => {
      if (ownsReconciliationRef.current) {
        recordPendingManagedLocalModelError("dictation", modelId, error);
      }
    },
  });
  const reasoningDownload = useModelDownload({
    modelType: "llm",
    onDownloadComplete: refreshInstalled,
    onTerminalError: (modelId, error) => {
      if (ownsReconciliationRef.current) {
        recordPendingManagedLocalModelError("assistant", modelId, error);
      }
    },
  });

  useEffect(() => {
    let mounted = true;
    let release: (() => void) | null = null;
    void runWithManagedLocalModelReconciliationLock(async () => {
      if (!mounted) return;
      ownsReconciliationRef.current = true;
      setOwnsReconciliation(true);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }).finally(() => {
      ownsReconciliationRef.current = false;
      if (mounted) setOwnsReconciliation(false);
    });
    return () => {
      mounted = false;
      ownsReconciliationRef.current = false;
      release?.();
    };
  }, []);

  useEffect(() => {
    reconcileManagedLocalModelSettings({
      ownsReconciliation,
      status: enterpriseStatus,
      failClosed: enterpriseFailClosed,
      localModels: authoritativeLocalModels,
    });
  }, [authoritativeLocalModels, enterpriseFailClosed, enterpriseStatus, ownsReconciliation]);

  useEffect(() => {
    setInventoryReady(false);
    setInventoryRefreshAttempts(0);
    void refreshInstalled();
  }, [accountId, completed, refreshInstalled, workspaceId]);

  useEffect(() => {
    if (!inventoryReady || !config) return;
    const transcriptionUnknown = config.transcription.some((selection) =>
      selection.provider === "whisper" ? !installed.whisperKnown : !installed.parakeetKnown
    );
    const reasoningUnknown = config.reasoning.length > 0 && !installed.reasoningKnown;
    if (!transcriptionUnknown && !reasoningUnknown) {
      if (inventoryRefreshAttempts !== 0) setInventoryRefreshAttempts(0);
      return;
    }
    const delay = getManagedLocalModelInventoryRetryDelay(inventoryRefreshAttempts);
    if (delay === null) return;
    const timer = window.setTimeout(() => void refreshInstalled(), delay);
    return () => window.clearTimeout(timer);
  }, [config, installed, inventoryReady, inventoryRefreshAttempts, refreshInstalled]);

  useEffect(() => {
    let cancelled = false;
    setResolvedParakeetCapability(null);
    void window.electronAPI
      ?.checkParakeetInstallation?.()
      .then((result) => {
        if (!cancelled) {
          setResolvedParakeetCapability({
            identityKey: capabilityIdentityKey,
            supported: result.supported !== false,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolvedParakeetCapability({
            identityKey: capabilityIdentityKey,
            supported: null,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [capabilityIdentityKey]);

  useEffect(() => {
    const refresh = (): void => setBindingRevision((revision) => revision + 1);
    const refreshFromStorage = (event: StorageEvent): void => {
      if (event.key === MANAGED_LOCAL_MODEL_BINDINGS_KEY || event.key === "onboardingCompleted") {
        refresh();
      }
    };
    window.addEventListener("openwhispr-managed-local-model-binding", refresh);
    window.addEventListener("storage", refreshFromStorage);
    return () => {
      window.removeEventListener("openwhispr-managed-local-model-binding", refresh);
      window.removeEventListener("storage", refreshFromStorage);
    };
  }, []);

  const binding =
    accountId && workspaceId ? readManagedLocalModelBinding(accountId, workspaceId) : null;
  const bindingError = getManagedLocalModelBindingError(binding);
  const identityKey = `${accountId ?? ""}:${workspaceId ?? ""}:${authGeneration ?? ""}:${config?.version ?? 0}`;
  const focusedReady = resolveManagedLocalSetupReadiness(focusedReadiness, identityKey);
  const handleFocusedReadinessChange = useCallback(
    (ready: boolean): void => {
      setFocusedReadiness((current) =>
        updateManagedLocalSetupReadiness(current, identityKey, ready)
      );
    },
    [identityKey]
  );
  const needsFocusedSetup = Boolean(
    showUi &&
    completed &&
    accountId &&
    workspaceId &&
    authGeneration != null &&
    requiresManagedLocalModels(config) &&
    (!binding ||
      (config?.transcription.length && !binding.transcription) ||
      (config?.reasoning.length && !binding.reasoning)) &&
    dismissedIdentity !== identityKey
  );

  useEffect(() => {
    const retryGeneration = binding?.retryGeneration ?? 0;
    if (seenRetryGeneration.current === null) {
      seenRetryGeneration.current = retryGeneration;
      return;
    }
    if (seenRetryGeneration.current === retryGeneration) return;
    seenRetryGeneration.current = retryGeneration;
    startedReplacements.current.clear();
  }, [binding?.retryGeneration]);

  const isInstalled = useCallback(
    (selection: ManagedEnterpriseLocalModelSelection): boolean => {
      if (selection.provider === "whisper") return installed.whisper.has(selection.modelId);
      if (selection.provider === "nvidia") return installed.parakeet.has(selection.modelId);
      return installed.reasoning.has(selection.modelId);
    },
    [installed]
  );
  const isDownloading = useCallback(
    (selection: ManagedEnterpriseLocalModelSelection): boolean => {
      if (selection.provider === "whisper") {
        return isManagedLocalModelDownloadActive(
          whisperDownload.isDownloadingModel(selection.modelId),
          installed.downloadingWhisper.has(selection.modelId)
        );
      }
      if (selection.provider === "nvidia") {
        return isManagedLocalModelDownloadActive(
          parakeetDownload.isDownloadingModel(selection.modelId),
          installed.downloadingParakeet.has(selection.modelId)
        );
      }
      return isManagedLocalModelDownloadActive(
        reasoningDownload.isDownloadingModel(selection.modelId),
        installed.downloadingReasoning.has(selection.modelId)
      );
    },
    [installed, parakeetDownload, reasoningDownload, whisperDownload]
  );
  const isInventoryKnown = useCallback(
    (selection: ManagedEnterpriseLocalModelSelection): boolean => {
      if (selection.provider === "whisper") return installed.whisperKnown;
      if (selection.provider === "nvidia") return installed.parakeetKnown;
      return installed.reasoningKnown;
    },
    [installed.parakeetKnown, installed.reasoningKnown, installed.whisperKnown]
  );
  const isDownloadEngineBusy = useCallback(
    (selection: ManagedEnterpriseLocalModelSelection): boolean => {
      if (selection.provider === "whisper") {
        return whisperDownload.isDownloading || installed.downloadingWhisper.size > 0;
      }
      if (selection.provider === "nvidia") {
        return parakeetDownload.isDownloading || installed.downloadingParakeet.size > 0;
      }
      return reasoningDownload.isDownloading || installed.downloadingReasoning.size > 0;
    },
    [
      installed,
      parakeetDownload.isDownloading,
      reasoningDownload.isDownloading,
      whisperDownload.isDownloading,
    ]
  );

  const applySelection = useCallback(
    (
      category: "transcription" | "reasoning",
      selection: ManagedEnterpriseLocalModelSelection,
      complete = true
    ): boolean => {
      const enterprise = useEnterpriseIdentityStore.getState();
      const currentConfig = selectEffectiveManagedLocalModels(enterprise);
      const currentBinding =
        accountId && workspaceId ? readManagedLocalModelBinding(accountId, workspaceId) : null;
      const approved =
        category === "transcription" ? currentConfig?.transcription : currentConfig?.reasoning;
      if (
        enterprise.accountId !== accountId ||
        enterprise.workspaceId !== workspaceId ||
        enterprise.authGeneration !== authGeneration ||
        currentConfig?.version !== config?.version ||
        !isManagedLocalModelBindingSelectionCurrent(
          currentBinding,
          currentConfig?.version ?? -1,
          category,
          selection
        ) ||
        !approved ||
        !approved.some(
          (model) => model.provider === selection.provider && model.modelId === selection.modelId
        )
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
          setManagedLocalModelCategoryError(
            accountId,
            workspaceId,
            currentConfig.version,
            category,
            null
          );
          forgetPendingLocalModel(
            category === "reasoning" ? "assistant" : "dictation",
            selection.modelId
          );
          finishManagedLocalModelReplacement(
            startedReplacements.current,
            `${identityKey}:${category}:${selection.provider}:${selection.modelId}`
          );
        },
        () => {
          setManagedLocalModelBindingError(
            accountId,
            workspaceId,
            currentConfig.version,
            category === "transcription"
              ? MANAGED_LOCAL_MODEL_ERROR_CODES.policyTranscription
              : MANAGED_LOCAL_MODEL_ERROR_CODES.policyReasoning
          );
        }
      );
    },
    [accountId, authGeneration, config?.version, identityKey, workspaceId]
  );

  const compatibleTranscription = useMemo(
    () =>
      config?.transcription.filter(
        (model) => model.provider !== "nvidia" || parakeetSupported === true
      ) ?? [],
    [config?.transcription, parakeetSupported]
  );
  const compatibleReasoning = useMemo(
    () =>
      config?.reasoning.filter(
        (selection) => modelRegistry.getModel(selection.modelId)?.provider.id === selection.provider
      ) ?? [],
    [config?.reasoning]
  );
  const localPolicyError = useMemo((): string | null => {
    if (config?.transcription.length && !isModeAllowedByPolicy(policy, "transcription", "local")) {
      return MANAGED_LOCAL_MODEL_ERROR_CODES.policyTranscription;
    }
    if (config?.reasoning.length && !isModeAllowedByPolicy(policy, "llm", "local")) {
      return MANAGED_LOCAL_MODEL_ERROR_CODES.policyReasoning;
    }
    return null;
  }, [config?.reasoning.length, config?.transcription.length, policy]);

  const startReplacement = useCallback(
    (
      category: "transcription" | "reasoning",
      selection: ManagedEnterpriseLocalModelSelection,
      nextBinding: ManagedLocalModelBinding
    ): void => {
      if (!accountId || !workspaceId || authGeneration == null || !config) return;
      const replacementKey = `${identityKey}:${category}:${selection.provider}:${selection.modelId}`;
      if (!beginManagedLocalModelReplacement(startedReplacements.current, replacementKey)) return;
      writeManagedLocalModelBinding(
        accountId,
        workspaceId,
        clearManagedLocalModelCategoryError(nextBinding, category)
      );
      if (isInstalled(selection)) {
        applySelection(category, selection);
        return;
      }
      if (!applySelection(category, selection, false)) {
        finishManagedLocalModelReplacement(startedReplacements.current, replacementKey);
        return;
      }
      const identity = {
        accountId,
        workspaceId,
        authGeneration,
        configVersion: config.version,
      };
      rememberPendingLocalModel(
        category === "reasoning" ? "assistant" : "dictation",
        selection,
        identity
      );
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
          () => {
            if (ownsReconciliationRef.current) applySelection(category, selection);
          },
          (error) => {
            if (ownsReconciliationRef.current) {
              recordManagedLocalModelDownloadError(attempt, error);
            }
          }
        )
        .then((outcome) => {
          if (outcome !== "busy-other" || !ownsReconciliationRef.current) return;
          forgetPendingLocalModel(
            category === "reasoning" ? "assistant" : "dictation",
            selection.modelId
          );
          finishManagedLocalModelReplacement(startedReplacements.current, replacementKey);
        });
    },
    [
      accountId,
      applySelection,
      authGeneration,
      config,
      identityKey,
      isInstalled,
      parakeetDownload,
      reasoningDownload,
      whisperDownload,
      workspaceId,
    ]
  );

  useEffect(() => {
    if (
      !ownsReconciliation ||
      !completed ||
      !inventoryReady ||
      !whisperDownload.hasHydratedDownloads ||
      !parakeetDownload.hasHydratedDownloads ||
      !reasoningDownload.hasHydratedDownloads ||
      !accountId ||
      !workspaceId ||
      authGeneration == null ||
      !config ||
      !binding
    ) {
      return;
    }
    if (
      parakeetSupported === null &&
      config.transcription.some((selection) => selection.provider === "nvidia")
    ) {
      return;
    }
    if (localPolicyError) {
      if (binding.configVersion !== config.version || binding.error !== localPolicyError) {
        writeManagedLocalModelBinding(accountId, workspaceId, {
          ...binding,
          configVersion: config.version,
          error: localPolicyError,
        });
      }
      return;
    }
    const transcription = resolveManagedLocalModelSelection(
      compatibleTranscription,
      binding.transcription
    );
    const reasoning = resolveManagedLocalModelSelection(compatibleReasoning, binding.reasoning);
    if (config.transcription.length > 0 && !transcription) {
      const error = MANAGED_LOCAL_MODEL_ERROR_CODES.incompatibleTranscription;
      if (
        binding.configVersion !== config.version ||
        binding.transcription !== null ||
        binding.reasoning?.provider !== reasoning?.provider ||
        binding.reasoning?.modelId !== reasoning?.modelId ||
        binding.error !== error
      ) {
        writeManagedLocalModelBinding(accountId, workspaceId, {
          configVersion: config.version,
          transcription: null,
          reasoning,
          error,
        });
      }
      return;
    }
    if (config.reasoning.length > 0 && !reasoning) {
      const error = MANAGED_LOCAL_MODEL_ERROR_CODES.incompatibleReasoning;
      if (
        binding.configVersion !== config.version ||
        binding.transcription?.provider !== transcription?.provider ||
        binding.transcription?.modelId !== transcription?.modelId ||
        binding.reasoning !== null ||
        binding.error !== error
      ) {
        writeManagedLocalModelBinding(accountId, workspaceId, {
          configVersion: config.version,
          transcription,
          reasoning: null,
          error,
        });
      }
      return;
    }
    const next = createResolvedManagedLocalModelBinding(
      binding,
      config.version,
      transcription,
      reasoning
    );
    const transcriptionChanged =
      transcription?.provider !== binding.transcription?.provider ||
      transcription?.modelId !== binding.transcription?.modelId;
    const reasoningChanged =
      reasoning?.provider !== binding.reasoning?.provider ||
      reasoning?.modelId !== binding.reasoning?.modelId;
    if (transcription && !transcriptionChanged) {
      applySelection("transcription", transcription, false);
    }
    if (reasoning && !reasoningChanged) {
      applySelection("reasoning", reasoning, false);
    }
    if (transcription && !transcriptionChanged && isInstalled(transcription)) {
      const selectionKey = `${identityKey}:transcription:${transcription.provider}:${transcription.modelId}`;
      if (appliedSelectionKeys.current.transcription !== selectionKey) {
        if (applySelection("transcription", transcription)) {
          appliedSelectionKeys.current.transcription = selectionKey;
        }
      }
    }
    if (reasoning && !reasoningChanged && isInstalled(reasoning)) {
      const selectionKey = `${identityKey}:reasoning:${reasoning.provider}:${reasoning.modelId}`;
      if (appliedSelectionKeys.current.reasoning !== selectionKey) {
        if (applySelection("reasoning", reasoning)) {
          appliedSelectionKeys.current.reasoning = selectionKey;
        }
      }
    }
    const transcriptionInventoryKnown = Boolean(transcription && isInventoryKnown(transcription));
    const reasoningInventoryKnown = Boolean(reasoning && isInventoryKnown(reasoning));
    const transcriptionNeedsRecovery = shouldRecoverManagedLocalModelFromInventory(
      transcription,
      transcriptionInventoryKnown,
      Boolean(transcription && isInstalled(transcription)),
      Boolean(transcription && isDownloading(transcription))
    );
    const reasoningNeedsRecovery = shouldRecoverManagedLocalModelFromInventory(
      reasoning,
      reasoningInventoryKnown,
      Boolean(reasoning && isInstalled(reasoning)),
      Boolean(reasoning && isDownloading(reasoning))
    );
    const transcriptionIsActive = Boolean(transcription && isDownloading(transcription));
    const reasoningIsActive = Boolean(reasoning && isDownloading(reasoning));
    const transcriptionBusyOther = Boolean(
      transcription && isDownloadEngineBusy(transcription) && !transcriptionIsActive
    );
    const reasoningBusyOther = Boolean(
      reasoning && isDownloadEngineBusy(reasoning) && !reasoningIsActive
    );
    if (
      transcription &&
      transcriptionInventoryKnown &&
      !transcriptionBusyOther &&
      canAutomaticallyStartManagedLocalModelReplacement(
        transcriptionChanged || transcriptionNeedsRecovery || transcriptionIsActive,
        next.categoryErrors?.transcription
      )
    ) {
      startReplacement("transcription", transcription, next);
    }
    if (
      reasoning &&
      reasoningInventoryKnown &&
      !reasoningBusyOther &&
      canAutomaticallyStartManagedLocalModelReplacement(
        reasoningChanged || reasoningNeedsRecovery || reasoningIsActive,
        next.categoryErrors?.reasoning
      )
    ) {
      startReplacement("reasoning", reasoning, next);
    }
    if (
      ((transcriptionChanged || transcriptionNeedsRecovery) && transcription) ||
      ((reasoningChanged || reasoningNeedsRecovery) && reasoning)
    ) {
      return;
    }
    if (binding.configVersion !== config.version || binding.error) {
      writeManagedLocalModelBinding(accountId, workspaceId, next);
    }
  }, [
    accountId,
    applySelection,
    authGeneration,
    binding,
    compatibleReasoning,
    compatibleTranscription,
    completed,
    config,
    identityKey,
    inventoryReady,
    isDownloading,
    isDownloadEngineBusy,
    isInstalled,
    isInventoryKnown,
    localPolicyError,
    ownsReconciliation,
    parakeetSupported,
    parakeetDownload,
    reasoningDownload,
    startReplacement,
    whisperDownload,
    workspaceId,
  ]);

  if (!showUi || !completed || !config || !accountId || !workspaceId || authGeneration == null) {
    return null;
  }

  if (bindingError && !needsFocusedSetup) {
    return (
      <aside className="fixed bottom-5 right-7 z-[55] w-[360px] rounded-xl border border-destructive/20 bg-card p-4 shadow-lg">
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{t("managedLocalModels.attention.title")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {translateManagedLocalModelError(bindingError, t)}
            </p>
            <div className="mt-3">
              <EnterpriseConfigErrorActions
                onRetry={() => {
                  if (!binding) return;
                  writeManagedLocalModelBinding(
                    accountId,
                    workspaceId,
                    createManagedLocalModelRetryBinding(binding)
                  );
                }}
              />
            </div>
          </div>
        </div>
      </aside>
    );
  }

  if (!needsFocusedSetup) return null;
  return (
    <Dialog open={needsFocusedSetup} onOpenChange={keepManagedSetupDialogOpen}>
      <DialogContent
        overlayClassName="bg-black/35! backdrop-blur-none!"
        className="flex max-h-[90vh] w-full max-w-3xl flex-col gap-0 overflow-hidden rounded-2xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] p-6 shadow-2xl [&>button]:hidden"
        onEscapeKeyDown={preventManagedSetupDialogDismissal}
        onFocusOutside={preventManagedSetupDialogDismissal}
        onPointerDownOutside={preventManagedSetupDialogDismissal}
      >
        <div className="text-center">
          <DialogTitle className="text-xl font-semibold text-[var(--onboarding-text-primary)]">
            {t("managedLocalModels.workspaceSetup.title")}
          </DialogTitle>
          <DialogDescription className="mt-2 text-sm text-[var(--onboarding-text-secondary)]">
            {t("managedLocalModels.workspaceSetup.description")}
          </DialogDescription>
        </div>
        <EnterpriseModelSetupStep
          key={identityKey}
          identity={{ accountId, workspaceId, authGeneration, configVersion: config.version }}
          config={config}
          ownsDownloads={false}
          onReadinessChange={handleFocusedReadinessChange}
        />
        <ManagedSetupFooterActions
          ready={focusedReady}
          onContinue={() => setDismissedIdentity(identityKey)}
        />
      </DialogContent>
    </Dialog>
  );
}
