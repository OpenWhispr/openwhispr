import type { KeyboardEvent, ReactElement } from "react";
import { cancelInteraction, type InteractionEntry } from "../../stores/agentInteractionStore";
import { QuestionsCard } from "./interactions/QuestionsCard";
import { ConnectionCard } from "./interactions/ConnectionCard";
import { AccessCard } from "./interactions/AccessCard";
import { ApiKeyCard } from "./interactions/ApiKeyCard";
import { SettingsCard } from "./interactions/SettingsCard";

// Cards with no dismiss control of their own; Esc inside one dismisses it.
const DISMISSED_BY_ESCAPE = new Set(["questions", "apiKey", "settings"]);

function CardBody({ entry }: { entry: InteractionEntry }): ReactElement {
  const { payload } = entry;
  switch (payload.kind) {
    case "questions":
      return <QuestionsCard entry={entry} payload={payload} />;
    case "connection":
      return <ConnectionCard entry={entry} payload={payload} />;
    case "access":
      return <AccessCard entry={entry} payload={payload} />;
    case "apiKey":
      return <ApiKeyCard entry={entry} payload={payload} />;
    case "settings":
      return <SettingsCard entry={entry} payload={payload} />;
  }
}

/** A question, connection, access, key or settings card the turn is waiting on. */
export function InteractionCard({ entry }: { entry: InteractionEntry }): ReactElement {
  // Esc never reaches the agent window, whose Esc cancels the whole turn. On a
  // card without its own dismiss control it dismisses that card: the turn goes
  // on, and the model hears the user said no.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    if (event.nativeEvent.isComposing || !DISMISSED_BY_ESCAPE.has(entry.payload.kind)) return;
    event.preventDefault();
    cancelInteraction(entry.key);
  };
  return (
    <div
      data-interaction-card={entry.key}
      data-kind={entry.payload.kind}
      onKeyDown={onKeyDown}
      className="my-1.5 rounded-2xl bg-surface-1 p-3.5 text-[13px]"
    >
      <CardBody entry={entry} />
    </div>
  );
}
