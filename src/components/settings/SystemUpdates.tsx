import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUpdater } from "../../hooks/useUpdater";
import { useDialogs } from "../../hooks/useDialogs";
import { useToast } from "../ui/useToast";
import { BIDI_VALUE_TOKEN, BidiInterpolatedText } from "../ui/BidiInterpolatedText";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Download, RefreshCw } from "../icons";
import { SettingsPanel, SettingsPanelRow, SettingsRow, SectionHeader } from "../ui/SettingsSection";
import { Toggle } from "../ui/toggle";
import { KeepAlive } from "./KeepAlive";

const SystemUpdates = React.memo(function SystemUpdates({
  showAlertDialog,
  showConfirmDialog,
}: {
  showAlertDialog: ReturnType<typeof useDialogs>["showAlertDialog"];
  showConfirmDialog: ReturnType<typeof useDialogs>["showConfirmDialog"];
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const autoUpdatesEnabled = useSettingsStore((s) => s.autoUpdatesEnabled);
  const setAutoUpdatesEnabled = useSettingsStore((s) => s.setAutoUpdatesEnabled);
  const [currentVersion, setCurrentVersion] = useState("");
  const {
    status: updateStatus,
    info: updateInfo,
    downloadProgress: updateDownloadProgress,
    isChecking: checkingForUpdates,
    isDownloading: downloadingUpdate,
    isInstalling: installInitiated,
    installStalled,
    consumeInstallStall,
    checkForUpdates,
    downloadUpdate,
    installUpdate: installUpdateAction,
    getAppVersion,
  } = useUpdater();
  const isUpdateAvailable =
    !updateStatus.isDevelopment && (updateStatus.updateAvailable || updateStatus.updateDownloaded);
  // Update metadata is not trusted HTML: parse it inertly and render only its
  // text, one heading, paragraph or list item per line.
  const notes = updateInfo?.releaseNotes;
  const releaseNotes = useMemo(() => {
    const html =
      typeof notes === "string"
        ? notes
        : Array.isArray(notes)
          ? notes
              .filter((entry) => typeof entry?.note === "string")
              .map((entry) => entry.note)
              .join("\n\n")
          : "";
    const body = new DOMParser().parseFromString(html, "text/html").body;
    body.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, br").forEach((el) => el.after("\n"));
    return (body.textContent ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n");
  }, [notes]);

  useEffect(() => {
    let mounted = true;
    const timer = setTimeout(async () => {
      if (!mounted) return;
      const version = await getAppVersion();
      if (version && mounted) setCurrentVersion(version);
    }, 100);
    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [getAppVersion]);

  useEffect(() => {
    if (!installStalled || !consumeInstallStall()) return;
    showAlertDialog({
      title: t("settingsPage.general.updates.dialogs.almostThere.title"),
      description: t("settingsPage.general.updates.dialogs.almostThere.description"),
    });
  }, [installStalled, consumeInstallStall, showAlertDialog, t]);

  return (
    <div>
      <SectionHeader title={t("settingsPage.general.updates.title")} />
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settingsPage.general.updates.currentVersion")}
            description={
              updateStatus.isDevelopment
                ? t("settingsPage.general.updates.devMode")
                : !updateStatus.isSupported
                  ? t("settingsPage.general.updates.managedByPackageManager")
                  : isUpdateAvailable
                    ? t("settingsPage.general.updates.newVersionAvailable")
                    : t("settingsPage.general.updates.latestVersion")
            }
          >
            <div className="flex items-center gap-2.5">
              <span dir="ltr" className="text-xs tabular-nums text-muted-foreground font-mono">
                {currentVersion || t("settingsPage.general.updates.versionPlaceholder")}
              </span>
              {updateStatus.isDevelopment ? (
                <Badge variant="warning">{t("settingsPage.general.updates.badges.dev")}</Badge>
              ) : isUpdateAvailable ? (
                <Badge variant="success">{t("settingsPage.general.updates.badges.update")}</Badge>
              ) : (
                <Badge variant="outline">{t("settingsPage.general.updates.badges.latest")}</Badge>
              )}
            </div>
          </SettingsRow>
        </SettingsPanelRow>

        {updateStatus.isSupported && (
          <SettingsPanelRow>
            <SettingsRow
              label={t("settingsPage.general.updates.automaticUpdates")}
              description={t("settingsPage.general.updates.automaticUpdatesDescription")}
            >
              <Toggle
                ariaLabel={t("settingsPage.general.updates.automaticUpdates")}
                checked={autoUpdatesEnabled}
                onChange={setAutoUpdatesEnabled}
              />
            </SettingsRow>
          </SettingsPanelRow>
        )}

        {(isUpdateAvailable || updateStatus.updateDownloaded || releaseNotes.trim()) && (
          <SettingsPanelRow>
            <div className="space-y-2.5">
              {isUpdateAvailable && !updateStatus.updateDownloaded && (
                <div className="space-y-2">
                  <Button
                    onClick={async () => {
                      try {
                        await downloadUpdate();
                      } catch {
                        showAlertDialog({
                          title: t("settingsPage.general.updates.dialogs.downloadFailed.title"),
                          description: t(
                            "settingsPage.general.updates.dialogs.downloadFailed.description"
                          ),
                        });
                      }
                    }}
                    disabled={downloadingUpdate}
                    variant="success"
                    className="w-full"
                    size="sm"
                  >
                    <Download
                      size={13}
                      className={`me-1.5 ${downloadingUpdate ? "animate-pulse" : ""}`}
                    />
                    {downloadingUpdate
                      ? t("settingsPage.general.updates.downloading", {
                          progress: Math.round(updateDownloadProgress),
                        })
                      : t("settingsPage.general.updates.downloadUpdate", {
                          version: updateInfo?.version || "",
                        })}
                  </Button>
                  {downloadingUpdate && (
                    <div className="h-1 w-full overflow-hidden rounded-full bg-muted/50">
                      <div
                        className="h-full bg-success transition-[width] duration-200 rounded-full"
                        style={{ width: `${Math.min(100, Math.max(0, updateDownloadProgress))}%` }}
                      />
                    </div>
                  )}
                </div>
              )}

              {updateStatus.updateDownloaded && (
                <Button
                  onClick={() => {
                    showConfirmDialog({
                      title: t("settingsPage.general.updates.dialogs.installUpdate.title"),
                      description: t(
                        "settingsPage.general.updates.dialogs.installUpdate.description",
                        { version: updateInfo?.version || "" }
                      ),
                      confirmText: t(
                        "settingsPage.general.updates.dialogs.installUpdate.confirmText"
                      ),
                      onConfirm: async () => {
                        try {
                          await installUpdateAction();
                        } catch {
                          showAlertDialog({
                            title: t("settingsPage.general.updates.dialogs.installFailed.title"),
                            description: t(
                              "settingsPage.general.updates.dialogs.installFailed.description"
                            ),
                          });
                        }
                      },
                    });
                  }}
                  disabled={installInitiated}
                  className="w-full"
                  size="sm"
                >
                  <RefreshCw
                    size={14}
                    className={`me-2 ${installInitiated ? "animate-spin" : ""}`}
                  />
                  {installInitiated
                    ? t("settingsPage.general.updates.restarting")
                    : t("settingsPage.general.updates.installAndRestart")}
                </Button>
              )}
            </div>

            {releaseNotes.trim() && (
              <div className="mt-4 pt-4 border-t border-border/70">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                  <BidiInterpolatedText
                    text={t("settingsPage.general.updates.whatsNew", { version: BIDI_VALUE_TOKEN })}
                    value={updateInfo?.version}
                  />
                </p>
                <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
                  {releaseNotes}
                </div>
              </div>
            )}
          </SettingsPanelRow>
        )}
      </SettingsPanel>
      <div className="mt-5 flex justify-end">
        <Button
          onClick={async () => {
            try {
              const result = await checkForUpdates();
              if (result && !result.updateAvailable) {
                toast({
                  title: t("settingsPage.general.updates.dialogs.noUpdates.title"),
                  description: t("settingsPage.general.updates.dialogs.noUpdates.description"),
                });
              }
            } catch {
              showAlertDialog({
                title: t("settingsPage.general.updates.dialogs.checkFailed.title"),
                description: t("settingsPage.general.updates.dialogs.checkFailed.description"),
              });
            }
          }}
          disabled={checkingForUpdates || updateStatus.isDevelopment || !updateStatus.isSupported}
          variant="outline"
          size="sm"
        >
          <RefreshCw size={13} className={`me-1.5 ${checkingForUpdates ? "animate-spin" : ""}`} />
          {checkingForUpdates
            ? t("settingsPage.general.updates.checking")
            : t("settingsPage.general.updates.checkForUpdates")}
        </Button>
      </div>
    </div>
  );
});

export default function SystemUpdatesKeepAlive({
  active,
  showAlertDialog,
  showConfirmDialog,
}: {
  active: boolean;
  showAlertDialog: ReturnType<typeof useDialogs>["showAlertDialog"];
  showConfirmDialog: ReturnType<typeof useDialogs>["showConfirmDialog"];
}) {
  return (
    <KeepAlive active={active}>
      <SystemUpdates showAlertDialog={showAlertDialog} showConfirmDialog={showConfirmDialog} />
    </KeepAlive>
  );
}
