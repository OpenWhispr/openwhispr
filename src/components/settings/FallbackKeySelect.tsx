import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

type KeyProfile = { id: string; provider: string; label: string };

export default function FallbackKeySelect({
  provider,
  value,
  onChange,
  profiles,
  onProfilesChange,
}: {
  provider: string;
  value: string;
  onChange: (id: string) => void;
  profiles: KeyProfile[];
  onProfilesChange: (profiles: KeyProfile[]) => void;
}) {
  const { t } = useTranslation();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const id = useId();
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const clear = () => {
    setAdding(false);
    setLabel("");
    setKey("");
    setError("");
  };
  const refresh = async () => {
    const result = await window.electronAPI.listFallbackKeys?.();
    if (mounted.current && result?.success) onProfilesChange(result.profiles ?? []);
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await window.electronAPI.saveFallbackKey?.({ provider, label, key });
      if (!mounted.current) return;
      if (!result?.success || !result.profile) throw new Error("Key save failed");
      onProfilesChange([
        ...profiles.filter((profile) => profile.id !== result.profile!.id),
        result.profile,
      ]);
      onChange(result.profile.id);
      clear();
      await refresh();
    } catch {
      if (mounted.current) setError(t("modelFallback.keySaveError"));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await window.electronAPI.deleteFallbackKey?.(value);
      if (!mounted.current) return;
      if (!result?.success) throw new Error("Key deletion failed");
      onProfilesChange(profiles.filter((profile) => profile.id !== value));
      onChange("");
      await refresh();
    } catch {
      if (mounted.current) setError(t("modelFallback.keyDeleteError"));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <Select
        value={value || "default"}
        onValueChange={(next) => onChange(next === "default" ? "" : next)}
        disabled={busy}
      >
        <SelectTrigger aria-label={t("modelFallback.key")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default">{t("modelFallback.defaultKey")}</SelectItem>
          {profiles
            .filter((profile) => profile.provider === provider)
            .map((profile) => (
              <SelectItem key={profile.id} value={profile.id}>
                {profile.label}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      {adding ? (
        <div className="space-y-2 rounded-lg border p-3">
          <label className="text-xs" htmlFor={`${id}-name`}>
            {t("modelFallback.keyName")}
          </label>
          <Input
            dir="auto"
            id={`${id}-name`}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={80}
            disabled={busy}
          />
          <label className="text-xs" htmlFor={`${id}-secret`}>
            {t("modelFallback.keyValue")}
          </label>
          <Input
            dir="ltr"
            id={`${id}-secret`}
            type="password"
            autoComplete="off"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            maxLength={8192}
            disabled={busy}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void save()}
              disabled={busy || !label.trim() || !key.trim()}
            >
              {t("modelFallback.saveKey")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={clear} disabled={busy}>
              {t("modelFallback.cancelKey")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setAdding(true)}
            disabled={busy}
          >
            {t("modelFallback.newKey")}
          </Button>
          {value && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void remove()}
              disabled={busy}
            >
              {t("modelFallback.deleteKey")}
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
