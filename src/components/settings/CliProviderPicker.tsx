import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { useLlmCliProviders } from "../../hooks/useLlmCliProviders";
import { setResolvedLLMConfig } from "../../stores/settingsStore";
import type { InferenceScope } from "../../config/inferenceScopes";
import { CLI_DEFAULT_MODEL, cliPickerSeats } from "../../helpers/llmCli/llmCliRouting.js";
import { OPEN_SETTINGS_SECTION_EVENT } from "../../helpers/llmCli/subscriptionMode.js";

// Subscription CLI group of the provider picker. The caller mounts it only for scopes the
// allowlist offers (chat and the dictation agent); it lists signed-in, enabled seats and
// shows a link to the Subscriptions page when there are none. Dictation cleanup never mounts it (D-03).
interface CliProviderPickerProps {
  scope: InferenceScope;
  provider: string;
  model: string;
}

export default function CliProviderPicker({ scope, provider, model }: CliProviderPickerProps) {
  const { t } = useTranslation();
  const cli = useLlmCliProviders();
  const seats = cliPickerSeats(scope, cli.prefs, cli.seats);
  if (seats.length === 0) {
    return (
      <div className="space-y-2 pt-1">
        <p className="text-xs text-muted-foreground">{t("llmSubscriptions.picker.empty")}</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: "subscriptions" })
            )
          }
        >
          {t("llmSubscriptions.picker.openSubscriptions")}
        </Button>
      </div>
    );
  }
  const active = seats.find((s) => s.id === provider);

  return (
    <div className="space-y-2 pt-1">
      <h4 className="text-sm font-medium text-foreground">{t("llmSubscriptions.picker.group")}</h4>
      <p className="text-xs text-muted-foreground">{t("llmSubscriptions.picker.helper")}</p>
      <div className="flex flex-wrap items-center gap-2">
        {seats.map((seat) => (
          <Button
            key={seat.id}
            type="button"
            size="sm"
            variant={active?.id === seat.id ? "default" : "outline"}
            onClick={() =>
              setResolvedLLMConfig(scope, {
                mode: "providers",
                cloudMode: "byok",
                provider: seat.id,
                model: CLI_DEFAULT_MODEL,
              })
            }
          >
            {seat.label}
          </Button>
        ))}
        {active && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setResolvedLLMConfig(scope, { provider: "", model: "" })}
          >
            {t("llmSubscriptions.picker.useApi")}
          </Button>
        )}
      </div>
      {active && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {t("llmSubscriptions.picker.modelLabel")}
          </span>
          <Select
            value={model || CLI_DEFAULT_MODEL}
            onValueChange={(value) => setResolvedLLMConfig(scope, { model: value })}
          >
            <SelectTrigger className="h-7 w-56 shrink-0 text-xs rounded-lg px-2.5 [&>svg]:h-3 [&>svg]:w-3">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                value={CLI_DEFAULT_MODEL}
                className="text-xs py-1.5 ps-2.5 pe-7 rounded-md"
              >
                {t("llmSubscriptions.picker.defaultModel")}
              </SelectItem>
              {active.models.map((id: string) => (
                <SelectItem key={id} value={id} className="text-xs py-1.5 ps-2.5 pe-7 rounded-md">
                  {id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
