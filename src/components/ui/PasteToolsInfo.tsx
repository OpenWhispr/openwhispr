import { useTranslation } from "react-i18next";
import { Check, Terminal, Info } from "../icons";
import { Button } from "./button";
import { InfoBox } from "./InfoBox";
import type { PasteToolsResult } from "../../types/electron";
import {
  getLinuxPasteInstallCommands,
  needsLinuxPasteToolGuidance,
  needsWtype,
  type LinuxPasteTool,
} from "../../utils/linuxPasteTools";

interface PasteToolsInfoProps {
  pasteToolsInfo: PasteToolsResult | null;
  isChecking: boolean;
  onCheck: () => void;
}

function LinuxInstallCommands({ tool }: { tool: LinuxPasteTool }) {
  const { t } = useTranslation();
  return (
    <div className="mt-3 space-y-2 bg-surface-primary border border-default p-3 rounded-md font-mono text-xs overflow-x-auto">
      {getLinuxPasteInstallCommands(t, tool).map(({ label, cmd }) => (
        <div key={cmd}>
          <div className="text-secondary">{label}</div>
          <div dir="ltr" className="text-primary">
            {cmd}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function PasteToolsInfo({
  pasteToolsInfo,
  isChecking,
  onCheck,
}: PasteToolsInfoProps) {
  const { t } = useTranslation();
  if (!pasteToolsInfo) {
    return (
      <div className="border border-default rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Terminal className="w-6 h-6 text-brand-solid" />
            <div>
              <h3 className="font-semibold text-primary">{t("pasteToolsInfo.title")}</h3>
              <p className="text-sm text-secondary">{t("pasteToolsInfo.checking")}</p>
            </div>
          </div>
          {isChecking && (
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-brand-solid"></div>
          )}
        </div>
      </div>
    );
  }

  // Windows - always ready
  if (pasteToolsInfo.platform === "win32") {
    return (
      <InfoBox variant="success">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Terminal className="w-6 h-6 text-green-solid dark:text-green-solid" />
            <div>
              <h3 className="font-semibold text-green-solid dark:text-green-solid">
                {t("pasteToolsInfo.readyTitle")}
              </h3>
              <p className="text-sm text-green-solid dark:text-green-solid">
                {t("pasteToolsInfo.windowsReady")}
              </p>
            </div>
          </div>
          <div className="text-green-solid dark:text-green-solid">
            <Check className="w-5 h-5" />
          </div>
        </div>
      </InfoBox>
    );
  }

  if (pasteToolsInfo.platform === "linux" && !needsLinuxPasteToolGuidance(pasteToolsInfo)) {
    const method = pasteToolsInfo.method || "xdotool";
    const methodLabel = method === "xtest" ? "built-in (XTest)" : method;
    const methodSuffix =
      pasteToolsInfo.isWayland && method === "xdotool"
        ? t("pasteToolsInfo.xwaylandAppsOnly")
        : t("pasteToolsInfo.methodReady");

    return (
      <InfoBox variant="success">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Terminal className="w-6 h-6 text-green-solid dark:text-green-solid" />
            <div>
              <h3 className="font-semibold text-green-solid dark:text-green-solid">
                {t("pasteToolsInfo.readyTitle")}
              </h3>
              <p className="text-sm text-green-solid dark:text-green-solid">
                {t("pasteToolsInfo.usingMethodPrefix")}{" "}
                <code dir="ltr" className="bg-green-solid/20 px-1 rounded">
                  {methodLabel}
                </code>{" "}
                {methodSuffix}
              </p>
            </div>
          </div>
          <div className="text-green-solid dark:text-green-solid">
            <Check className="w-5 h-5" />
          </div>
        </div>
      </InfoBox>
    );
  }

  if (needsLinuxPasteToolGuidance(pasteToolsInfo)) {
    const isWayland = pasteToolsInfo.isWayland;
    const wlCopyMissing = !!pasteToolsInfo.wlCopyMissing;
    const wtypeMissing = needsWtype(pasteToolsInfo);
    const needsPasteTool = !pasteToolsInfo.available || wtypeMissing;
    const cosmicTerminalsOnly = wtypeMissing && !!pasteToolsInfo.isCosmic;
    const recommendedTool = wtypeMissing
      ? "wtype"
      : pasteToolsInfo.recommendedInstall === "wtype"
        ? "wtype"
        : pasteToolsInfo.recommendedInstall === "xdotool"
          ? "xdotool"
          : null;
    const showInstall = recommendedTool !== null;

    return (
      <InfoBox variant="warning" className="space-y-3">
        {/* wl-clipboard and a paste tool can both be missing; list both, so one
            Re-check doesn't uncover the other. */}
        {wlCopyMissing && (
          <div className="flex items-start gap-3">
            <Info className="w-6 h-6 text-amber-solid dark:text-amber-solid flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <h3 className="font-semibold text-amber-solid dark:text-amber-solid">
                {t("pasteToolsInfo.wlClipboardTitle")}
              </h3>
              <p className="text-sm text-amber-solid dark:text-amber-solid mt-1">
                {t("pasteToolsInfo.wlClipboardDescription")}
              </p>
              <LinuxInstallCommands tool="wl-clipboard" />
            </div>
          </div>
        )}

        {needsPasteTool && (
          <div className="flex items-start gap-3">
            <Info className="w-6 h-6 text-amber-solid dark:text-amber-solid flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <h3 className="font-semibold text-amber-solid dark:text-amber-solid">
                {showInstall
                  ? t("pasteToolsInfo.optionalEnableTitle")
                  : t("pasteToolsInfo.waylandClipboardTitle")}
              </h3>

              {showInstall ? (
                <>
                  <p className="text-sm text-amber-solid dark:text-amber-solid mt-1">
                    {cosmicTerminalsOnly ? (
                      t("pasteToolsInfo.wtypeCosmicTerminalsDescription")
                    ) : wtypeMissing ? (
                      t("pasteToolsInfo.wtypeFallbackDescription")
                    ) : (
                      <>
                        {t("pasteToolsInfo.installPrefix")}{" "}
                        <code dir="ltr" className="bg-amber-solid/20 px-1 rounded font-mono">
                          {recommendedTool}
                        </code>
                        :
                      </>
                    )}
                  </p>

                  <LinuxInstallCommands tool={recommendedTool} />

                  {isWayland && recommendedTool === "wtype" && (
                    <p className="text-sm text-amber-solid dark:text-amber-solid mt-3">
                      {t("pasteToolsInfo.noteXwaylandAlso")}
                    </p>
                  )}

                  {isWayland && recommendedTool === "xdotool" && (
                    <p className="text-sm text-amber-solid dark:text-amber-solid mt-3">
                      {t("pasteToolsInfo.noteXwaylandOnly")}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm text-amber-solid dark:text-amber-solid mt-1">
                  {t("pasteToolsInfo.waylandClipboardDescription")}{" "}
                  <kbd dir="ltr" className="bg-amber-solid/20 px-1 rounded text-xs">
                    Ctrl+V
                  </kbd>
                  .
                </p>
              )}

              {/* Without wl-copy, a manual Ctrl+V in a Wayland app pastes stale text too. */}
              {showInstall && !cosmicTerminalsOnly && !wlCopyMissing && (
                <p className="text-sm text-amber-solid dark:text-amber-solid mt-3">
                  {t("pasteToolsInfo.withoutToolPrefix")}{" "}
                  <kbd dir="ltr" className="bg-amber-solid/20 px-1 rounded text-xs">
                    Ctrl+V
                  </kbd>
                  .
                </p>
              )}
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={onCheck} disabled={isChecking}>
            {isChecking ? t("pasteToolsInfo.recheckChecking") : t("pasteToolsInfo.recheck")}
          </Button>
        </div>
      </InfoBox>
    );
  }

  // Fallback for macOS (shouldn't normally render this component on macOS)
  return null;
}
