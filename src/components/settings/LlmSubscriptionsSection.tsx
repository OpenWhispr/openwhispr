import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/dialog";
import { CopyableCommand } from "../ui/CopyableCommand";
import { InfoBox } from "../ui/InfoBox";
import { Input } from "../ui/input";
import { SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { Toggle } from "../ui/toggle";
import { useLlmCliProviders } from "../../hooks/useLlmCliProviders";
import { getProvider } from "../../helpers/llmCliProviders.js";
import {
  SEATS,
  errorMessageKey,
  installDialogModel,
  seatViewModel,
  signInPromptModel,
  signOutConfirmModel,
} from "../../helpers/llmCli/llmCliSeatView.js";
import type { LlmCliSeat } from "../../types/electron";

// Subscriptions: the user's own Claude, Codex, Grok and Antigravity CLI sign-ins used as
// chat and agent providers. Every decision comes from llmCliSeatView.js; main owns the
// processes and the secrets, and never sends a token here.

function currentPlatform(): string {
  if (typeof navigator === "undefined") return "win32";
  if (/Win/i.test(navigator.platform)) return "win32";
  if (/Mac/i.test(navigator.platform)) return "darwin";
  return "linux";
}

export default function LlmSubscriptionsSection() {
  const { t } = useTranslation();
  const cli = useLlmCliProviders();
  const platform = currentPlatform();
  const [installSeat, setInstallSeat] = useState<LlmCliSeat | null>(null);
  const [signOutSeat, setSignOutSeat] = useState<LlmCliSeat | null>(null);
  const [signOutGuideSeat, setSignOutGuideSeat] = useState<LlmCliSeat | null>(null);
  const [claudeCode, setClaudeCode] = useState("");

  const labelOf = (seat: LlmCliSeat) => getProvider(seat)?.label ?? seat;
  const installModel = installSeat ? installDialogModel(installSeat, platform) : null;
  const signOutModel = signOutSeat ? signOutConfirmModel(signOutSeat) : null;

  const openGuide = (seat: LlmCliSeat) => {
    const model = installDialogModel(seat, platform);
    if (model.url) void window.electronAPI?.openExternal?.(model.url);
  };

  const requestSignOut = (seat: LlmCliSeat) => {
    if (signOutConfirmModel(seat).required) setSignOutSeat(seat);
    else setSignOutGuideSeat(seat);
  };

  const submitClaudeCode = () => {
    const code = claudeCode.trim();
    if (!code) return;
    setClaudeCode("");
    void cli.submitCode("claude", code);
  };

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
        {SEATS.map((seat: LlmCliSeat) => {
          const view = seatViewModel(seat, cli.seats[seat], cli.prefs, platform);
          const errorKey = errorMessageKey(cli.errors[seat]) ?? view.errorKey;
          const prompt = signInPromptModel(seat, cli.prompts[seat]);
          const lines = cli.installLines[seat] ?? [];
          const has = (action: string) => view.actions.includes(action);
          return (
            <SettingsPanelRow key={seat}>
              <SettingsRow label={labelOf(seat)} description={t(`llmSubscriptions.seats.${seat}`)}>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {view.showToggle && (
                    <Toggle
                      checked={!!view.claudeEnabled}
                      onChange={(value) => void cli.setClaudeEnabled(value)}
                      ariaLabel={t("llmSubscriptions.claude.toggleLabel")}
                    />
                  )}
                  {!view.disabled && (
                    <span className="text-[13px] text-muted-foreground">
                      {t(view.statusKey)}
                      {view.version
                        ? ` ${t("llmSubscriptions.version", { version: view.version })}`
                        : ""}
                    </span>
                  )}
                  {has("install") && (
                    <Button size="sm" onClick={() => setInstallSeat(seat)}>
                      {t("llmSubscriptions.actions.install")}
                    </Button>
                  )}
                  {has("openGuide") && (
                    <Button size="sm" onClick={() => openGuide(seat)}>
                      {t("llmSubscriptions.actions.openGuide")}
                    </Button>
                  )}
                  {has("signin") && (
                    <Button size="sm" onClick={() => void cli.signIn(seat)}>
                      {t("llmSubscriptions.actions.signIn")}
                    </Button>
                  )}
                  {has("test") && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={cli.testing[seat]}
                      onClick={() => void cli.test(seat)}
                    >
                      {t("llmSubscriptions.actions.test")}
                    </Button>
                  )}
                  {has("signout") && (
                    <Button variant="outline" size="sm" onClick={() => requestSignOut(seat)}>
                      {t("llmSubscriptions.actions.signOut")}
                    </Button>
                  )}
                  {has("redetect") && (
                    <Button variant="outline" size="sm" onClick={() => void cli.detect()}>
                      {t("llmSubscriptions.actions.redetect")}
                    </Button>
                  )}
                  {has("cancelInstall") && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void cli.cancelInstall(seat)}
                    >
                      {t("llmSubscriptions.actions.cancel")}
                    </Button>
                  )}
                  {has("cancelSignin") && (
                    <Button variant="outline" size="sm" onClick={() => void cli.cancelSignIn(seat)}>
                      {t("llmSubscriptions.actions.cancel")}
                    </Button>
                  )}
                </div>
              </SettingsRow>

              {view.noticeKey && (
                <p className="mt-2 text-xs text-muted-foreground">{t(view.noticeKey)}</p>
              )}
              {has("openGuide") && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t("llmSubscriptions.install.guided")}
                </p>
              )}
              {view.hintKey && (
                <p className="mt-2 text-xs text-muted-foreground">{t(view.hintKey)}</p>
              )}
              {view.status === "installing" && lines.length > 0 && (
                <pre
                  dir="ltr"
                  className="mt-2 max-h-24 overflow-auto rounded-md border border-border bg-card p-2 font-mono text-[11px] text-muted-foreground"
                >
                  {lines.join("\n")}
                </pre>
              )}

              {prompt && (
                <div className="mt-3 space-y-2">
                  {prompt.kind === "guide" ? (
                    <>
                      <p className="text-xs text-foreground">{t(prompt.guideKey)}</p>
                      <CopyableCommand
                        command="agy"
                        copyLabel={t("llmSubscriptions.actions.copy")}
                      />
                    </>
                  ) : (
                    <>
                      {prompt.url && (
                        <div>
                          <p className="mb-1 text-xs text-muted-foreground">
                            {t(
                              prompt.kind === "claude-code"
                                ? "llmSubscriptions.signIn.claudeInstructions"
                                : "llmSubscriptions.signIn.deviceUrlLabel"
                            )}
                          </p>
                          <p dir="ltr" className="break-all font-mono text-xs text-foreground">
                            {prompt.url}
                          </p>
                          {prompt.canOpenUrl && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="mt-2"
                              onClick={() => void window.electronAPI?.openExternal?.(prompt.url)}
                            >
                              {t("llmSubscriptions.actions.openInBrowser")}
                            </Button>
                          )}
                        </div>
                      )}
                      {prompt.code && (
                        <CopyableCommand
                          command={prompt.code}
                          label={t("llmSubscriptions.signIn.deviceCodeLabel")}
                          copyLabel={t("llmSubscriptions.actions.copy")}
                        />
                      )}
                      {prompt.showCodeInput && (
                        <div className="flex items-center gap-2">
                          <Input
                            dir="ltr"
                            autoComplete="off"
                            spellCheck={false}
                            value={claudeCode}
                            aria-label={t("llmSubscriptions.signIn.codeLabel")}
                            placeholder={t("llmSubscriptions.signIn.codePlaceholder")}
                            onChange={(e) => setClaudeCode(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") submitClaudeCode();
                            }}
                          />
                          <Button
                            size="sm"
                            disabled={!claudeCode.trim()}
                            onClick={submitClaudeCode}
                          >
                            {t("llmSubscriptions.actions.submitCode")}
                          </Button>
                        </div>
                      )}
                      {!prompt.showCodeInput && (
                        <p className="text-xs text-muted-foreground">
                          {t("llmSubscriptions.signIn.waiting")}
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}

              {signOutGuideSeat === seat && (
                <InfoBox variant="info" className="mt-3 p-3">
                  <p className="text-[13px] text-foreground">
                    {t(signOutConfirmModel(seat).messageKey)}
                  </p>
                </InfoBox>
              )}
              {cli.testOk[seat] && (
                <p className="mt-2 text-[13px] text-success">{t("llmSubscriptions.testOk")}</p>
              )}
              {errorKey && (
                <InfoBox variant="warning" className="mt-3 p-3">
                  <p className="text-[13px] text-foreground">{t(errorKey)}</p>
                </InfoBox>
              )}
            </SettingsPanelRow>
          );
        })}
      </SettingsPanel>

      {installSeat && installModel?.kind === "script" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setInstallSeat(null);
          }}
          title={t("llmSubscriptions.install.title", { seat: labelOf(installSeat) })}
          description={t("llmSubscriptions.install.description")}
          confirmText={t("llmSubscriptions.install.confirm")}
          cancelText={t("llmSubscriptions.actions.cancel")}
          onConfirm={() => void cli.install(installSeat, installModel.confirmUrl)}
        >
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-xs text-muted-foreground">
                {t("llmSubscriptions.install.urlLabel")}
              </p>
              <p dir="ltr" className="break-all font-mono text-xs text-foreground">
                {installModel.url}
              </p>
            </div>
            <CopyableCommand
              command={installModel.command}
              label={t("llmSubscriptions.install.commandLabel")}
              copyLabel={t("llmSubscriptions.actions.copy")}
            />
          </div>
        </ConfirmDialog>
      )}

      {signOutSeat && signOutModel?.required && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setSignOutSeat(null);
          }}
          variant="destructive"
          title={t("llmSubscriptions.signOut.title", { seat: labelOf(signOutSeat) })}
          description={t(signOutModel.messageKey, { seat: labelOf(signOutSeat) })}
          confirmText={t("llmSubscriptions.signOut.confirm")}
          cancelText={t("llmSubscriptions.actions.cancel")}
          onConfirm={() => void cli.signOut(signOutSeat)}
        />
      )}
    </div>
  );
}
