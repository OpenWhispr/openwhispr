import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { SectionLabel } from "../ui/SettingsSection";
import { normalizeDbDate } from "../../utils/dateFormatting";
import type { ConnectorActionRecord } from "../../types/connectors";

function formatWhen(createdAt: string, locale: string): string {
  const date = normalizeDbDate(createdAt);
  return Number.isNaN(date.getTime())
    ? createdAt
    : date.toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });
}

function isWebUrl(value: string | null): value is string {
  return typeof value === "string" && value.startsWith("https://");
}

/** The last ten receipts for one connector: labels, times and states, never content. */
export function RecentActions({
  connectorId,
  refreshKey = "",
}: {
  connectorId: string;
  refreshKey?: string;
}): ReactElement | null {
  const { t, i18n } = useTranslation();
  const [recent, setRecent] = useState<ConnectorActionRecord[]>([]);
  const [accountScopeChanges, setAccountScopeChanges] = useState(0);

  // Main lists the receipts of its active account scope, which settles after
  // the renderer's own sign-in state; refetch once it has moved.
  useEffect(
    () =>
      window.electronAPI?.onActiveAccountScopeChanged?.(() =>
        setAccountScopeChanges((count) => count + 1)
      ),
    []
  );

  useEffect(() => {
    setRecent([]);
    let active = true;
    void window.electronAPI
      ?.connectorRecentActions?.(connectorId, 10)
      .then((rows) => {
        if (active) setRecent(rows ?? []);
      })
      .catch(() => {
        if (active) setRecent([]);
      });
    return () => {
      active = false;
    };
  }, [connectorId, refreshKey, accountScopeChanges]);

  if (recent.length === 0) return null;
  return (
    <div className="mt-3">
      <SectionLabel>{t("connectors.recent.title")}</SectionLabel>
      <ul className="space-y-1">
        {recent.map((row) => (
          <li
            key={row.id}
            className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
          >
            <span className="truncate" dir="auto">
              {row.destinationLabel
                ? t(`connectors.recent.actions.${row.connector}_${row.action}`, {
                    destination: row.destinationLabel,
                  })
                : // A run interrupted by a quit never learned its destination.
                  t(`connectors.recent.unlabeledActions.${row.connector}_${row.action}`)}
            </span>
            <span className="shrink-0">
              {formatWhen(row.createdAt, i18n.language)} ·{" "}
              {t(`connectors.recent.states.${row.state}`)}
              {isWebUrl(row.resultUrl) && (
                <Button
                  size="sm"
                  variant="link"
                  className="h-auto p-0 ms-1"
                  onClick={() => void window.electronAPI?.openExternal?.(row.resultUrl as string)}
                >
                  {t("connectors.approval.open")}
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
