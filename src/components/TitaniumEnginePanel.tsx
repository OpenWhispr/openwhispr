import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { SettingsPanel, SettingsPanelRow } from "./ui/SettingsSection";
import { useTitaniumAuth } from "../hooks/useTitaniumAuth";
import { resolveTitaniumEngineState } from "../helpers/titanium/titaniumOnboardingPolicy.js";

/** License state for the EdgeAssistant cloud engine: no endpoint, key or model fields. */
export default function TitaniumEnginePanel() {
  const { t, i18n } = useTranslation();
  const auth = useTitaniumAuth();
  const state = resolveTitaniumEngineState(auth);
  const expiry = auth.license?.expiry ? new Date(auth.license.expiry) : null;

  return (
    <SettingsPanel>
      <SettingsPanelRow>
        <div className="flex items-center justify-between gap-3">
          {state === "signedOut" && (
            <>
              <p className="text-xs text-muted-foreground">
                {t("transcription.titaniumSignIn.message")}
              </p>
              <Button
                type="button"
                size="sm"
                onClick={() => void auth.signIn()}
                disabled={auth.pending}
              >
                {t("transcription.titaniumSignIn.action")}
              </Button>
            </>
          )}
          {state === "noLicense" && (
            <>
              <p className="text-xs text-muted-foreground">
                {t("transcription.titaniumNoLicense.message")}
              </p>
              <Button type="button" size="sm" onClick={() => void auth.refresh()}>
                {t("settingsPage.transcription.titaniumEngine.retry")}
              </Button>
            </>
          )}
          {state === "licensed" && (
            <div>
              <p className="text-xs font-medium text-foreground">
                {t("settingsPage.transcription.titaniumEngine.connected")}
              </p>
              {expiry && !Number.isNaN(expiry.getTime()) && (
                <p className="text-xs text-muted-foreground">
                  {t("settingsPage.transcription.titaniumEngine.expires", {
                    date: expiry.toLocaleDateString(i18n.language),
                  })}
                </p>
              )}
            </div>
          )}
        </div>
      </SettingsPanelRow>
    </SettingsPanel>
  );
}
