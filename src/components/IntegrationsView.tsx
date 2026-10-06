import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "./icons";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { useSettingsStore } from "../stores/settingsStore";
import { ensureConnectorStatus, useConnectorStatusStore } from "../stores/connectorStatusStore";
import { useConnectorAccess } from "../hooks/useConnectorAccess";
import ApiKeysSection from "./ApiKeysSection";
import { ConnectorsSection } from "./ConnectorsSection";
import { CONNECTOR_ROWS } from "./connectors/connectorRows";
import { IntegrationsNav } from "./integrations/IntegrationsNav";
import { IntegrationsPane, UpsellBar } from "./integrations/IntegrationsPane";
import { CalendarsPane } from "./integrations/CalendarsPane";
import { McpPane } from "./integrations/McpPane";
import { CliPane } from "./integrations/CliPane";
import {
  INTEGRATIONS_SECTION_ICONS,
  INTEGRATIONS_SECTIONS,
  sectionMeta,
  type IntegrationsSection,
  type SectionMeta,
} from "./integrations/integrationsSections";

const API_DOCS_URL = "https://docs.openwhispr.com/api/overview";
const { mcp: McpIcon, cli: CliIcon } = INTEGRATIONS_SECTION_ICONS;

interface IntegrationsViewProps {
  isPaid: boolean;
  onUpgrade: () => void;
  section: IntegrationsSection;
  onSectionChange: (section: IntegrationsSection) => void;
}

export default function IntegrationsView({
  isPaid,
  onUpgrade,
  section,
  onSectionChange,
}: IntegrationsViewProps): ReactElement {
  const { t } = useTranslation();
  const isMac = window.electronAPI?.getPlatform?.() === "darwin";
  const connectorAccess = useConnectorAccess();
  const readyConnectors = useConnectorStatusStore(
    (state) =>
      CONNECTOR_ROWS.filter((row) => {
        const status = state.statuses[row.id];
        return status?.connected && !status.needsReconnect;
      }).length
  );
  const connectedCalendars = useSettingsStore(
    (state) =>
      [
        state.gcalAccounts.length > 0,
        state.mcalAccounts.length > 0,
        isMac && state.appleCalendarConnected,
      ].filter(Boolean).length
  );
  // A section stays mounted once opened, so a connect or dialog in it survives
  // a visit to another section. Calendars always mounts: its connection
  // listeners keep the nav's count fresh, as when Integrations was one page.
  const [mounted, setMounted] = useState<ReadonlySet<IntegrationsSection>>(
    () => new Set<IntegrationsSection>(["calendars", section])
  );
  if (!mounted.has(section)) setMounted(new Set(mounted).add(section));
  const [createKeyRequest, setCreateKeyRequest] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const paneElements = useRef<Partial<Record<IntegrationsSection, HTMLDivElement | null>>>({});
  const focusOpenedSection = useRef(false);

  // The nav counts connected logins on every section, not only once Connectors has mounted.
  useEffect(() => {
    void ensureConnectorStatus();
  }, []);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    if (!focusOpenedSection.current) return;
    focusOpenedSection.current = false;
    paneElements.current[section]?.querySelector("h2")?.focus();
  }, [section]);

  // A link inside a section is hidden along with it, so focus moves to the
  // opened section's heading instead of dropping to the page.
  const openSection = (next: IntegrationsSection): void => {
    focusOpenedSection.current = true;
    onSectionChange(next);
  };

  const meta = Object.fromEntries(
    INTEGRATIONS_SECTIONS.map((id) => [
      id,
      sectionMeta(id, {
        isPaid,
        connectors: { ...connectorAccess, ready: readyConnectors },
        connectedCalendars,
      }),
    ])
  ) as Record<IntegrationsSection, SectionMeta | null>;
  const titleOf = (id: IntegrationsSection): string => t(`integrations.nav.sections.${id}`);

  const panes: Record<IntegrationsSection, ReactNode> = {
    connectors: (
      <IntegrationsPane
        title={titleOf("connectors")}
        description={t("integrations.connectors.description")}
      >
        <ConnectorsSection onUpgrade={onUpgrade} />
      </IntegrationsPane>
    ),
    calendars: <CalendarsPane title={titleOf("calendars")} />,
    api: (
      <IntegrationsPane
        title={titleOf("api")}
        description={t("integrations.api.description")}
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => window.electronAPI?.openExternal?.(API_DOCS_URL)}
            className="gap-1.5 text-muted-foreground"
          >
            {t("apiKeysSection.docsLink")}
            <ExternalLink className="h-3 w-3" />
          </Button>
        }
      >
        {isPaid ? (
          <>
            <ApiKeysSection createRequest={createKeyRequest} />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 ps-1 text-xs text-muted-foreground">
              <span>{t("integrations.api.useWith")}</span>
              {(
                [
                  ["mcp", McpIcon],
                  ["cli", CliIcon],
                ] as const
              ).map(([id, Icon]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => openSection(id)}
                  className="inline-flex items-center gap-1 rounded-sm text-primary/80 hover:text-primary outline-none focus-visible:ring-1 focus-visible:ring-primary/30 transition-colors"
                >
                  <Icon size={13} />
                  {titleOf(id)}
                </button>
              ))}
            </div>
          </>
        ) : (
          <UpsellBar message={t("integrations.api.proRequired")} onUpgrade={onUpgrade} />
        )}
      </IntegrationsPane>
    ),
    mcp: (
      <McpPane
        title={titleOf("mcp")}
        isPaid={isPaid}
        onUpgrade={onUpgrade}
        onCreateKey={() => {
          setCreateKeyRequest((request) => request + 1);
          openSection("api");
        }}
      />
    ),
    cli: <CliPane title={titleOf("cli")} isPaid={isPaid} onUpgrade={onUpgrade} />,
  };

  return (
    <div className="@container flex h-full min-h-0">
      <IntegrationsNav
        active={section}
        meta={meta}
        onSelect={onSectionChange}
        className="@max-2xl:hidden"
      />

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Outside the scroller, so it stays in view and keeps focus after a pick. */}
        <div className="px-5 pt-2 pb-2 @2xl:hidden">
          <Select
            value={section}
            onValueChange={(value) => onSectionChange(value as IntegrationsSection)}
          >
            <SelectTrigger
              className="h-8 w-full text-xs rounded-lg"
              aria-label={t("integrations.nav.label")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INTEGRATIONS_SECTIONS.map((id) => (
                <SelectItem key={id} value={id}>
                  {titleOf(id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto px-8 pt-2 pb-6 @max-2xl:px-5">
          <div className="max-w-[760px]">
            {INTEGRATIONS_SECTIONS.filter((id) => mounted.has(id)).map((id) => (
              <div
                key={id}
                ref={(element) => {
                  paneElements.current[id] = element;
                }}
                hidden={id !== section}
              >
                {panes[id]}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
