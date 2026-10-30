import { useState, type KeyboardEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { GithubDeviceCode } from "../connectors/GithubDeviceCode";
import {
  answerQuestions,
  answersComplete,
  cancelInteraction,
  confirmSettingsDone,
  connectInteraction,
  openInteractionSettings,
  respondToAccess,
  submitApiKey,
  updateInteractionDraft,
  type InteractionEntry,
} from "../../stores/agentInteractionStore";
import { CONNECTION_TARGET_NAMES, calendarProviders } from "../../config/agentCapabilities";
import type { CalendarProvider } from "../../utils/calendarConnect";

const CARD_CLASS = "my-1.5 rounded-lg border border-border/70 bg-surface-2/60 p-3 text-[13px]";

// Esc on the card (a field, an option, a button) must not reach the agent
// window, whose Esc cancels the whole turn and withdraws the card.
const keepEscape = (event: KeyboardEvent<HTMLElement>): void => {
  if (event.key === "Escape") event.stopPropagation();
};

function Questions({ entry }: { entry: InteractionEntry }): ReactElement | null {
  const { t } = useTranslation();
  if (entry.payload.kind !== "questions") return null;
  const { questions } = entry.payload;
  const set = (questionId: string, value: string | string[]) =>
    updateInteractionDraft(entry.key, { ...entry.draft, [questionId]: value });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        answerQuestions(entry.key);
      }}
    >
      {questions.map((question) => {
        const value = entry.draft[question.id];
        return (
          <fieldset key={question.id} className="mb-2">
            <legend className="mb-1 font-medium text-foreground" dir="auto">
              {question.prompt}
            </legend>
            {question.kind === "text" ? (
              <Input
                dir="auto"
                value={typeof value === "string" ? value : ""}
                placeholder={
                  question.placeholder ?? t("agentMode.interactions.questions.placeholder")
                }
                onChange={(event) => set(question.id, event.target.value)}
              />
            ) : (
              question.options?.map((option) => {
                const selected = Array.isArray(value)
                  ? value.includes(option.id)
                  : value === option.id;
                return (
                  <label key={option.id} className="flex items-center gap-2 py-0.5" dir="auto">
                    <input
                      type={question.kind === "single" ? "radio" : "checkbox"}
                      name={`${entry.key}:${question.id}`}
                      checked={selected}
                      onChange={() =>
                        set(
                          question.id,
                          question.kind === "single"
                            ? option.id
                            : selected
                              ? (value as string[]).filter((id) => id !== option.id)
                              : [...(Array.isArray(value) ? value : []), option.id]
                        )
                      }
                    />
                    <span>{option.label}</span>
                    {option.recommended && (
                      <span className="text-xs text-muted-foreground">
                        {t("agentMode.interactions.questions.recommended")}
                      </span>
                    )}
                  </label>
                );
              })
            )}
          </fieldset>
        );
      })}
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={!answersComplete(questions, entry.draft)}>
          {t("agentMode.interactions.questions.submit")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          onClick={() => cancelInteraction(entry.key)}
        >
          {t("agentMode.interactions.notNow")}
        </Button>
      </div>
    </form>
  );
}

