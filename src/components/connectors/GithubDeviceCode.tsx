import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import type { ConnectorConnectProgress } from "../../types/connectors";

/** GitHub's page for entering a device code. */
export const GITHUB_DEVICE_URL = "https://github.com/login/device";

// The code is only ever entered on github.com, whatever the payload says.
function deviceUrl(verificationUri: string): string {
  return verificationUri.startsWith("https://github.com/") ? verificationUri : GITHUB_DEVICE_URL;
}

/**
 * The code GitHub's device flow asks the user to enter, shown in the row
 * while it connects, with Cancel from the moment Connect is pressed. Mounted
 * only while the row is connecting, so it listens only then. Should a second
 * code arrive, it replaces the first: it's the one GitHub is waiting on.
 */
export function GithubDeviceCode({ connectorId }: { connectorId: string }): ReactElement {
  const { t, i18n } = useTranslation();
  const [progress, setProgress] = useState<ConnectorConnectProgress | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onConnectorConnectProgress?.((next) => {
      if (next?.connectorId === connectorId) setProgress(next);
    });
    return () => unsubscribe?.();
  }, [connectorId]);

  // Cancel is there from the start: asking GitHub for a code can take a
  // while, and main honours a cancel that reaches it before the connect does.
  const cancel = (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => void window.electronAPI?.connectorCancelConnect?.(connectorId)}
    >
      {t("connectors.github.deviceCode.cancel")}
    </Button>
  );
  // GitHub's page opens even when the copy fails: the code is on screen to type.
  const copyAndOpen = async (code: string, verificationUri: string): Promise<void> => {
    void window.electronAPI?.openExternal?.(deviceUrl(verificationUri));
    try {
      const result = await window.electronAPI?.writeClipboard?.(code);
      if (result?.success) setCopiedCode(code);
    } catch {
      // Nothing to undo; the code stays visible.
    }
  };

  return (
    <div className="mt-2 space-y-1.5">
      {/* Mounted before the code arrives, so a screen reader announces it. */}
      <div aria-live="polite" className="space-y-1.5">
        {progress && (
          <>
            <p className="text-xs text-muted-foreground">
              {t("connectors.github.deviceCode.instructions")}
            </p>
            <p
              className="font-mono text-lg font-semibold tracking-[0.2em] text-foreground select-all"
              dir="ltr"
            >
              {progress.userCode}
            </p>
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        {progress && (
          <Button
            size="sm"
            onClick={() => void copyAndOpen(progress.userCode, progress.verificationUri)}
          >
            {t("connectors.github.deviceCode.copyAndOpen")}
          </Button>
        )}
        {/* Stops main's polling at once; the row then reads as before Connect. */}
        {cancel}
        {/* Mounted before the note arrives, so a screen reader announces it. */}
        <span role="status" className="text-xs text-muted-foreground">
          {progress && copiedCode === progress.userCode && t("connectors.github.deviceCode.copied")}
        </span>
      </div>
      {progress && (
        <p className="text-xs text-muted-foreground/70">
          {t("connectors.github.deviceCode.expires", {
            time: new Intl.DateTimeFormat(i18n.language, {
              hour: "numeric",
              minute: "2-digit",
            }).format(progress.expiresAt),
          })}
        </p>
      )}
    </div>
  );
}
