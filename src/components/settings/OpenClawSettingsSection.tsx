import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Cloud, Check, AlertCircle, Loader2 } from "lucide-react";
import { useSettings } from "../../hooks/useSettings";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import { SettingsRow, SettingsPanel, SettingsPanelRow } from "../ui/SettingsSection";

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "success" }
  | { status: "error"; message: string };

export default function OpenClawSettingsSection() {
  const { t } = useTranslation();
  const {
    openClawEnabled,
    openClawGatewayUrl,
    openClawGatewayToken,
    openClawSshEnabled,
    openClawSshHost,
    openClawSshUser,
    openClawSshKeyPath,
    openClawSshRemotePort,
    setOpenClawEnabled,
    setOpenClawGatewayUrl,
    setOpenClawGatewayToken,
    setOpenClawSshEnabled,
    setOpenClawSshHost,
    setOpenClawSshUser,
    setOpenClawSshKeyPath,
    setOpenClawSshRemotePort,
  } = useSettings();

  const [testState, setTestState] = useState<TestState>({ status: "idle" });

  const isDisabled = !openClawEnabled;

  const handleTestConnection = async () => {
    setTestState({ status: "testing" });
    try {
      const api = window.electronAPI as unknown as {
        openclaw?: {
          testConnection?: (settings: unknown) => Promise<{ success: boolean; error?: string }>;
          reconfigure?: (settings: unknown) => Promise<{ success: boolean; error?: string }>;
        };
      };

      if (!api.openclaw?.testConnection) {
        setTestState({
          status: "error",
          message: t("settings.openclaw.testFailed"),
        });
        return;
      }

      const config = {
        gatewayUrl: openClawGatewayUrl,
        gatewayToken: openClawGatewayToken,
        sshEnabled: openClawSshEnabled,
        sshHost: openClawSshHost,
        sshUser: openClawSshUser,
        sshKeyPath: openClawSshKeyPath,
        sshRemotePort: openClawSshRemotePort,
      };

      const result = await api.openclaw.testConnection(config);

      if (result.success) {
        const reconfigureResult = await api.openclaw.reconfigure?.(config);
        if (reconfigureResult && !reconfigureResult.success) {
          setTestState({
            status: "error",
            message: reconfigureResult.error ?? t("settings.openclaw.testFailed"),
          });
        } else {
          setTestState({ status: "success" });
        }
      } else {
        setTestState({
          status: "error",
          message: result.error ?? t("settings.openclaw.testFailed"),
        });
      }
    } catch (error) {
      setTestState({
        status: "error",
        message: error instanceof Error ? error.message : t("settings.openclaw.testFailed"),
      });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-md flex items-center justify-center shrink-0 bg-primary/10 dark:bg-primary/15">
          <Cloud className="w-4 h-4 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-xs font-semibold text-foreground tracking-tight">
            {t("settings.openclaw.title")}
          </h3>
          <p className="text-xs text-muted-foreground/80 mt-0.5 leading-relaxed">
            {t("settings.openclaw.description")}
          </p>
        </div>
      </div>

      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow label={t("settings.openclaw.enable")}>
            <Toggle checked={openClawEnabled} onChange={setOpenClawEnabled} />
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>

      <SettingsPanel>
        <SettingsPanelRow>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-foreground">
              {t("settings.openclaw.gatewayUrl")}
            </p>
            <Input
              type="text"
              value={openClawGatewayUrl}
              onChange={(e) => setOpenClawGatewayUrl(e.target.value)}
              placeholder={t("settings.openclaw.gatewayUrlPlaceholder")}
              disabled={isDisabled}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        </SettingsPanelRow>
        <SettingsPanelRow>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-foreground">
              {t("settings.openclaw.token")}
            </p>
            <Input
              type="password"
              value={openClawGatewayToken}
              onChange={(e) => setOpenClawGatewayToken(e.target.value)}
              placeholder={t("settings.openclaw.tokenPlaceholder")}
              disabled={isDisabled}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        </SettingsPanelRow>
      </SettingsPanel>

      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settings.openclaw.sshTunnel")}
            description={t("settings.openclaw.sshTunnelDescription")}
          >
            <Toggle
              checked={openClawSshEnabled}
              onChange={setOpenClawSshEnabled}
              disabled={isDisabled}
            />
          </SettingsRow>
        </SettingsPanelRow>
        {openClawSshEnabled && (
          <>
            <SettingsPanelRow>
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-foreground">
                  {t("settings.openclaw.sshHost")}
                </p>
                <Input
                  type="text"
                  value={openClawSshHost}
                  onChange={(e) => setOpenClawSshHost(e.target.value)}
                  disabled={isDisabled}
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
            </SettingsPanelRow>
            <SettingsPanelRow>
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-foreground">
                  {t("settings.openclaw.sshUser")}
                </p>
                <Input
                  type="text"
                  value={openClawSshUser}
                  onChange={(e) => setOpenClawSshUser(e.target.value)}
                  disabled={isDisabled}
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
            </SettingsPanelRow>
            <SettingsPanelRow>
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-foreground">
                  {t("settings.openclaw.sshKeyPath")}
                </p>
                <Input
                  type="text"
                  value={openClawSshKeyPath}
                  onChange={(e) => setOpenClawSshKeyPath(e.target.value)}
                  disabled={isDisabled}
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
            </SettingsPanelRow>
            <SettingsPanelRow>
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-foreground">
                  {t("settings.openclaw.sshRemotePort")}
                </p>
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={openClawSshRemotePort}
                  onChange={(e) => {
                    const parsed = parseInt(e.target.value, 10);
                    if (!Number.isNaN(parsed)) setOpenClawSshRemotePort(parsed);
                  }}
                  disabled={isDisabled}
                />
              </div>
            </SettingsPanelRow>
          </>
        )}
      </SettingsPanel>

      <div className="space-y-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleTestConnection}
          disabled={isDisabled || testState.status === "testing"}
          className="w-full"
        >
          {testState.status === "testing" ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {t("settings.openclaw.testing")}
            </>
          ) : (
            t("settings.openclaw.testConnection")
          )}
        </Button>
        {testState.status === "success" && (
          <div className="flex items-center gap-1.5 text-xs text-success">
            <Check className="w-3.5 h-3.5 shrink-0" />
            <span>{t("settings.openclaw.testSuccess")}</span>
          </div>
        )}
        {testState.status === "error" && (
          <div className="flex items-start gap-1.5 text-xs text-destructive">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span className="leading-relaxed">
              {t("settings.openclaw.testFailed")}
              {testState.message ? ` — ${testState.message}` : ""}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
