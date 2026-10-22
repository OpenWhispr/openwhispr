import { useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "../../icons";
import { submitApiKey, type InteractionEntry } from "../../../stores/agentInteractionStore";
import type { InteractionPayload } from "../../../types/agentInteractions";
import { CARD_FIELD } from "./cardStyles";
import { SubmitArrowButton } from "./SubmitArrowButton";

type ApiKeyPayload = Extract<InteractionPayload, { kind: "apiKey" }>;

/**
 * A masked field for a provider key. The key lives only in the field itself
 * (uncontrolled, so React never copies it into state or the value attribute)
 * until ↑ hands it to the secure saver: never in the store, and lost on a
 * remount. It takes focus when it appears in a focused window with nothing
 * being typed, so a key is never pasted into the composer instead, and a
 * message being typed never lands in it.
 */
export function ApiKeyCard({
  entry,
  payload,
}: {
  entry: InteractionEntry;
  payload: ApiKeyPayload;
}): ReactElement {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [hasValue, setHasValue] = useState(false);
  return (
    <div>
      <p className="text-[14px] font-medium text-foreground agent:text-[15px]">
        {t("agentMode.interactions.apiKey.title", { provider: payload.providerName })}
      </p>
      {payload.reason && (
        <p className="text-xs text-muted-foreground agent:text-[13px]" dir="auto">
          {payload.reason}
        </p>
      )}
      <form
        className="mt-2 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const input = inputRef.current;
          if (!input?.value.trim()) return;
          void submitApiKey(entry.key, input.value);
          input.value = "";
          setHasValue(false);
        }}
      >
        <input
          ref={inputRef}
          dir="ltr"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={t("agentMode.interactions.apiKey.placeholder")}
          aria-label={t("agentMode.interactions.apiKey.label", {
            provider: payload.providerName,
          })}
          onChange={(event) => setHasValue(event.target.value.trim() !== "")}
          className={CARD_FIELD}
        />
        <SubmitArrowButton label={t("agentMode.interactions.apiKey.save")} disabled={!hasValue} />
      </form>
    </div>
  );
}

/** What a saved key leaves in the chat: that it was saved, never the key. */
export function ApiKeySavedRow({ payload }: { payload: ApiKeyPayload }): ReactElement {
  const { t } = useTranslation();
  return (
    <p
      data-api-key-saved=""
      className="flex items-center gap-1.5 text-xs text-muted-foreground agent:text-[13px]"
    >
      <Check size={13} className="text-success" />
      {t("agentMode.interactions.apiKey.saved", { provider: payload.providerName })}
    </p>
  );
}
