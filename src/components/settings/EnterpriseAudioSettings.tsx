import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useEnterpriseIdentityStore } from "../../stores/enterpriseIdentityStore";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import type { EnterpriseAudioSetupContext } from "../../types/enterpriseAudio";

export function EnterpriseAudioSettings() {
  const { t } = useTranslation();
  const { config, accountId, workspaceId, authGeneration } = useEnterpriseIdentityStore();
  const records =
    config?.providers.filter(
      (record) =>
        record.provider === "openai-compatible" ||
        (record.provider === "azure" && (record.config.transcription || record.config.realtime))
    ) ?? [];
  const [provider, setProvider] = useState<"azure" | "openai-compatible">("openai-compatible");
  const [slots, setSlots] = useState<{ slot: string; present: boolean }[]>([]);
  const [operations, setOperations] = useState<("batch" | "realtime")[]>([]);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const [context, setContext] = useState<EnterpriseAudioSetupContext | null>(null);
  const current = records.find((record) => record.provider === provider) ?? records[0];
  const selected = current?.provider as "azure" | "openai-compatible" | undefined;
  const generation = config?.generation;
  const providerVersion = current?.version;
  useEffect(() => {
    let active = true;
    setSecrets({});
    setContext(null);
    setConsent(false);
    setSlots([]);
    setOperations([]);
    setMessage("");
    if (
      selected &&
      accountId &&
      workspaceId &&
      authGeneration != null &&
      generation != null &&
      providerVersion != null
    ) {
      const expected = {
        accountId,
        workspaceId,
        authGeneration,
        generation,
        providerVersion,
      };
      void window.electronAPI
        .enterpriseAudioStatus?.({ provider: selected, context: expected })
        .then((result) => {
          if (!active) return;
          if (result.success && result.configFingerprint) {
            setContext({ ...expected, configFingerprint: result.configFingerprint });
            setSlots(result.slots ?? []);
            setOperations(result.operations ?? []);
          } else setMessage(t(result.messageKey ?? "enterprise.audio.setupFailed"));
        })
        .catch(() => {
          if (active) setMessage(t("enterprise.audio.setupFailed"));
        });
    }
    return () => {
      active = false;
    };
  }, [selected, accountId, workspaceId, authGeneration, generation, providerVersion, t]);
  useEffect(() => {
    let active = true;
    const apply = async () => {
      const pending = await window.electronAPI.getPendingEnterpriseAudioTest?.();
      if (!active || !pending || pending.workspaceId !== config?.workspaceId) return;
      setProvider(pending.provider);
      await window.electronAPI.getPendingEnterpriseAudioTest?.(true);
    };
    void apply();
    const unsubscribe = window.electronAPI.onEnterpriseAudioTestRequested?.(() => {
      void apply();
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [config?.workspaceId]);
  if (!current || !selected) return null;
  const isCurrent = () => {
    const state = useEnterpriseIdentityStore.getState();
    return Boolean(
      context &&
      state.accountId === context.accountId &&
      state.workspaceId === context.workspaceId &&
      state.authGeneration === context.authGeneration &&
      state.config?.generation === context.generation &&
      state.config.providers.find((record) => record.provider === selected)?.version ===
        context.providerVersion
    );
  };
  const save = async (slot: string, remove = false) => {
    if (!context || !isCurrent()) return;
    setBusy(true);
    try {
      const result = await window.electronAPI.enterpriseAudioSaveCredential?.({
        provider: selected,
        context,
        slot,
        secret: secrets[slot],
        remove,
      });
      if (!isCurrent()) return;
      if (!result?.success) {
        setMessage(t(result?.messageKey ?? "enterprise.audio.setupFailed"));
        return;
      }
      setSecrets((previous) => ({ ...previous, [slot]: "" }));
      setSlots((previous) =>
        previous.map((entry) => (entry.slot === slot ? { ...entry, present: !remove } : entry))
      );
      setMessage(t("enterprise.audio.saved"));
    } catch {
      if (isCurrent()) setMessage(t("enterprise.audio.setupFailed"));
    } finally {
      setBusy(false);
    }
  };
  const test = async (operation: "batch" | "realtime") => {
    if (!context || !isCurrent()) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await window.electronAPI.enterpriseAudioTest?.({
        provider: selected,
        context,
        operation,
        allowInferenceValidation: consent,
      });
      if (!isCurrent()) return;
      setMessage(
        result?.success && result.passed
          ? t("enterprise.audio.testPassed")
          : t("enterprise.audio.testFailed", { code: result?.code ?? "NETWORK_FAILED" })
      );
    } catch {
      if (isCurrent()) setMessage(t("enterprise.audio.setupFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <h3 className="text-sm font-medium">{t("enterprise.audio.title")}</h3>
      <p className="text-xs text-muted-foreground">{t("enterprise.audio.description")}</p>
      {records.length > 1 && (
        <select
          aria-label={t("enterprise.audio.provider")}
          disabled={busy}
          value={selected}
          onChange={(event) => setProvider(event.target.value as typeof provider)}
          className="w-full rounded-md border bg-background p-2 text-sm"
        >
          {records.map((record) => (
            <option key={record.provider} value={record.provider}>
              {record.provider === "azure" ? "Azure OpenAI" : t("enterprise.audio.gateway")}
            </option>
          ))}
        </select>
      )}
      {slots.length > 0 && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !context}
          onClick={async () => {
            if (!context || !isCurrent()) return;
            setBusy(true);
            try {
              const result = await window.electronAPI.enterpriseAudioImportBootstrap?.({
                provider: selected,
                context,
              });
              if (!isCurrent()) return;
              setMessage(
                t(
                  !result?.success
                    ? "enterprise.audio.setupFailed"
                    : result.imported
                      ? "enterprise.audio.importedBootstrap"
                      : "enterprise.audio.bootstrapNotFound"
                )
              );
              if (result?.success && result.imported) {
                const refreshed = await window.electronAPI.enterpriseAudioStatus?.({
                  provider: selected,
                  context,
                });
                if (isCurrent() && refreshed?.success) setSlots(refreshed.slots ?? []);
              }
            } catch {
              if (isCurrent()) setMessage(t("enterprise.audio.setupFailed"));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("enterprise.audio.importBootstrap")}
        </Button>
      )}
      {slots.map(({ slot, present }) => (
        <div key={slot} className="space-y-2">
          <label htmlFor={`enterprise-slot-${slot}`} className="text-xs font-medium">
            {slot} ·{" "}
            {t(present ? "enterprise.audio.provisioned" : "enterprise.audio.credentialMissing")}
          </label>
          <Input
            dir="ltr"
            id={`enterprise-slot-${slot}`}
            type="password"
            autoComplete="off"
            value={secrets[slot] ?? ""}
            onChange={(event) =>
              setSecrets((previous) => ({ ...previous, [slot]: event.target.value }))
            }
          />
          <p className="text-xs text-muted-foreground">
            {t("enterprise.audio.proxyCredentialFormat")}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || !context || !secrets[slot]?.trim()}
              onClick={() => save(slot)}
            >
              {t("common.save")}
            </Button>
            {present && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !context}
                onClick={() => save(slot, true)}
              >
                {t("common.delete")}
              </Button>
            )}
          </div>
        </div>
      ))}
      {current.config.network?.caBundleId &&
        config?.certificateBundles
          ?.filter((bundle) => bundle.id === current.config.network?.caBundleId)
          .map((bundle) => (
            <p key={bundle.id} className="break-all text-xs text-muted-foreground">
              {bundle.name} · SHA-256 {bundle.fingerprint}
            </p>
          ))}
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
        />
        {t("enterprise.audio.probeConsent")}
      </label>
      <div className="flex flex-wrap gap-2">
        {operations.map((operation) => (
          <Button
            key={operation}
            size="sm"
            variant="outline"
            disabled={busy || !context || !consent}
            onClick={() => test(operation)}
          >
            {t(
              operation === "batch" ? "enterprise.audio.testBatch" : "enterprise.audio.testRealtime"
            )}
          </Button>
        ))}
      </div>
      {message && (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      )}
    </div>
  );
}
