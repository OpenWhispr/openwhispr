import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

const copy = "settingsPage.aiModels.aiPass";
const OTHER_PROVIDERS = "__other_providers__";

interface Props {
  model: string;
  onModelChange: (model: string) => void;
}

export default function AiPassCleanupSettings({ model, onModelChange }: Props) {
  const { t } = useTranslation();
  const api = window.electronAPI;
  const id = useId();
  const [status, setStatus] = useState({ configured: false, connected: false });
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    async function load() {
      const current = await api?.aiPassCleanupStatus?.();
      if (!active || !current?.ok) return;
      setStatus(current.data);
      if (current.data.connected) {
        const list = await api?.listAiPassCleanupModels?.();
        if (!active) return;
        if (list?.ok) setModels(list.data);
        else setError(`${copy}.error`);
      }
    }
    void load().catch(() => {
      if (active) setError(`${copy}.error`);
    });
    return () => {
      active = false;
    };
  }, [api]);

  if (!status.configured) return null;

  async function updateConnection() {
    setBusy(true);
    setError("");
    try {
      if (status.connected) {
        const result = await api.disconnectAiPassCleanup?.();
        const current = await api.aiPassCleanupStatus?.();
        if (current?.ok) setStatus(current.data);
        if (current?.ok && !current.data.connected) {
          onModelChange("");
          setModels([]);
        }
        if (!result?.ok) setError(`${copy}.disconnectError`);
      } else {
        const result = await api.connectAiPassCleanup?.();
        if (!result?.ok) {
          setError(`${copy}.error`);
          return;
        }
        setStatus({ configured: true, connected: true });
        const list = await api.listAiPassCleanupModels?.();
        if (list?.ok) setModels(list.data);
        else setError(`${copy}.error`);
      }
    } catch {
      setError(`${copy}.error`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="AI Pass" className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">AI Pass</p>
          <p className="text-xs text-muted-foreground">{t(`${copy}.description`)}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={updateConnection}
        >
          {t(busy ? "common.loading" : `${copy}.${status.connected ? "disconnect" : "connect"}`)}
        </Button>
      </div>
      {status.connected && (
        <div className="space-y-1">
          <label htmlFor={id} className="text-xs font-medium">
            {t(`${copy}.model`)}
          </label>
          <Select
            value={model || OTHER_PROVIDERS}
            onValueChange={(value) => onModelChange(value === OTHER_PROVIDERS ? "" : value)}
            disabled={busy}
          >
            <SelectTrigger id={id}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={OTHER_PROVIDERS}>{t(`${copy}.otherProviders`)}</SelectItem>
              {model && !models.some(({ id }) => id === model) && (
                <SelectItem value={model}>{model}</SelectItem>
              )}
              {models.map(({ id, name }) => (
                <SelectItem key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {t(error)}
        </p>
      )}
    </section>
  );
}
