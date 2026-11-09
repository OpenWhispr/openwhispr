import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "../../icons";
import {
  confirmSettingsDone,
  openInteractionSettings,
  type InteractionEntry,
} from "../../../stores/agentInteractionStore";
import type { InteractionPayload } from "../../../types/agentInteractions";
import { cn } from "../../lib/utils";
import { PILL_BUTTON } from "./cardStyles";

/**
 * Something only Settings can fix: Open Settings, then Done, which checks it
 * again before the task carries on.
 */
export function SettingsCard({
  entry,
  payload,
}: {
  entry: InteractionEntry;
  payload: Extract<InteractionPayload, { kind: "settings" }>;
}): ReactElement {
  const { t } = useTranslation();
  const checking = entry.state === "working";
  return (
    <div>
      {payload.message && (
        <p className="text-[14px] text-foreground agent:text-[15px]" dir="auto">
          {payload.message}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => openInteractionSettings(entry.key)}
          className="rounded-sm text-[13px] font-medium text-primary hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/40 agent:text-[14px]"
        >
          {t("providerErrors.openSettings")}
        </button>
        {entry.settingsOpened && (
          <button
            type="button"
            disabled={checking}
            onClick={() => void confirmSettingsDone(entry.key)}
            className={cn(PILL_BUTTON, "ms-auto")}
          >
            {t(
              checking
                ? "agentMode.interactions.settings.checking"
                : "agentMode.interactions.settings.done"
            )}
          </button>
        )}
      </div>
      {payload.technicalDetails && (
        <details className="group mt-2 text-xs text-muted-foreground agent:text-[13px]">
          <summary className="flex cursor-pointer list-none items-center gap-1 select-none [&::-webkit-details-marker]:hidden">
            <ChevronRight
              size={12}
              className="transition-transform group-open:rotate-90 rtl:rotate-180 rtl:group-open:rotate-90"
            />
            {t("agentMode.interactions.settings.technicalDetails")}
          </summary>
          <pre
            dir="ltr"
            className="mt-1 whitespace-pre-wrap ps-4 font-mono text-[11px] agent:text-xs"
          >
            {payload.technicalDetails}
          </pre>
        </details>
      )}
    </div>
  );
}
