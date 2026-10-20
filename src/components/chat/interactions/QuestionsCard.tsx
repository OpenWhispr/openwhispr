import { useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "../../icons";
import { Checkbox } from "../../ui/checkbox";
import { RadioGroup } from "../../ui/radio-group";
import {
  commitQuestion,
  goToQuestion,
  updateInteractionDraft,
  type InteractionEntry,
} from "../../../stores/agentInteractionStore";
import type { InteractionPayload, InteractionQuestion } from "../../../types/agentInteractions";
import { cn } from "../../lib/utils";
import { CARD_FIELD, ICON_BUTTON, PILL_BUTTON } from "./cardStyles";
import { SubmitArrowButton } from "./SubmitArrowButton";

// Long enough to see the pick land before the next question replaces it.
const RADIO_COMMIT_MS = 200;

const NAV_BUTTON = cn(ICON_BUTTON, "size-6 disabled:opacity-30");

/**
 * One question at a time, with ‹ n/N › between them. Everything the user
 * picked or typed lives in the store, so it survives every layout change; a
 * recommended option is only labelled, never picked for the user.
 */
export function QuestionsCard({
  entry,
  payload,
}: {
  entry: InteractionEntry;
  payload: Extract<InteractionPayload, { kind: "questions" }>;
}): ReactElement {
  const { t } = useTranslation();
  // Not cleared on unmount: a card that remounts (Expand, the timed opening)
  // still moves on, and a commit for a question already left does nothing.
  const commitTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const { questions } = payload;
  const step = Math.min(entry.step, questions.length - 1);
  const question = questions[step];
  const value = entry.draft[question.id];
  const typed = entry.typedAnswers[question.id];
  const set = (next: string | string[]) =>
    updateInteractionDraft(entry.key, { ...entry.draft, [question.id]: next });
  const go = (next: number) => {
    clearTimeout(commitTimer.current);
    goToQuestion(entry.key, next);
  };
  const optionLabel = (option: NonNullable<InteractionQuestion["options"]>[number]) =>
    option.recommended
      ? t("agentMode.interactions.questions.recommended", { label: option.label })
      : option.label;

  return (
    <div>
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-[14px] font-medium text-foreground" dir="auto">
          {question.prompt}
        </p>
        {questions.length > 1 && (
          <div className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
            <button
              type="button"
              onClick={() => go(step - 1)}
              disabled={step === 0}
              aria-label={t("agentMode.interactions.questions.previous")}
              title={t("agentMode.interactions.questions.previous")}
              className={NAV_BUTTON}
            >
              <ChevronLeft size={14} className="rtl:rotate-180" />
            </button>
            <span className="tabular-nums">
              {t("agentMode.interactions.questions.position", {
                current: step + 1,
                total: questions.length,
              })}
            </span>
            <button
              type="button"
              onClick={() => go(step + 1)}
              disabled={step === questions.length - 1}
              aria-label={t("agentMode.interactions.questions.next")}
              title={t("agentMode.interactions.questions.next")}
              className={NAV_BUTTON}
            >
              <ChevronRight size={14} className="rtl:rotate-180" />
            </button>
          </div>
        )}
      </div>

      <div className="mt-2">
        {question.kind === "single" ? (
          <RadioGroup
            key={question.id}
            aria-label={question.prompt}
            options={(question.options ?? []).map((option) => ({
              value: option.id,
              label: optionLabel(option),
            }))}
            value={typeof value === "string" ? value : undefined}
            onValueChange={(id) => {
              set(id);
              clearTimeout(commitTimer.current);
              commitTimer.current = setTimeout(
                () => commitQuestion(entry.key, step),
                RADIO_COMMIT_MS
              );
            }}
          />
        ) : question.kind === "multiple" ? (
          <>
            <div role="group" aria-label={question.prompt} className="flex flex-col">
              {(question.options ?? []).map((option) => {
                const picked = Array.isArray(value) ? value : [];
                return (
                  <Checkbox
                    key={option.id}
                    checked={picked.includes(option.id)}
                    onChange={(checked) =>
                      set(
                        checked ? [...picked, option.id] : picked.filter((id) => id !== option.id)
                      )
                    }
                  >
                    {optionLabel(option)}
                  </Checkbox>
                );
              })}
            </div>
            <div className="mt-1 flex justify-end">
              <button
                type="button"
                // Nothing picked yet (a typed answer counts until a pick replaces it).
                disabled={!(Array.isArray(value) && value.length > 0) && typed === undefined}
                onClick={() => commitQuestion(entry.key, step)}
                className={PILL_BUTTON}
              >
                {t("agentMode.interactions.questions.continue")}
              </button>
            </div>
          </>
        ) : (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (typeof value === "string" && value.trim()) commitQuestion(entry.key, step);
            }}
          >
            <input
              dir="auto"
              aria-label={question.prompt}
              value={typeof value === "string" ? value : ""}
              placeholder={
                question.placeholder ?? t("agentMode.interactions.questions.placeholder")
              }
              onChange={(event) => set(event.target.value)}
              className={CARD_FIELD}
            />
            <SubmitArrowButton
              label={t("agentMode.interactions.questions.submit")}
              disabled={typeof value !== "string" || !value.trim()}
            />
          </form>
        )}
        {/* Answered in the composer; a pick replaces it. */}
        {question.kind !== "text" && typed !== undefined && value === undefined && (
          <p className="mt-1 text-xs text-muted-foreground" dir="auto">
            {t("agentMode.interactions.questions.typedAnswer", { answer: typed })}
          </p>
        )}
      </div>
    </div>
  );
}
