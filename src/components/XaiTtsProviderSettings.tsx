import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import ApiKeyInput from "./ui/ApiKeyInput";
import { GetApiKeyLink } from "./ui/GetApiKeyLink";
import { ProviderTabs } from "./ui/ProviderTabs";
import { useSettingsStore } from "../stores/settingsStore";

const XAI_TAB = [{ id: "xai", name: "xAI" }];

export default function XaiTtsProviderSettings() {
  const { t } = useTranslation();
  const xaiApiKey = useSettingsStore((s) => s.xaiApiKey);
  const setXaiApiKey = useSettingsStore((s) => s.setXaiApiKey);
  const xaiOAuthConnected = useSettingsStore((s) => s.xaiOAuthConnected);
  const setXaiOAuthConnected = useSettingsStore((s) => s.setXaiOAuthConnected);
  const [busy, setBusy] = useState(false);

  const applyStatus = useCallback(
    (status: { connected?: boolean; error?: string } | undefined) => {
      setXaiOAuthConnected(Boolean(status?.connected) && !status?.error);
    },
    [setXaiOAuthConnected]
  );

  const login = async () => {
    setBusy(true);
    try {
      applyStatus(await window.electronAPI.xaiOAuthLogin?.());
    } catch {
      applyStatus(await window.electronAPI.xaiOAuthStatus?.());
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    try {
      applyStatus(await window.electronAPI.xaiOAuthLogout?.());
    } catch {
      applyStatus(await window.electronAPI.xaiOAuthStatus?.());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <ProviderTabs providers={XAI_TAB} selectedId="xai" onSelect={() => {}} />

      <div className="space-y-2">
        {!xaiOAuthConnected ? (
          <p className="text-xs text-muted-foreground">{t("settings.speech.xaiOauth.hint")}</p>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          {xaiOAuthConnected ? (
            <>
              <p className="text-xs font-medium text-foreground">
                {t("settings.speech.xaiOauth.connected")}
              </p>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void logout()}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {t("settings.speech.xaiOauth.disconnect")}
              </Button>
            </>
          ) : (
            <Button type="button" size="sm" disabled={busy} onClick={() => void login()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t("settings.speech.xaiOauth.connect")}
            </Button>
          )}
        </div>
        {!xaiOAuthConnected ? (
          <>
            <div className="flex items-baseline justify-between">
              <h4 className="text-xs font-medium text-foreground">
                {t("settings.speech.xaiOauth.orApiKey")}
              </h4>
              <GetApiKeyLink url="https://console.x.ai" />
            </div>
            <ApiKeyInput apiKey={xaiApiKey} setApiKey={setXaiApiKey} label="" helpText="" />
          </>
        ) : null}
      </div>
    </div>
  );
}
