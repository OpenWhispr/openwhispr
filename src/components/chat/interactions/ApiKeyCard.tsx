import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "../../icons";
import { submitApiKey, type InteractionEntry } from "../../../stores/agentInteractionStore";
import type { InteractionPayload } from "../../../types/agentInteractions";
import { CARD_FIELD } from "./cardStyles";
import { SubmitArrowButton } from "./SubmitArrowButton";

type ApiKeyPayload = Extract<InteractionPayload, { kind: "apiKey" }>;

/**
 * A masked field for a provider key. The key lives only in this field until
 * ↑ hands it to the secure saver: never in the store, and lost on a remount.
 */
export function ApiKeyCard({
  entry,
  payload,
}: {
  entry: InteractionEntry;
  payload: ApiKeyPayload;
}): ReactElement {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  return (
    <div>
      <p className="text-[14px] font-medium text-foreground">
        {t("agentMode.interactions.apiKey.title", { provider: payload.providerName })}
      </p>
      {payload.reason && (
        <p className="text-xs text-muted-foreground" dir="auto">
          {payload.reason}
        </p>
      )}
      <form
        className="mt-2 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!value.trim()) return;
          void submitApiKey(entry.key, value);
          setValue("");
        }}
      >
        <input
          dir="ltr"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={t("agentMode.interactions.apiKey.placeholder")}
          aria-label={t("agentMode.interactions.apiKey.label", {
            provider: payload.providerName,
          })}
          onChange={(event) => setValue(event.target.value)}
          className={CARD_FIELD}
        />
        <SubmitArrowButton
          label={t("agentMode.interactions.apiKey.save")}
          disabled={!value.trim()}
        />
      </form>
    </div>
  );
}

/** What a saved key leaves in the chat: that it was saved, never the key. */
export function ApiKeySavedRow({ payload }: { payload: ApiKeyPayload }): ReactElement {
  const { t } = useTranslation();
  return (
    <p data-api-key-saved="" className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Check size={13} className="text-success" />
      {t("agentMode.interactions.apiKey.saved", { provider: payload.providerName })}
    </p>
  );
}
