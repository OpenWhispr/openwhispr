import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { respondToAccess, type InteractionEntry } from "../../../stores/agentInteractionStore";
import { cn } from "../../lib/utils";
import type { InteractionPayload } from "../../../types/agentInteractions";
import { PILL_BUTTON, PRIMARY_PILL_BUTTON } from "./cardStyles";

/** A one-off grant (the screen): Allow continues with it, Not now continues without. */
export function AccessCard({
  entry,
  payload,
}: {
  entry: InteractionEntry;
  payload: Extract<InteractionPayload, { kind: "access" }>;
}): ReactElement {
  const { t } = useTranslation();
  const capturing = entry.state === "working";
  return (
    <div>
      <p className="text-[14px] font-medium text-foreground agent:text-[15px]">
        {t("agentMode.interactions.access.screen")}
      </p>
      <p className="text-xs text-muted-foreground agent:text-[13px]" dir="auto">
        {payload.reason}
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => void respondToAccess(entry.key, false)}
          className={cn(PILL_BUTTON, "text-muted-foreground")}
        >
          {t("agentMode.interactions.notNow")}
        </button>
        <button
          type="button"
          disabled={capturing}
          onClick={() => void respondToAccess(entry.key, true)}
          className={PRIMARY_PILL_BUTTON}
        >
          {t(
            capturing
              ? "agentMode.interactions.access.capturing"
              : "agentMode.interactions.access.allow"
          )}
        </button>
      </div>
    </div>
  );
}
