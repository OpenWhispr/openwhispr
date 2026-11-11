import type { InteractionQuestion } from "../types/agentInteractions";

/** An answer as the user reads it: the chosen option's label, or the typed text. */
export function optionLabel(question: InteractionQuestion, id: string): string {
  return question.options?.find((option) => option.id === id)?.label ?? id;
}

/** One question's answer as text: the chosen labels, or the typed text. */
export function answerText(
  question: InteractionQuestion,
  answer: string | string[] | undefined
): string {
  return Array.isArray(answer)
    ? answer.map((id) => optionLabel(question, id)).join(", ")
    : optionLabel(question, answer ?? "");
}
