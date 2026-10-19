import { useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, X } from "../../icons";
import { LogoTile } from "../../ui/LogoTile";
import { GithubDeviceCode } from "../../connectors/GithubDeviceCode";
import {
  cancelInteraction,
  connectInteraction,
  type InteractionEntry,
} from "../../../stores/agentInteractionStore";
import { CONNECTION_TARGET_NAMES, calendarProviders } from "../../../config/agentCapabilities";
import type { CalendarProvider } from "../../../utils/calendarConnect";
import type { ConnectionTarget, InteractionPayload } from "../../../types/agentInteractions";
import gmailMark from "../../../assets/icons/gmail.svg";
import slackMark from "../../../assets/icons/slack.svg";
import linearMark from "../../../assets/icons/linear.svg";
import githubMark from "../../../assets/icons/github.svg";
import googleCalendarMark from "../../../assets/icons/google-calendar.svg";
import microsoftCalendarMark from "../../../assets/icons/microsoft-calendar.svg";
import appleCalendarMark from "../../../assets/icons/apple-calendar.svg";
import { PILL_BUTTON, ROUND_BUTTON } from "./cardStyles";

// Each service's brand mark; Linear's and GitHub's are one colour and follow the theme.
const TARGET_LOGOS: Partial<Record<ConnectionTarget, { src: string; monochrome?: boolean }>> = {
  gmail: { src: gmailMark },
  slack: { src: slackMark },
  linear: { src: linearMark, monochrome: true },
  github: { src: githubMark, monochrome: true },
  google: { src: googleCalendarMark },
  microsoft: { src: microsoftCalendarMark },
  apple: { src: appleCalendarMark },
};

interface ConnectRowProps {
  target: ConnectionTarget;
  title: string;
  reason?: string;
  /** A connect is running: Yes goes, and X stops it. */
  working: boolean;
  /** Why the last connect failed (an error code); the row stays to try again. */
  error?: string;
  /** Absent when the row offers its own choices instead (a calendar to pick). */
  onConnect?: () => void;
  onDismiss: () => void;
  children?: ReactNode;
}

/**
 * A service to connect: its logo, what connecting is for, ✓ Yes and X. Shared
 * by the connection card and an answer card whose Send needs a connection.
 */
export function ConnectRow({
  target,
  title,
  reason,
  working,
  error,
  onConnect,
  onDismiss,
  children,
}: ConnectRowProps): ReactElement {
  const { t } = useTranslation();
  const logo = TARGET_LOGOS[target];
  const dismissLabel = t(
    working ? "agentMode.interactions.cancel" : "agentMode.interactions.notNow"
  );
  return (
    <div>
      <div className="flex items-center gap-3">
        {logo && <LogoTile src={logo.src} alt="" monochrome={logo.monochrome} />}
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium text-foreground" dir="auto">
            {title}
          </p>
          {reason && (
            <p className="text-xs text-muted-foreground" dir="auto">
              {reason}
            </p>
          )}
        </div>
        {onConnect && !working && (
          <button type="button" onClick={onConnect} className={`${PILL_BUTTON} text-primary`}>
            <Check size={14} />
            {t("agentMode.interactions.connection.yes")}
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel}
          title={dismissLabel}
          className={ROUND_BUTTON}
        >
          <X size={14} />
        </button>
      </div>
      {children}
      {working && target === "github" && <GithubDeviceCode connectorId="github" />}
      <div role="status" className="text-xs">
        {/* Apple Calendar asks for macOS permission; the others finish in the browser. */}
        {working && target !== "apple" && (
          <p className="mt-2 text-muted-foreground">
            {t("agentMode.interactions.connection.connecting")}
          </p>
        )}
        {error && (
          <p className="mt-2 text-destructive">
            {t(
              error === "permission_denied"
                ? "agentMode.interactions.connection.permissionDenied"
                : "agentMode.interactions.connection.failed"
            )}
          </p>
        )}
      </div>
    </div>
  );
}

/** A service the request needs: Yes runs the real connect, X cancels what depends on it. */
export function ConnectionCard({
  entry,
  payload,
}: {
  entry: InteractionEntry;
  payload: Extract<InteractionPayload, { kind: "connection" }>;
}): ReactElement {
  const { t } = useTranslation();
  // The calendar picked on a "connect a calendar" card.
  const [provider, setProvider] = useState<CalendarProvider>();
  const { target, reason } = payload;
  const working = entry.state === "working";
  const connect = (picked?: CalendarProvider) => {
    setProvider(picked);
    void connectInteraction(entry.key, picked);
  };
  return (
    <ConnectRow
      target={provider ?? target}
      title={
        target === "calendar"
          ? t("agentMode.interactions.connection.calendarTitle")
          : t("agentMode.interactions.connection.title", { name: CONNECTION_TARGET_NAMES[target] })
      }
      reason={reason}
      working={working}
      error={entry.error}
      onConnect={target === "calendar" ? undefined : () => connect()}
      onDismiss={() => cancelInteraction(entry.key)}
    >
      {target === "calendar" && !working && (
        <div className="mt-2 flex flex-wrap gap-2">
          {calendarProviders().map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => connect(option)}
              className={PILL_BUTTON}
            >
              {t("agentMode.interactions.connection.connect", {
                name: CONNECTION_TARGET_NAMES[option],
              })}
            </button>
          ))}
        </div>
      )}
    </ConnectRow>
  );
}
