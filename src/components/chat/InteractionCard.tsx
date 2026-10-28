import {
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactElement,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { Check } from "../icons";
import {
  CARDS_WITHOUT_DISMISS,
  cancelInteraction,
  type InteractionEntry,
} from "../../stores/agentInteractionStore";
import { answerText } from "../../utils/interactionAnswers";
import { interactionOutcome } from "./toolCallText";
import { QuestionsCard } from "./interactions/QuestionsCard";
import { ConnectionCard } from "./interactions/ConnectionCard";
import { AccessCard } from "./interactions/AccessCard";
import { ApiKeyCard } from "./interactions/ApiKeyCard";
import { SettingsCard } from "./interactions/SettingsCard";

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

// A composer with nothing in it: a card with a key field takes the keyboard
// from it, so a pasted key never lands in the message.
const emptyComposerFocused = (): boolean => {
  const active = document.activeElement;
  return active?.tagName === "TEXTAREA" && (active as HTMLTextAreaElement).value === "";
};

// A message being written in a composer, even one not focused yet (the agent
// window's modal composer takes the keyboard once its fade ends).
const draftInProgress = (): boolean =>
  [...document.querySelectorAll("textarea")].some(
    (field) =>
      field.value.trim() !== "" && !field.closest("[data-interaction-card], [data-approval-card]")
  );

/**
 * Keeps the keyboard in the card, so Esc reaches it: when the card appears in
 * a focused window with nothing focused (the composer it replaced went away),
 * or a key card with an empty composer focused, and no message being written;
 * when a change on the card (the next question, Done appearing, a connect
 * starting) removes the control that had focus; and when the window is given
 * the keyboard with nothing focused (Windows and Linux, for a card that needs
 * typing), or, for a key card, with an empty composer focused and no message
 * being written (the user coming back by window focus alone, Alt-Tab, to a
 * key card that arrived while they were away). A card restored from a turn
 * that ended never takes it on its own.
 */
function useCardFocus(
  rootRef: RefObject<HTMLDivElement | null>,
  shape: string,
  { restored, keyField }: { restored: boolean; keyField: boolean }
): void {
  const shapeRef = useRef(shape);
  useLayoutEffect(() => {
    if (!rootRef.current || restored || !document.hasFocus() || draftInProgress()) return;
    if (
      focusLost() ||
      document.activeElement === rootRef.current.parentElement ||
      (keyField && emptyComposerFocused())
    )
      focusCard(rootRef.current);
  }, [keyField, restored, rootRef]);
  useLayoutEffect(() => {
    if (shapeRef.current === shape) return;
    shapeRef.current = shape;
    if (rootRef.current && focusLost()) focusCard(rootRef.current);
  }, [rootRef, shape]);
  useEffect(() => {
    if (restored) return;
    const onWindowFocus = () => {
      if (!rootRef.current) return;
      if (focusLost() || (keyField && emptyComposerFocused() && !draftInProgress())) {
        focusCard(rootRef.current);
      }
    };
    window.addEventListener("focus", onWindowFocus);
    return () => window.removeEventListener("focus", onWindowFocus);
  }, [keyField, restored, rootRef]);
}

/** A question, connection, access, key or settings card the turn is waiting on. */
export function InteractionCard({
  entry,
  heightRef,
}: {
  entry: InteractionEntry;
  /** Kept up to date with the card's height, for the outcome row that replaces it. */
  heightRef?: MutableRefObject<number>;
}): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  // The space the card takes, margins included, so the row that replaces it
  // starts exactly there.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!heightRef || !root) return;
    const style = root.ownerDocument.defaultView?.getComputedStyle(root);
    const margins = style ? parseFloat(style.marginTop) + parseFloat(style.marginBottom) : 0;
    heightRef.current = root.offsetHeight + (Number.isFinite(margins) ? margins : 0);
  });
  useCardFocus(
    rootRef,
    [entry.step, entry.state, entry.settingsOpened, entry.error].map(String).join("|"),
    { restored: entry.restored === true, keyField: entry.payload.kind === "apiKey" }
  );
  // Esc never reaches the agent window, whose Esc cancels the whole turn. On a
  // card without its own dismiss control it dismisses that card: the turn goes
  // on, and the model hears the user said no.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    if (event.nativeEvent.isComposing || !CARDS_WITHOUT_DISMISS.has(entry.payload.kind)) return;
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
      className="my-1.5 rounded-2xl bg-surface-1 p-3.5 text-[13px] outline-none agent:p-3 agent:text-[15px]"
    >
      <CardBody entry={entry} />
    </div>
  );
}

const DONE_STATUSES = new Set(["answered", "connected", "granted", "saved", "done"]);

/**
 * One line for a settled card, in its place: what the user answered or did.
 * It starts at the card's height and eases down, so the chat doesn't drop at once.
 */
export function InteractionOutcomeRow({
  entry,
  fromHeight,
}: {
  entry: InteractionEntry;
  fromHeight: number;
}): ReactElement {
  const { t } = useTranslation();
  const { payload, result } = entry;
  const answers =
    result?.status === "answered" && payload.kind === "questions"
      ? payload.questions
          .map((question) => answerText(question, result.answers[question.id]))
          .filter(Boolean)
      : [];
  return (
    <p
      data-interaction-outcome={entry.key}
      // Unset for a row that mounts without a card before it (the chat reopened): it doesn't grow in.
      style={fromHeight > 0 ? ({ "--card-height": `${fromHeight}px` } as CSSProperties) : undefined}
      className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground transition-[height] duration-200 ease-out [interpolate-size:allow-keywords] starting:h-(--card-height) motion-reduce:transition-none agent:text-[13px]"
    >
      {result &&
        DONE_STATUSES.has(result.status) &&
        // Back from Settings with it still not set up is no success.
        !(result.status === "done" && result.ready === false) && (
          <Check size={13} className="shrink-0 text-success" />
        )}
      <span dir="auto" className="truncate">
        {[interactionOutcome(entry, t), ...answers].join(" · ")}
      </span>
    </p>
  );
}
