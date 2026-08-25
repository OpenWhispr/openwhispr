import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { signOut } from "../../lib/auth";
import {
  getParakeetModelInfo,
  getWhisperModelInfo,
  modelRegistry,
} from "../../models/ModelRegistry";
import { useEnterpriseIdentityStore } from "../../stores/enterpriseIdentityStore";
import type { ManagedEnterpriseLocalModelSelection } from "../../types/enterpriseIdentity";
import { useManagedLocalModelLock } from "../../hooks/useManagedLocalModelLock";
import { useModelDownload, type ModelType } from "../../hooks/useModelDownload";
import EnterpriseModelSetupStep, { type ManagedSetupDisplayRow } from "./EnterpriseModelSetupStep";
import {
  isCurrentManagedLocalModelBinding,
  managedLocalModelCategory,
  managedLocalModelSelectionKey,
  planManagedLocalModelReconciliation,
  readManagedLocalModelBinding,
  rememberManagedLocalModelBinding,
  type ManagedLocalModelAvailability,
  type ManagedLocalModelCategory,
  type ManagedLocalModelIdentity,
  type ManagedLocalNvidiaCapability,
} from "./managedLocalModels";
import {
  PENDING_LOCAL_MODELS_KEY,
  consumeManagedPendingLocalModel,
  readManagedPendingLocalModel,
  rememberManagedPendingLocalModel,
  type ManagedPendingLocalModelSelection,
} from "./pendingLocalModels";

interface ManagedInventory {
  availability: Record<string, ManagedLocalModelAvailability | undefined>;
  nvidiaCapability: ManagedLocalNvidiaCapability;
}

interface ManagedTransferRequest {
  key: string;
  identity: ManagedLocalModelIdentity;
  provider: string;
  model: string;
}

export interface ManagedEnterpriseModelCoordinatorProps {
  surface: "onboarding" | "background";
  showUi: boolean;
  onReadinessChange?: (ready: boolean) => void;
}

const EMPTY_INVENTORY: ManagedInventory = { availability: {}, nvidiaCapability: "unknown" };

function sameIdentity(left: ManagedLocalModelIdentity, right: ManagedLocalModelIdentity): boolean {
  return (
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.authGeneration === right.authGeneration &&
    left.configGeneration === right.configGeneration
  );
}

function identityKey(identity: ManagedLocalModelIdentity): string {
  return `${identity.accountId}:${identity.workspaceId}:${identity.authGeneration}:${identity.configGeneration}`;
}

function managedContextKey(context: {
  identity: ManagedLocalModelIdentity;
  localModels: { selections: ManagedEnterpriseLocalModelSelection[] };
}): string {
  const selections = context.localModels.selections
    .map((selection) => `${selection.provider}:${selection.model}`)
    .join(",");
  return `${identityKey(context.identity)}:${selections}`;
}

function pendingSelection(
  identity: ManagedLocalModelIdentity,
  selection: ManagedEnterpriseLocalModelSelection,
  transferState: ManagedPendingLocalModelSelection["transferState"]
): ManagedPendingLocalModelSelection {
  return {
    ...identity,
    provider: selection.provider,
    modelId: selection.model,
    transferState,
  };
}

function displayDetails(selection: ManagedEnterpriseLocalModelSelection): {
  label: string;
  size?: string;
} {
  if (selection.provider === "whisper") {
    const model = getWhisperModelInfo(selection.model);
    return { label: model?.name ?? selection.model, size: model?.size };
  }
  if (selection.provider === "nvidia") {
    const model = getParakeetModelInfo(selection.model);
    return { label: model?.name ?? selection.model, size: model?.size };
  }
  const registered = modelRegistry.getModel(selection.model);
  return { label: registered?.model.name ?? selection.model, size: registered?.model.size };
}

function modelType(selection: ManagedEnterpriseLocalModelSelection): ModelType {
  if (selection.provider === "whisper") return "whisper";
  if (selection.provider === "nvidia") return "parakeet";
  return "llm";
}

