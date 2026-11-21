import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { InfoBox } from "../ui/InfoBox";
import { SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { useLlmCliProviders } from "../../hooks/useLlmCliProviders";
import { getProvider } from "../../helpers/llmCliProviders.js";
import { errorMessageKey, seatViewModel } from "../../helpers/llmCli/llmCliSeatView.js";
import type { LlmCliSeat } from "../../types/electron";

// Subscriptions: the user's own Claude, Codex, Grok and Antigravity CLI sign-ins used as
// chat and agent providers. Every decision comes from llmCliSeatView.js; main owns the
// processes and the secrets.
const VISIBLE_SEATS: LlmCliSeat[] = ["codex"];

export default function LlmSubscriptionsSection() {
  const { t } = useTranslation();
  const cli = useLlmCliProviders();
  const platform =
    typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "darwin" : "win32";

  return (
    <div>
      <div className="mb-5">
        <h3 className="text-base font-normal! tracking-normal! text-foreground">
          {t("llmSubscriptions.title")}
        </h3>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {t("llmSubscriptions.description")}
        </p>
      </div>

      <SettingsPanel className="mb-6">
        {VISIBLE_SEATS.map((seat) => {
          const view = seatViewModel(seat, cli.seats[seat], cli.prefs, platform);
          const errorKey = errorMessageKey(cli.errors[seat]) ?? view.errorKey;
          const label = getProvider(seat)?.label ?? seat;
          return (
            <SettingsPanelRow key={seat}>
              <SettingsRow label={label} description={t(`llmSubscriptions.seats.${seat}`)}>
                <div className="flex items-center gap-2">
                  <span className="text-[13px] text-muted-foreground">
                    {t(view.statusKey)}
                    {view.version
                      ? ` ${t("llmSubscriptions.version", { version: view.version })}`
                      : ""}
                  </span>
                  {view.actions.includes("test") && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={cli.testing[seat]}
                      onClick={() => void cli.test(seat)}
                    >
                      {t("llmSubscriptions.actions.test")}
                    </Button>
                  )}
                  {view.actions.includes("redetect") && (
                    <Button variant="outline" size="sm" onClick={() => void cli.detect()}>
                      {t("llmSubscriptions.actions.redetect")}
                    </Button>
                  )}
                </div>
              </SettingsRow>
              {cli.testOk[seat] && (
                <p className="px-4 pb-3 text-[13px] text-success">{t("llmSubscriptions.testOk")}</p>
              )}
              {errorKey && (
                <InfoBox variant="warning" className="mx-4 mb-3 p-3">
                  <p className="text-[13px] text-foreground">{t(errorKey)}</p>
                </InfoBox>
              )}
            </SettingsPanelRow>
          );
        })}
      </SettingsPanel>
    </div>
  );
}
