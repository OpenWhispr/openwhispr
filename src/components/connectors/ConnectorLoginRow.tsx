import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { SettingsPanelRow } from "../ui/SettingsSection";
import { RecentActions } from "./RecentActions";
import { ensureConnectorStatus, useConnectorStatusStore } from "../../stores/connectorStatusStore";
import type { ConnectorRowSpec } from "./connectorRows";

type RowPhase = "idle" | "connecting" | "disconnecting";

// Connect and disconnect failures with their own copy; anything else reads
// as a generic failure. Shared by every login row, so each connector's
// `errors` group in the locales carries all of them that it can produce.
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
  "permission_not_granted",
  "email_not_verified",
  "domain_policy",
]);

export interface ConnectorLoginRowProps {
  row: ConnectorRowSpec;
  isPaid: boolean;
  blockedByOrg: boolean;
  onUpgrade: () => void;
}

/**
 * One connector's login in Settings → Connectors: Connect, Reconnect,
 * Disconnect, the plan upsell and its recent actions. Copy lives under
 * `connectors.<connectorId>.*`.
 */
export function ConnectorLoginRow({
  row,
  isPaid,
  blockedByOrg,
  onUpgrade,
}: ConnectorLoginRowProps): ReactElement | null {
  const {
    id: connectorId,
    icon,
    brandIcon = false,
    accountSummary,
    connectingDetail: ConnectingDetail,
  } = row;
  const { t } = useTranslation();
  const status = useConnectorStatusStore((state) => state.statuses[connectorId]);
  const [phase, setPhase] = useState<RowPhase>("idle");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  // Gmail's disconnect kept a Google grant the calendar shares.
  const [grantKept, setGrantKept] = useState(false);
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
    setGrantKept(false);
    try {
      const result = await window.electronAPI?.connectorConnect?.(connectorId);
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
    setGrantKept(false);
    try {
      const result = await window.electronAPI?.connectorDisconnect?.(connectorId);
      if (!result) setErrorCode("disconnect_failed");
      else if (result.status === "disconnected") setGrantKept(result.grantKept === true);
      else if (result.status === "failed") setErrorCode(result.errorCode);
      else if (result.status === "unavailable") setErrorCode(result.reason);
    } catch {
      setErrorCode("disconnect_failed");
    } finally {
      setPhase("idle");
    }
  };

  // A build without this connector's OAuth client can't connect it at all.
  if (status?.configured === false) return null;
  // With connectors turned off, the row exists only to remove a login.
  if (blockedByOrg && !connected) return null;

  const copy = (key: string, values?: Record<string, string>): string =>
    t(`connectors.${connectorId}.${key}`, values);
  // A Reconnect opens the same browser sign-in as Connect, and its hint
  // (Gmail: an admin block never redirects back) matters there too. A
  // working login shows as connected as soon as main's broadcast lands.
  let summary = copy("description");
  if (phase === "connecting" && (!connected || needsReconnect)) summary = copy("connecting");
  else if (needsReconnect) summary = copy("needsReconnect");
  else if (connected && status) summary = copy("connectedAs", accountSummary(status));
  else if (!isPaid) summary = copy("proRequired");

  return (
    <SettingsPanelRow>
      <div className="flex items-center gap-3">
        <div
          className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
            brandIcon
              ? "bg-white dark:bg-surface-raised shadow-[0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-none dark:border dark:border-white/10"
              : "bg-primary/5 dark:bg-primary/10"
          }`}
        >
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-foreground">{copy("title")}</p>
          <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed" dir="auto">
            {summary}
          </p>
          {phase === "connecting" && ConnectingDetail && (
            <ConnectingDetail connectorId={connectorId} />
          )}
          {/* Mounted before the note arrives, so a screen reader announces it. */}
          <div role="status" className="text-xs text-muted-foreground" dir="auto">
            {grantKept && <p className="mt-1">{copy("grantKept")}</p>}
          </div>
          {errorCode && (
            <p role="alert" className="text-xs text-destructive mt-1">
              {copy(`errors.${ROW_ERRORS.has(errorCode) ? errorCode : "connect_failed"}`)}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {needsReconnect && canConnect && (
            <Button size="sm" disabled={phase === "disconnecting"} onClick={() => void connect()}>
              {copy("reconnect")}
            </Button>
          )}
          {connected && (
            <Button
              size="sm"
              variant="outline"
              disabled={phase !== "idle"}
              onClick={() => void disconnect()}
            >
              {copy("disconnect")}
            </Button>
          )}
          {!connected && canConnect && (
            <Button size="sm" disabled={phase === "disconnecting"} onClick={() => void connect()}>
              {copy("connect")}
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
          connectorId={connectorId}
          refreshKey={`${status?.accountLabel ?? ""}:${status?.workspaceLabel ?? ""}`}
        />
      )}
    </SettingsPanelRow>
  );
}