export default function ManagedEnterpriseModelCoordinator({
  surface,
  showUi,
  onReadinessChange,
}: ManagedEnterpriseModelCoordinatorProps): JSX.Element | null {
  const { t } = useTranslation();
  const accountId = useEnterpriseIdentityStore((state) => state.accountId);
  const workspaceId = useEnterpriseIdentityStore((state) => state.workspaceId);
  const authGeneration = useEnterpriseIdentityStore((state) => state.authGeneration);
  const enterpriseConfig = useEnterpriseIdentityStore((state) => state.config);
  const enterpriseStatus = useEnterpriseIdentityStore((state) => state.status);
  const refreshEnterprise = useEnterpriseIdentityStore((state) => state.refresh);
  const context = useMemo(() => {
    if (
      enterpriseStatus !== "ready" ||
      !accountId ||
      !workspaceId ||
      authGeneration == null ||
      !enterpriseConfig?.localModels
    ) {
      return null;
    }
    return {
      identity: {
        accountId,
        workspaceId,
        authGeneration,
        configGeneration: enterpriseConfig.generation,
      },
      localModels: enterpriseConfig.localModels,
    };
  }, [accountId, authGeneration, enterpriseConfig, enterpriseStatus, workspaceId]);
  const [inventory, setInventory] = useState<ManagedInventory>(EMPTY_INVENTORY);
  const [categoryErrors, setCategoryErrors] = useState<
    Partial<Record<ManagedLocalModelCategory, string>>
  >({});
  const [bindingRevision, setBindingRevision] = useState(0);
  const [pendingRevision, setPendingRevision] = useState(0);
  const [reconciling, setReconciling] = useState(false);
  const [yielded, setYielded] = useState(false);
  const contextRef = useRef(context);
  const inFlight = useRef<Partial<Record<ManagedLocalModelCategory, ManagedTransferRequest>>>({});
  const reconcileRef = useRef<() => Promise<void>>(async () => {});
  const reconciledContextRef = useRef<string | null>(null);
  const ownsLockRef = useRef(false);
  contextRef.current = context;
  const yieldHeadlessOwner = useCallback((): void => {
    if (surface === "background" && !showUi) setYielded(true);
  }, [showUi, surface]);

  const refreshInventory = useCallback(async (): Promise<ManagedInventory> => {
    const current = contextRef.current;
    const hasNvidia = current?.localModels.selections.some(
      (selection) => selection.provider === "nvidia"
    );
    const [whisper, parakeet, llm, capability] = await Promise.all([
      window.electronAPI?.listWhisperModels?.().catch(() => undefined),
      window.electronAPI?.listParakeetModels?.().catch(() => undefined),
      window.electronAPI?.modelGetAll?.().catch(() => undefined),
      hasNvidia
        ? window.electronAPI?.checkParakeetInstallation?.().catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    const availability: ManagedInventory["availability"] = {};
    for (const model of whisper?.models ?? []) {
      availability[`whisper:${model.model}`] = model.downloaded
        ? "installed"
        : model.isDownloading
          ? "downloading"
          : "missing";
    }
    for (const model of parakeet?.models ?? []) {
      availability[`nvidia:${model.model}`] = model.downloaded
        ? "installed"
        : model.isDownloading
          ? "downloading"
          : "missing";
    }
    for (const model of llm ?? []) {
      const provider = model.providerId ?? modelRegistry.getModel(model.id)?.provider.id;
      if (provider) {
        availability[`${provider}:${model.id}`] = model.isDownloaded
          ? "installed"
          : model.isDownloading
            ? "downloading"
            : "missing";
      }
    }
    const next = {
      availability,
      nvidiaCapability: !hasNvidia
        ? ("supported" as const)
        : capability === undefined
          ? ("unknown" as const)
          : capability.supported
            ? ("supported" as const)
            : ("unsupported" as const),
    };
    if (
      current &&
      contextRef.current &&
      sameIdentity(current.identity, contextRef.current.identity)
    ) {
      setInventory(next);
    }
    return next;
  }, []);

  const handleDownloadComplete = useCallback((): void => {
    void reconcileRef.current();
  }, []);
  const recordTransferError = useCallback(
    (
      category: ManagedLocalModelCategory,
      provider: string,
      model: string,
      errorCode: ManagedPendingLocalModelSelection["errorCode"]
    ): void => {
      const current = contextRef.current;
      const request = inFlight.current[category];
      if (
        !current ||
        !request ||
        request.provider !== provider ||
        request.model !== model ||
        !sameIdentity(request.identity, current.identity)
      ) {
        return;
      }
      const expected = pendingSelection(
        request.identity,
        { provider: request.provider, model: request.model },
        "downloading"
      );
      const pending = readManagedPendingLocalModel(category, expected);
      if (!pending) return;
      rememberManagedPendingLocalModel(category, {
        ...pending,
        transferState: "missing",
        errorCode,
      });
      setCategoryErrors((errors) => ({
        ...errors,
        [category]: `onboarding.managedLocal.errors.${
          errorCode === "DOWNLOAD_CANCELLED" ? "cancelled" : "downloadFailed"
        }`,
      }));
    },
    []
  );
  const handleWhisperError = useCallback(
    (model: string): void => recordTransferError("dictation", "whisper", model, "DOWNLOAD_FAILED"),
    [recordTransferError]
  );
  const handleWhisperCancellation = useCallback(
    (model: string): void =>
      recordTransferError("dictation", "whisper", model, "DOWNLOAD_CANCELLED"),
    [recordTransferError]
  );
  const handleParakeetError = useCallback(
    (model: string): void => recordTransferError("dictation", "nvidia", model, "DOWNLOAD_FAILED"),
    [recordTransferError]
  );
  const handleParakeetCancellation = useCallback(
    (model: string): void =>
      recordTransferError("dictation", "nvidia", model, "DOWNLOAD_CANCELLED"),
    [recordTransferError]
  );
  const recordAssistantTransferError = useCallback(
    (model: string, errorCode: ManagedPendingLocalModelSelection["errorCode"]): void => {
      const provider = contextRef.current?.localModels.selections.find(
        (selection) =>
          selection.model === model && managedLocalModelCategory(selection) === "assistant"
      )?.provider;
      if (provider) recordTransferError("assistant", provider, model, errorCode);
    },
    [recordTransferError]
  );
  const handleAssistantError = useCallback(
    (model: string): void => recordAssistantTransferError(model, "DOWNLOAD_FAILED"),
    [recordAssistantTransferError]
  );
  const handleAssistantCancellation = useCallback(
    (model: string): void => recordAssistantTransferError(model, "DOWNLOAD_CANCELLED"),
    [recordAssistantTransferError]
  );
  const whisperDownload = useModelDownload({
    modelType: "whisper",
    onDownloadComplete: handleDownloadComplete,
    onTerminalError: handleWhisperError,
    onDownloadCancelled: handleWhisperCancellation,
  });
  const parakeetDownload = useModelDownload({
    modelType: "parakeet",
    onDownloadComplete: handleDownloadComplete,
    onTerminalError: handleParakeetError,
    onDownloadCancelled: handleParakeetCancellation,
  });
  const llmDownload = useModelDownload({
    modelType: "llm",
    onDownloadComplete: handleDownloadComplete,
    onTerminalError: handleAssistantError,
    onDownloadCancelled: handleAssistantCancellation,
  });
  const downloadsRef = useRef({
    whisper: whisperDownload,
    parakeet: parakeetDownload,
    llm: llmDownload,
  });
  downloadsRef.current = { whisper: whisperDownload, parakeet: parakeetDownload, llm: llmDownload };

  const downloadFor = useCallback((selection: ManagedEnterpriseLocalModelSelection) => {
    const type = modelType(selection);
    return downloadsRef.current[type];
  }, []);

  const reconcile = useCallback(async (): Promise<void> => {
    const expectedContext = contextRef.current;
    if (!expectedContext) return;
    reconciledContextRef.current = managedContextKey(expectedContext);
    setReconciling(true);
    try {
      const snapshot = await refreshInventory();
      const currentContext = contextRef.current;
      if (!currentContext || !sameIdentity(expectedContext.identity, currentContext.identity))
        return;

      for (const category of ["dictation", "assistant"] as const) {
        const approved = expectedContext.localModels.selections.filter(
          (selection) => managedLocalModelCategory(selection) === category
        );
        if (approved.length === 0) {
          setCategoryErrors((errors) => ({ ...errors, [category]: undefined }));
          continue;
        }
        const persistedError = approved
          .map((selection) =>
            readManagedPendingLocalModel(
              category,
              pendingSelection(expectedContext.identity, selection, "missing")
            )
          )
          .find((pending) => pending?.errorCode)?.errorCode;
        if (persistedError) {
          setCategoryErrors((errors) => ({
            ...errors,
            [category]: `onboarding.managedLocal.errors.${
              persistedError === "DOWNLOAD_CANCELLED" ? "cancelled" : "downloadFailed"
            }`,
          }));
          yieldHeadlessOwner();
          continue;
        }
        const plan = planManagedLocalModelReconciliation({
          identity: expectedContext.identity,
          category,
          approvedSelections: approved,
          availability: snapshot.availability,
          nvidiaCapability: snapshot.nvidiaCapability,
          binding: readManagedLocalModelBinding(expectedContext.identity, category),
        });
        if (plan.kind === "pause") {
          setCategoryErrors((errors) => ({
            ...errors,
            [category]: "onboarding.managedLocal.errors.capabilityCheck",
          }));
          yieldHeadlessOwner();
          continue;
        }
        if (plan.kind === "error") {
          setCategoryErrors((errors) => ({ ...errors, [category]: plan.messageKey }));
          yieldHeadlessOwner();
          continue;
        }

        const expectedBinding = {
          ...expectedContext.identity,
          category,
          provider: plan.selection.provider,
          model: plan.selection.model,
        };
        if (plan.persistBinding) rememberManagedLocalModelBinding(expectedBinding);
        setBindingRevision((revision) => revision + 1);
        setCategoryErrors((errors) => ({ ...errors, [category]: undefined }));

        const exactPending = pendingSelection(
          expectedContext.identity,
          plan.selection,
          "downloading"
        );
        if (plan.kind === "apply") {
          consumeManagedPendingLocalModel(category, exactPending);
          continue;
        }
        if (plan.kind === "wait") {
          if (!readManagedPendingLocalModel(category, exactPending)) {
            rememberManagedPendingLocalModel(category, exactPending);
          }
          continue;
        }

        const requestKey = `${expectedContext.identity.accountId}:${expectedContext.identity.workspaceId}:${expectedContext.identity.authGeneration}:${expectedContext.identity.configGeneration}:${category}:${plan.selection.provider}:${plan.selection.model}`;
        if (inFlight.current[category]) continue;
        inFlight.current[category] = {
          key: requestKey,
          identity: expectedContext.identity,
          provider: plan.selection.provider,
          model: plan.selection.model,
        };
        rememberManagedPendingLocalModel(category, exactPending);
        try {
          await downloadFor(plan.selection).downloadModel(plan.selection.model);
        } finally {
          if (inFlight.current[category]?.key === requestKey) delete inFlight.current[category];
          const latestContext = contextRef.current;
          const latestBinding = latestContext
            ? readManagedLocalModelBinding(latestContext.identity, category)
            : null;
          const selectionChanged =
            latestBinding?.provider !== plan.selection.provider ||
            latestBinding?.model !== plan.selection.model;
          if (
            latestContext &&
            (managedContextKey(expectedContext) !== managedContextKey(latestContext) ||
              selectionChanged)
          ) {
            void reconcileRef.current();
          }
        }
      }
    } finally {
      setReconciling(false);
    }
  }, [downloadFor, refreshInventory, yieldHeadlessOwner]);
  reconcileRef.current = reconcile;

  useEffect(() => {
    const handleTransferChange = (): void => {
      setPendingRevision((revision) => revision + 1);
      setYielded(false);
      if (ownsLockRef.current) void reconcileRef.current();
    };
    const handleStorage = (event: StorageEvent): void => {
      if (event.key === PENDING_LOCAL_MODELS_KEY) handleTransferChange();
    };
    window.addEventListener("openwhispr-managed-local-model-transfer", handleTransferChange);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("openwhispr-managed-local-model-transfer", handleTransferChange);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const completed = localStorage.getItem("onboardingCompleted") === "true";
  const eligible = Boolean(
    context &&
    !yielded &&
    ((surface === "onboarding" && showUi && !completed) || (surface === "background" && completed))
  );
  const handleReconcileError = useCallback(
    (_error: unknown): void => {
      setCategoryErrors({
        dictation: "onboarding.managedLocal.errors.reconciliation",
        assistant: "onboarding.managedLocal.errors.reconciliation",
      });
      setReconciling(false);
      yieldHeadlessOwner();
    },
    [yieldHeadlessOwner]
  );
  const ownsLock = useManagedLocalModelLock(eligible, reconcile, handleReconcileError);
  ownsLockRef.current = ownsLock;

  const currentContextKey = context ? managedContextKey(context) : null;
  useEffect(() => {
    setYielded(false);
  }, [currentContextKey]);
  useEffect(() => {
    if (ownsLock && currentContextKey && reconciledContextRef.current !== currentContextKey) {
      void reconcile();
    }
  }, [currentContextKey, ownsLock, reconcile]);

  const rows = ((): ManagedSetupDisplayRow[] => {
    if (!context) return [];
    return context.localModels.selections.map((selection) => {
      const category = managedLocalModelCategory(selection);
      const key = managedLocalModelSelectionKey(selection);
      const download = downloadFor(selection);
      const downloading = download.isDownloadingModel(selection.model);
      const availability = inventory.availability[key] ?? "missing";
      const nvidiaBlocked =
        selection.provider === "nvidia" && inventory.nvidiaCapability !== "supported";
      const details = displayDetails(selection);
      return {
        key,
        category,
        provider: selection.provider,
        model: selection.model,
        ...details,
        status: categoryErrors[category]
          ? "error"
          : nvidiaBlocked
            ? "blocked"
            : downloading || availability === "downloading"
              ? "downloading"
              : availability === "installed"
                ? "installed"
                : "missing",
        progress: downloading ? download.downloadProgress.percentage : undefined,
        disabledReason: nvidiaBlocked
          ? t(
              inventory.nvidiaCapability === "unknown"
                ? "onboarding.managedLocal.compatibility.checking"
                : "onboarding.managedLocal.compatibility.unsupported"
            )
          : undefined,
        errorMessage: categoryErrors[category]
          ? categoryErrors[category].startsWith("onboarding.")
            ? t(categoryErrors[category])
            : categoryErrors[category]
          : undefined,
      } satisfies ManagedSetupDisplayRow;
    });
  })();

  // Binding persistence lives in localStorage; the revision is the render signal
  // that makes this derived read observe the coordinator's latest write.
  void bindingRevision;
  void pendingRevision;
  const ready = (() => {
    if (!context) return false;
    for (const category of ["dictation", "assistant"] as const) {
      const approved = context.localModels.selections.filter(
        (selection) => managedLocalModelCategory(selection) === category
      );
      if (approved.length === 0) continue;
      const binding = readManagedLocalModelBinding(context.identity, category);
      if (!isCurrentManagedLocalModelBinding(binding, context.identity, category, approved))
        return false;
      const selection = { provider: binding.provider, model: binding.model };
      const availability = inventory.availability[managedLocalModelSelectionKey(selection)];
      const pending = readManagedPendingLocalModel(
        category,
        pendingSelection(context.identity, selection, "downloading")
      );
      if (availability !== "installed") {
        const activelyDownloading =
          pending?.transferState === "downloading" &&
          (availability === "downloading" ||
            downloadFor(selection).isDownloadingModel(selection.model));
        if (!activelyDownloading) return false;
      }
    }
    return true;
  })();

  useEffect(() => {
    onReadinessChange?.(ready);
  }, [onReadinessChange, ready]);

  const retry = useCallback((): void => {
    setCategoryErrors({});
    setYielded(false);
    window.dispatchEvent(new Event("openwhispr-managed-local-model-transfer"));
    const current = contextRef.current;
    if (current) {
      for (const category of ["dictation", "assistant"] as const) {
        for (const selection of current.localModels.selections) {
          if (managedLocalModelCategory(selection) !== category) continue;
          const pending = readManagedPendingLocalModel(
            category,
            pendingSelection(current.identity, selection, "missing")
          );
          if (!pending?.errorCode) continue;
          const { errorCode: _errorCode, ...retryable } = pending;
          rememberManagedPendingLocalModel(category, retryable);
        }
      }
    }
    if (accountId && workspaceId && authGeneration != null) {
      void refreshEnterprise(accountId, workspaceId, authGeneration, true);
    }
  }, [accountId, authGeneration, refreshEnterprise, workspaceId]);
  const handleSignOut = useCallback((): void => {
    void signOut();
  }, []);
  const handleSelect = useCallback(
    (row: ManagedSetupDisplayRow): void => {
      const current = contextRef.current;
      if (!ownsLock || !current || row.status === "blocked" || row.status === "downloading") return;
      const selection = current.localModels.selections.find(
        (candidate) => candidate.provider === row.provider && candidate.model === row.model
      );
      if (!selection || managedLocalModelCategory(selection) !== row.category) return;
      rememberManagedLocalModelBinding({
        ...current.identity,
        category: row.category,
        provider: selection.provider,
        model: selection.model,
      });
      setBindingRevision((revision) => revision + 1);
      void reconcileRef.current();
    },
    [ownsLock]
  );

  const errorMessage =
    (categoryErrors.dictation?.startsWith("onboarding.")
      ? t(categoryErrors.dictation)
      : categoryErrors.dictation) ??
    (categoryErrors.assistant?.startsWith("onboarding.")
      ? t(categoryErrors.assistant)
      : categoryErrors.assistant) ??
    (enterpriseStatus === "error" ? t("onboarding.managedLocal.errors.config") : null);
  if (!showUi || (surface === "background" && !errorMessage)) return null;
  return (
    <EnterpriseModelSetupStep
      rows={rows}
      busy={reconciling || !ownsLock}
      ready={ready}
      errorMessage={errorMessage}
      onSelect={handleSelect}
      onRetry={retry}
      onSignOut={handleSignOut}
    />
  );
}
