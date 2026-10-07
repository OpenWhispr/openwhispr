import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Lock } from "../icons";
import { Button } from "../ui/button";
import { SettingsPanelRow } from "../ui/SettingsSection";
import { RecentActions } from "./RecentActions";
import { BetaBadge } from "./BetaBadge";
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
  // GitHub's device flow: the code wasn't entered in time, or the GitHub App
  // has the device flow turned off.
  "code_expired",
  "device_flow_disabled",
  // GitHub couldn't be reached, or throttled the request, before any code
  // was shown.
  "network",
  "rate_limited",
]);

export interface ConnectorLoginRowProps {
  row: ConnectorRowSpec;
  isPaid: boolean;
  blockedByOrg: boolean;
}

/**
 * One connector's login in Settings → Connectors: Connect, Reconnect,
 * Disconnect, the locked state on a free plan and its recent actions. Copy
 * lives under `connectors.<connectorId>.*`.
 */
export function ConnectorLoginRow({
  row,
  isPaid,
  blockedByOrg,
}: ConnectorLoginRowProps): ReactElement | null {
  const {
    id: connectorId,
    icon,
    brandIcon = false,
    accountSummary,
    connectingDetail: ConnectingDetail,
    rowActions: RowActions,
    disconnectedDetail: DisconnectedDetail,
  } = row;
  const { t } = useTranslation();
  const status = useConnectorStatusStore((state) => state.statuses[connectorId]);
  const [phase, setPhase] = useState<RowPhase>("idle");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  // Gmail's disconnect kept a Google grant the calendar shares.
  const [grantKept, setGrantKept] = useState(false);
  // This row's own Disconnect succeeded; cleared by the next Connect.
  const [disconnected, setDisconnected] = useState(false);
  const latestAttempt = useRef(0);
  // Set while a connect the row should stop on leaving is still waiting.
  const cancelOnLeave = useRef<(() => void) | null>(null);
  const actions = useRef<HTMLDivElement>(null);
  const connectingDetail = useRef<HTMLDivElement>(null);
  const wasConnecting = useRef(false);
  // Set when Connect or Reconnect had focus as the connect started.
  const focusConnectingDetail = useRef(false);

  // Loaded for every plan: a lapsed plan must still see, and remove, its login.
  useEffect(() => {
    void ensureConnectorStatus();
  }, []);

  // Both notes are about the login this row just removed, which belonged to
  // the OpenWhispr account that was active then.
  useEffect(
    () =>
      window.electronAPI?.onActiveAccountScopeChanged?.(() => {
        setDisconnected(false);
        setGrantKept(false);
      }),
    []
  );

  const connected = Boolean(status?.connected);
  const needsReconnect = connected && Boolean(status?.needsReconnect);
  const canConnect = isPaid && !blockedByOrg;

  // Leaving Settings mid-connect stops it, for rows that connect in place (GitHub).
  useEffect(() => () => cancelOnLeave.current?.(), []);

  // So does the row losing Connect (the org turned connectors off, the plan
  // lapsed): nothing in the row could finish or cancel it any more.
  useEffect(() => {
    if (canConnect) return;
    const cancel = cancelOnLeave.current;
    cancelOnLeave.current = null;
    cancel?.();
  }, [canConnect]);

  // A connect in the row starts by unmounting the Connect or Reconnect that
  // had focus, so focus moves to the connecting detail's Cancel (its only
  // button until the code arrives). It ends by unmounting its own Cancel or
  // Copy & open, which usually held focus; focus then goes to the row's first
  // button (Connect, Reconnect, the next step once connected, or Disconnect)
  // rather than dropping to the page.
  useEffect(() => {
    if (phase === "connecting") {
      wasConnecting.current = true;
      if (focusConnectingDetail.current) {
        focusConnectingDetail.current = false;
        connectingDetail.current?.querySelector<HTMLButtonElement>("button")?.focus();
      }
      return;
    }
    if (!wasConnecting.current || !row.connectInRow) return;
    wasConnecting.current = false;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) {
      actions.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }
  }, [phase, row.connectInRow]);
  // A connect that runs in the row ends with its own Cancel, not a new Connect.
  const offerConnect = canConnect && !(row.connectInRow && phase === "connecting");

  // The status broadcast from main updates the row; results only carry a
  // failure to show. For a browser sign-in, Connect stays clickable while the
  // browser is open: a new attempt replaces an abandoned one, which main cancels
  // ("oauth_cancelled", not an error), so only the latest attempt's result
  // reaches the row.
  const connect = async (): Promise<void> => {
    const attempt = ++latestAttempt.current;
    const isLatest = (): boolean => attempt === latestAttempt.current;
    focusConnectingDetail.current = Boolean(
      row.connectInRow && actions.current?.contains(document.activeElement)
    );
    setPhase("connecting");
    setErrorCode(null);
    setGrantKept(false);
    setDisconnected(false);
    cancelOnLeave.current = row.connectInRow
      ? () => void window.electronAPI?.connectorCancelConnect?.(connectorId)
      : null;
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
      if (isLatest()) {
        cancelOnLeave.current = null;
        setPhase("idle");
      }
    }
  };

  const disconnect = async (): Promise<void> => {
    setPhase("disconnecting");
    setErrorCode(null);
    setGrantKept(false);
    try {
      const result = await window.electronAPI?.connectorDisconnect?.(connectorId);
      if (!result) setErrorCode("disconnect_failed");
      else if (result.status === "disconnected") {
        setGrantKept(result.grantKept === true);
        setDisconnected(true);
      } else if (result.status === "failed") setErrorCode(result.errorCode);
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
  // A free plan sees the connector dimmed, without Connect; the section's one upsell sits above.
  // Only what describes the connector dims: notes about a login just removed stay readable.
  const locked = !isPaid && !connected;
  const dimmed = locked ? "opacity-60" : "";

  return (
    <SettingsPanelRow>
      <div className="flex items-center gap-3">
        <div
          className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${dimmed} ${
            brandIcon
              ? "bg-white dark:bg-surface-raised shadow-[0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-none dark:border dark:border-white/10"
              : "bg-primary/5 dark:bg-primary/10"
          }`}
        >
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className={dimmed}>
            <div className="flex items-center gap-1.5">
              <p className="text-xs font-semibold text-foreground">{copy("title")}</p>
              <BetaBadge />
            </div>
            <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed" dir="auto">
              {summary}
            </p>
          </div>
          {phase === "connecting" && ConnectingDetail && (
            <div ref={connectingDetail}>
              <ConnectingDetail connectorId={connectorId} />
            </div>
          )}
          {disconnected && !connected && DisconnectedDetail && (
            <DisconnectedDetail connectorId={connectorId} />
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
        <div ref={actions} className="flex items-center gap-2 shrink-0">
          {needsReconnect && offerConnect && (
            <Button size="sm" disabled={phase === "disconnecting"} onClick={() => void connect()}>
              {copy("reconnect")}
            </Button>
          )}
          {/* A login that needs reconnecting can't act or refresh; Reconnect comes first. */}
          {connected && !needsReconnect && canConnect && status && RowActions && (
            <RowActions status={status} />
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
          {!connected && offerConnect && (
            <Button size="sm" disabled={phase === "disconnecting"} onClick={() => void connect()}>
              {copy("connect")}
            </Button>
          )}
          {locked && (
            <Lock
              size={14}
              role="img"
              aria-label={t("connectors.locked")}
              className="text-muted-foreground opacity-60"
            />
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
