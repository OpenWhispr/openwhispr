import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { MessageSquare } from "../icons";
import { Button } from "../ui/button";
import { SettingsPanelRow } from "../ui/SettingsSection";
import { RecentActions } from "./RecentActions";
import { ensureConnectorStatus, useConnectorStatusStore } from "../../stores/connectorStatusStore";

type RowPhase = "idle" | "connecting" | "disconnecting";

// Connect and disconnect failures with their own copy; anything else reads
// as a generic failure.
const ROW_ERRORS = new Set([
  "oauth_denied",
  "oauth_timeout",
  "oauth_state_mismatch",
  "ports_busy",
  "token_exchange_failed",
  "not_configured",
  "connection_changed",
  "signed_out",
  "policy_blocked",
  "policy_unavailable",
  "disconnect_failed",
]);

interface SlackConnectorRowProps {
  isPaid: boolean;
  blockedByOrg: boolean;
  onUpgrade: () => void;
}

export function SlackConnectorRow({
  isPaid,
  blockedByOrg,
  onUpgrade,
}: SlackConnectorRowProps): ReactElement | null {
  const { t } = useTranslation();
  const status = useConnectorStatusStore((state) => state.statuses.slack);
  const [phase, setPhase] = useState<RowPhase>("idle");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const latestAttempt = useRef(0);

  // Loaded for every plan: a lapsed plan must still see, and remove, its login.
  useEffect(() => {
    void ensureConnectorStatus();
  }, []);

  const connected = Boolean(status?.connected);
  const needsReconnect = connected && Boolean(status?.needsReconnect);
  const canConnect = isPaid && !blockedByOrg;

  // The status broadcast from main updates the row; results only carry a
  // failure to show. Connect stays clickable while the browser is open: a
  // new attempt replaces an abandoned one, which main cancels
  // ("oauth_cancelled", not an error), so only the latest attempt's result
  // reaches the row.
  const connect = async (): Promise<void> => {
    const attempt = ++latestAttempt.current;
    const isLatest = (): boolean => attempt === latestAttempt.current;
    setPhase("connecting");
    setErrorCode(null);
    try {
      const result = await window.electronAPI?.connectorConnect?.("slack");
      if (!isLatest()) return;
      if (!result) setErrorCode("connect_failed");
      else if (result.status === "failed" && result.errorCode !== "oauth_cancelled") {
        setErrorCode(result.errorCode);
      } else if (result.status === "unavailable") setErrorCode(result.reason);
    } catch {
      if (isLatest()) setErrorCode("connect_failed");
    } finally {
      if (isLatest()) setPhase("idle");
    }
  };

  const disconnect = async (): Promise<void> => {
    setPhase("disconnecting");
    setErrorCode(null);
    try {
      const result = await window.electronAPI?.connectorDisconnect?.("slack");
      if (!result) setErrorCode("disconnect_failed");
      else if (result.status === "failed") setErrorCode(result.errorCode);
      else if (result.status === "unavailable") setErrorCode(result.reason);
    } catch {
      setErrorCode("disconnect_failed");
    } finally {
      setPhase("idle");
    }
  };

  // With connectors turned off, the row exists only to remove a login.
  if (blockedByOrg && !connected) return null;

  let summary = t("connectors.slack.description");
  if (needsReconnect) summary = t("connectors.slack.needsReconnect");
  else if (connected) {
    summary = t("connectors.slack.connectedAs", {
      account: status?.accountLabel ?? "",
      workspace: status?.workspaceLabel ?? "",
    });
  } else if (phase === "connecting") summary = t("connectors.slack.connecting");
  else if (!isPaid) summary = t("connectors.slack.proRequired");

  return (
    <SettingsPanelRow>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-primary/5 dark:bg-primary/10 flex items-center justify-center shrink-0">
          <MessageSquare className="w-4 h-4 text-primary" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-foreground">{t("connectors.slack.title")}</p>
          <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed" dir="auto">
            {summary}
          </p>
          {errorCode && (
            <p role="alert" className="text-xs text-destructive mt-1">
              {t(
                `connectors.slack.errors.${ROW_ERRORS.has(errorCode) ? errorCode : "connect_failed"}`
              )}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {needsReconnect && canConnect && (
            <Button size="sm" disabled={phase === "disconnecting"} onClick={() => void connect()}>
              {t("connectors.slack.reconnect")}
            </Button>
          )}
          {connected && (
            <Button
              size="sm"
              variant="outline"
              disabled={phase !== "idle"}
              onClick={() => void disconnect()}
            >
              {t("connectors.slack.disconnect")}
            </Button>
          )}
          {!connected && canConnect && (
            <Button size="sm" disabled={phase === "disconnecting"} onClick={() => void connect()}>
              {t("connectors.slack.connect")}
            </Button>
          )}
          {!connected && !isPaid && (
            <Button size="sm" className="shrink-0" onClick={onUpgrade}>
              {t("integrations.api.viewPlans")}
            </Button>
          )}
        </div>
      </div>
      {connected && (
        <RecentActions
          connectorId="slack"
          refreshKey={`${status?.accountLabel ?? ""}:${status?.workspaceLabel ?? ""}`}
        />
      )}
    </SettingsPanelRow>
  );
}