function Connection({ entry }: { entry: InteractionEntry }): ReactElement | null {
  const { t } = useTranslation();
  // The calendar picked on a "connect a calendar" card.
  const [connecting, setConnecting] = useState<CalendarProvider>();
  if (entry.payload.kind !== "connection") return null;
  const { target, reason } = entry.payload;
  const working = entry.state === "working";
  const providers = target === "calendar" ? calendarProviders() : [undefined];
  // Apple Calendar asks for macOS permission; the others finish in the browser.
  const inBrowser = (connecting ?? target) !== "apple";
  return (
    <>
      <p className="font-medium text-foreground">
        {target === "calendar"
          ? t("agentMode.interactions.connection.calendarTitle")
          : t("agentMode.interactions.connection.title", { name: CONNECTION_TARGET_NAMES[target] })}
      </p>
      {reason && (
        <p className="text-xs text-muted-foreground" dir="auto">
          {reason}
        </p>
      )}
      {working && target === "github" && <GithubDeviceCode connectorId="github" />}
      <div role="status" className="text-xs">
        {working && inBrowser && (
          <p className="mt-2 text-muted-foreground">
            {t("agentMode.interactions.connection.connecting")}
          </p>
        )}
        {entry.error && (
          <p className="mt-2 text-destructive">
            {t(
              entry.error === "permission_denied"
                ? "agentMode.interactions.connection.permissionDenied"
                : "agentMode.interactions.connection.failed"
            )}
          </p>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {!working &&
          providers.map((provider) => (
            <Button
              key={provider ?? target}
              size="sm"
              onClick={() => {
                setConnecting(provider);
                void connectInteraction(entry.key, provider);
              }}
            >
              {t("agentMode.interactions.connection.connect", {
                name: CONNECTION_TARGET_NAMES[provider ?? target],
              })}
            </Button>
          ))}
        <Button size="sm" variant="ghost" onClick={() => cancelInteraction(entry.key)}>
          {t(working ? "agentMode.interactions.cancel" : "agentMode.interactions.notNow")}
        </Button>
      </div>
    </>
  );
}

function Access({ entry }: { entry: InteractionEntry }): ReactElement | null {
  const { t } = useTranslation();
  if (entry.payload.kind !== "access") return null;
  return (
    <>
      <p className="font-medium text-foreground">{t("agentMode.interactions.access.screen")}</p>
      <p className="text-xs text-muted-foreground" dir="auto">
        {entry.payload.reason}
      </p>
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          disabled={entry.state === "working"}
          onClick={() => void respondToAccess(entry.key, true)}
        >
          {t("agentMode.interactions.access.allow")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void respondToAccess(entry.key, false)}>
          {t("agentMode.interactions.notNow")}
        </Button>
      </div>
    </>
  );
}

// The key lives only in this field until Save hands it to the secure saver.
function ApiKey({ entry }: { entry: InteractionEntry }): ReactElement | null {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  if (entry.payload.kind !== "apiKey") return null;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submitApiKey(entry.key, value);
        setValue("");
      }}
    >
      <p className="font-medium text-foreground">
        {t("agentMode.interactions.apiKey.title", { provider: entry.payload.providerName })}
      </p>
      {entry.payload.reason && (
        <p className="text-xs text-muted-foreground" dir="auto">
          {entry.payload.reason}
        </p>
      )}
      <Input
        className="mt-2"
        dir="ltr"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={t("agentMode.interactions.apiKey.placeholder")}
        aria-label={t("agentMode.interactions.apiKey.placeholder")}
        onChange={(event) => setValue(event.target.value)}
      />
      <div className="mt-2 flex gap-2">
        <Button size="sm" type="submit" disabled={!value.trim()}>
          {t("agentMode.interactions.apiKey.save")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          onClick={() => cancelInteraction(entry.key)}
        >
          {t("agentMode.interactions.notNow")}
        </Button>
      </div>
    </form>
  );
}

function SettingsLink({ entry }: { entry: InteractionEntry }): ReactElement | null {
  const { t } = useTranslation();
  if (entry.payload.kind !== "settings") return null;
  const { message, technicalDetails } = entry.payload;
  return (
    <>
      {message && (
        <p className="text-foreground" dir="auto">
          {message}
        </p>
      )}
      {technicalDetails && (
        <details className="mt-1 text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            {t("agentMode.interactions.settings.technicalDetails")}
          </summary>
          <pre dir="ltr" className="mt-1 whitespace-pre-wrap">
            {technicalDetails}
          </pre>
        </details>
      )}
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="outline" onClick={() => openInteractionSettings(entry.key)}>
          {t("providerErrors.openSettings")}
        </Button>
        <Button
          size="sm"
          disabled={entry.state === "working"}
          onClick={() => void confirmSettingsDone(entry.key)}
        >
          {t("agentMode.interactions.settings.done")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => cancelInteraction(entry.key)}>
          {t("agentMode.interactions.notNow")}
        </Button>
      </div>
    </>
  );
}

/** Minimal controls for an interaction the turn is waiting on; Phase 3 replaces the visuals. */
export function InteractionCard({ entry }: { entry: InteractionEntry }): ReactElement {
  return (
    <div
      data-interaction-card={entry.key}
      data-kind={entry.payload.kind}
      onKeyDown={keepEscape}
      className={CARD_CLASS}
    >
      <Questions entry={entry} />
      <Connection entry={entry} />
      <Access entry={entry} />
      <ApiKey entry={entry} />
      <SettingsLink entry={entry} />
    </div>
  );
}
