import {
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
} from "react";
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

// The card's text or key field, else its option to start from, else the card.
function focusCard(root: HTMLElement): void {
  const target =
    root.querySelector<HTMLElement>("input, textarea") ??
    root.querySelector<HTMLElement>('[role="radio"][tabindex="0"], [role="checkbox"]') ??
    root;
  target.focus({ preventScroll: true });
}

const focusLost = (): boolean =>
  !document.activeElement || document.activeElement === document.body;

/**
 * Keeps the keyboard in the card, so Esc reaches it: when the card appears in
 * a focused window with nothing focused (the composer it replaced went away),
 * when a change on the card (the next question, Done appearing, a connect
 * starting) removes the control that had focus, and when the window is given
 * the keyboard with nothing focused (Windows and Linux, for a card that needs
 * typing).
 */
function useCardFocus(rootRef: RefObject<HTMLDivElement | null>, shape: string): void {
  const shapeRef = useRef(shape);
  useLayoutEffect(() => {
    if (rootRef.current && document.hasFocus() && focusLost()) focusCard(rootRef.current);
  }, [rootRef]);
  useLayoutEffect(() => {
    if (shapeRef.current === shape) return;
    shapeRef.current = shape;
    if (rootRef.current && focusLost()) focusCard(rootRef.current);
  }, [rootRef, shape]);
  useEffect(() => {
    const onWindowFocus = () => {
      if (rootRef.current && focusLost()) focusCard(rootRef.current);
    };
    window.addEventListener("focus", onWindowFocus);
    return () => window.removeEventListener("focus", onWindowFocus);
  }, [rootRef]);
}

/** A question, connection, access, key or settings card the turn is waiting on. */
export function InteractionCard({ entry }: { entry: InteractionEntry }): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  useCardFocus(
    rootRef,
    [entry.step, entry.state, entry.settingsOpened, entry.error].map(String).join("|")
  );
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
      ref={rootRef}
      tabIndex={-1}
      data-interaction-card={entry.key}
      data-kind={entry.payload.kind}
      onKeyDown={onKeyDown}
      className="my-1.5 rounded-2xl bg-surface-1 p-3.5 text-[13px] outline-none"
    >
      <CardBody entry={entry} />
    </div>
  );
}
