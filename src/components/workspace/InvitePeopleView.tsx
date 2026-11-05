import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  MAX_INVITE_RECIPIENTS,
  inviteSummary,
  isRetryableFailure,
  type InviteFlowEvent,
  type InviteFlowState,
  type InviteRecipient,
} from "../../lib/inviteFlow";
import type { InviteErrorKind } from "../../lib/workspaceErrors";
import { AlertCircle, CheckCircle2, ChevronDown, Loader2, X } from "../icons";
import { cn } from "../lib/utils";
import { isolate } from "../../utils/bidiIsolate";
import { BIDI_VALUE_TOKEN, BidiInterpolatedText } from "../ui/BidiInterpolatedText";
import { DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { WorkspaceErrorBar } from "./WorkspaceErrorBar";
import { CHIP_REMOVE_BUTTON, CHIP_TONE_DEFAULT, CHIP_TONE_ERROR } from "./recipientChipStyles";

export interface InviteSuggestion {
  email: string;
  name: string | null;
}

export interface InvitePeopleViewProps {
  workspaceName: string;
  state: InviteFlowState;
  dispatch: (event: InviteFlowEvent) => void;
  suggestions: InviteSuggestion[];
  seatLine: string | null;
  seatCostLine: string | null;
  canManageBilling: boolean;
  /** Who to ask for more seats, for admins who can't buy them. */
  billingManager: string | null;
  /** Opens Plan & Billing from the seats warning, for those who can manage billing. */
  onUpgrade: () => void;
  /** Accepting adds the invitee to a team or teamspace too, which a skipped address misses. */
  addsToContainer: boolean;
  cancelLabel: string;
  onCancel: () => void;
  onSend: () => void;
  onDone: () => void;
}

const ROLES = ["member", "admin"] as const;
export const SUGGESTION_MIN_CHARS = 2;

const BUTTON_BASE =
  "flex h-10 w-full items-center justify-center gap-2 rounded-full px-4 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50";
const PRIMARY_BUTTON = cn(BUTTON_BASE, "bg-primary text-primary-foreground hover:bg-primary/90");
const SECONDARY_BUTTON = cn(
  BUTTON_BASE,
  "bg-surface-1 text-muted-foreground hover:bg-surface-3 hover:text-foreground"
);

// The interpolation values of a chip's error line. `email` is left to the caller, which isolates
// it with <bdi> in the error bar and with Unicode isolates in the chip's tooltip.
function recipientErrorParams(
  recipient: InviteRecipient,
  workspaceName: string
): Record<string, string> {
  const { state } = recipient;
  return {
    workspace: isolate(workspaceName),
    ...(state.status === "failed" && state.kind === "refused"
      ? { reason: isolate(state.message) }
      : {}),
  };
}

function recipientErrorKind(recipient: InviteRecipient): InviteErrorKind | null {
  const { state } = recipient;
  if (state.status === "invalid") return "invalid";
  if (state.status === "blocked") return state.reason;
  if (state.status === "failed") return state.kind;
  return null;
}

interface BarContent {
  message: ReactNode;
  action?: { label: string; onClick: () => void };
}

export function InvitePeopleView({
  workspaceName,
  state,
  dispatch,
  suggestions,
  seatLine,
  seatCostLine,
  canManageBilling,
  billingManager,
  onUpgrade,
  addsToContainer,
  cancelLabel,
  onCancel,
  onSend,
  onDone,
}: InvitePeopleViewProps): ReactElement {
  const { t } = useTranslation();
  const inputId = useId();
  const hintId = useId();
  const listId = useId();
  const roleLabelId = useId();
  const roleValueId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const previousPhase = useRef(state.phase);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [listDismissed, setListDismissed] = useState(false);

  const summary = inviteSummary(state);
  const sending = state.phase === "sending";
  const listOpen =
    state.phase === "editing" &&
    !listDismissed &&
    state.draft.trim().length >= SUGGESTION_MIN_CHARS &&
    suggestions.length > 0;
  const active = listOpen && activeIndex < suggestions.length ? activeIndex : -1;

  const recipientMessage = (recipient: InviteRecipient): ReactNode => (
    <BidiInterpolatedText
      text={t(`workspaces.invite.errors.${recipientErrorKind(recipient)}`, {
        email: BIDI_VALUE_TOKEN,
        ...recipientErrorParams(recipient, workspaceName),
      })}
      value={recipient.email}
    />
  );

  const removeLast = (count: number): BarContent["action"] => ({
    label: t("workspaces.invite.removeLast", { count }),
    onClick: () => {
      dispatch({ type: "removeLast", count });
      // The button goes away with the excess.
      inputRef.current?.focus();
    },
  });

  // At most one error, the first that applies.
  const errorBarContent = (): BarContent | null => {
    if (summary.tooMany) {
      return {
        message: t("workspaces.invite.tooMany", { count: MAX_INVITE_RECIPIENTS }),
        action: removeLast(summary.tooManyBy),
      };
    }
    if (summary.invalid[0]) return { message: recipientMessage(summary.invalid[0]) };
    if (summary.overCeiling) {
      const { available, excess } = summary.overCeiling;
      return available === 0
        ? { message: t("workspaces.invite.errors.seatLimit") }
        : {
            message: t("workspaces.invite.ceilingLeft", { count: available, excess }),
            action: removeLast(excess),
          };
    }
    if (summary.overRateLimit) {
      const { available, excess, limit } = summary.overRateLimit;
      // Past the daily allowance, waiting can't make this batch fit.
      return {
        message:
          summary.sendable.length > limit
            ? t("workspaces.invite.rateLimitedDaily", { limit, excess })
            : t("workspaces.invite.rateLimitedLeft", { count: available, excess }),
        action: removeLast(excess),
      };
    }
    if (summary.failed.length === 0) return null;
    // Try resending resends exactly these, so the count and the button agree with Send.
    const retryable = summary.failed.filter(
      ({ state: chip }) => chip.status === "failed" && isRetryableFailure(chip)
    );
    if (retryable.length === 0) return { message: recipientMessage(summary.failed[0]) };
    const resend = { label: t("workspaces.invite.tryResending"), onClick: onSend };
    // A 429 answers for the whole batch, so the server's "try later" says more than a count.
    const rateLimited = retryable.some(
      ({ state: chip }) => chip.status === "failed" && chip.kind === "rateLimited"
    );
    if (rateLimited) return { message: t("workspaces.invite.errors.rateLimited"), action: resend };
    const seatLimited = retryable.find(
      ({ state: chip }) => chip.status === "failed" && chip.kind === "seatLimit"
    );
    if (seatLimited) return { message: recipientMessage(seatLimited), action: resend };
    return {
      message: t("workspaces.invite.someFailed", { count: retryable.length }),
      action: resend,
    };
  };
  const errorBar = errorBarContent();

  // Warnings never block Send: the server bills a seat only when an invitation is accepted, and
  // skipped addresses are left out of the send.
  const warningBars: Array<BarContent & { key: string }> = [];
  // Over the ceiling, its blocking bar already says how many to remove; a seats count beside it
  // would name a different number.
  if (summary.overSeats && !summary.overCeiling) {
    const { available: count, excess } = summary.overSeats;
    const askOwner = !canManageBilling && billingManager;
    // With no seats left, removing the excess would mean removing everyone.
    let message: string;
    if (count === 0) {
      message = askOwner
        ? t("workspaces.invite.seatsNoneAskOwner", { owner: isolate(askOwner) })
        : t("workspaces.invite.seatsNone");
    } else {
      message = askOwner
        ? t("workspaces.invite.seatsLeftAskOwner", { count, excess, owner: isolate(askOwner) })
        : t("workspaces.invite.seatsLeft", { count, excess });
    }
    warningBars.push({
      key: "seats",
      message,
      action:
        canManageBilling && !sending
          ? { label: t("workspaces.invite.upgrade"), onClick: onUpgrade }
          : undefined,
    });
  }
  // On a team or teamspace, "skipped" alone would read as if they were added anyway.
  const namesSkippedAddress = summary.skipped.length === 1 && !addsToContainer;
  const skippedMessage: ReactNode = namesSkippedAddress
    ? recipientMessage(summary.skipped[0])
    : t(addsToContainer ? "workspaces.invite.skippedNotAdded" : "workspaces.invite.skippedMany", {
        count: summary.skipped.length,
      });
  if (summary.skipped.length > 0) warningBars.push({ key: "skipped", message: skippedMessage });
  // Part of a send went out while other chips still need attention; Cancel from here must not hide
  // that the rest got their invitations, or that some emails never arrived.
  const undelivered = summary.noEmailCount > 0 && summary.noEmailCount === state.sent.length;
  const sentHeadline = t(
    undelivered ? "workspaces.invite.createdTitle" : "workspaces.invite.sentTitle",
    { count: state.sent.length }
  );
  if (summary.noEmailCount > 0) {
    warningBars.push({
      key: "noEmail",
      message: t("workspaces.invite.noEmail", { count: summary.noEmailCount }),
    });
  }
  const sendingCount = state.recipients.filter(
    (recipient) => recipient.state.status === "sending"
  ).length;

  // The field and Send are disabled while sending, which drops focus to the page; a run that
  // leaves chips to fix returns it to the field (the Done screen focuses its own button).
  useEffect(() => {
    if (previousPhase.current === "sending" && state.phase === "editing") {
      inputRef.current?.focus();
    }
    previousPhase.current = state.phase;
  }, [state.phase]);

  const changeDraft = (text: string): void => {
    setActiveIndex(-1);
    setListDismissed(false);
    dispatch({ type: "draft", text });
  };

  const pick = (suggestion: InviteSuggestion): void => {
    dispatch({ type: "add", email: suggestion.email });
    changeDraft("");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (listOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => {
        if (current < 0) return step === 1 ? 0 : suggestions.length - 1;
        return (current + step + suggestions.length) % suggestions.length;
      });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (active >= 0) pick(suggestions[active]);
      else dispatch({ type: "commit" });
    }
  };

  // Radix handles Esc on the document before the input sees it, so the list closes here
  // instead of the dialog.
  const handleEscapeKeyDown = (event: globalThis.KeyboardEvent): void => {
    if (sending) {
      event.preventDefault();
    } else if (listOpen) {
      event.preventDefault();
      setListDismissed(true);
    }
  };

  // Radix would focus the first control, which is a chip's remove button when the dialog opens
  // with an address already filled in.
  const focusField = (event: Event): void => {
    event.preventDefault();
    inputRef.current?.focus();
  };

  const blockWhileSending = (event: Event): void => {
    if (sending) event.preventDefault();
  };

  return (
    <DialogContent
      hideCloseButton
      onOpenAutoFocus={focusField}
      onEscapeKeyDown={handleEscapeKeyDown}
      onInteractOutside={blockWhileSending}
      className="max-h-[calc(100vh-32px)] w-[440px] max-w-[calc(100vw-32px)] grid-cols-1 items-stretch gap-6 overflow-y-auto rounded-[28px] p-5 sm:max-w-[440px]"
    >
      {state.phase === "done" ? (
        <InviteDoneContent
          workspaceName={workspaceName}
          sent={state.sent}
          attachedCount={state.attached.length}
          headline={sentHeadline}
          undelivered={undelivered}
          noEmailCount={summary.noEmailCount}
          skippedMessage={summary.skipped.length > 0 ? skippedMessage : null}
          // Their chips are gone on this screen, so this is the only place that says who.
          skippedEmails={
            namesSkippedAddress ? [] : summary.skipped.map((recipient) => recipient.email)
          }
          onDone={onDone}
        />
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <DialogTitle className="text-lg font-medium leading-snug tracking-normal">
              {t("workspaces.invite.title")}
            </DialogTitle>
            <DialogDescription className="text-sm leading-normal">
              {t("workspaces.invite.description", { workspace: isolate(workspaceName) })}
            </DialogDescription>
            {seatLine ? <p className="text-xs text-muted-foreground">{seatLine}</p> : null}
            {seatCostLine ? <p className="text-xs text-muted-foreground">{seatCostLine}</p> : null}
            {state.sent.length > 0 ? (
              <p role="status" className="text-xs font-medium text-foreground">
                {sentHeadline}
              </p>
            ) : null}
            {state.attached.length > 0 ? (
              <p role="status" className="text-xs font-medium text-foreground">
                {t("workspaces.invite.attachedBody", { count: state.attached.length })}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
                {t("workspaces.invite.emailLabel")}
              </label>
              <div className="relative">
                <div
                  onClick={() => inputRef.current?.focus()}
                  className={cn(
                    "flex max-h-40 min-h-10 cursor-text flex-wrap items-center gap-1.5 overflow-y-auto rounded-xl border border-border/70 bg-surface-1 px-2 py-1.5 transition-colors",
                    "focus-within:border-border focus-within:ring-2 focus-within:ring-ring/40",
                    sending && "opacity-60"
                  )}
                >
                  {state.recipients.map((recipient) => (
                    <RecipientChip
                      key={recipient.email}
                      recipient={recipient}
                      workspaceName={workspaceName}
                      disabled={sending}
                      onRemove={() => dispatch({ type: "remove", email: recipient.email })}
                    />
                  ))}
                  <input
                    ref={inputRef}
                    id={inputId}
                    dir="ltr"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={listOpen}
                    aria-controls={listOpen ? listId : undefined}
                    aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
                    aria-describedby={errorBar ? `${hintId} ${errorId}` : hintId}
                    aria-invalid={errorBar ? true : undefined}
                    disabled={sending}
                    value={state.draft}
                    placeholder={
                      state.recipients.length === 0
                        ? t("workspaces.invite.emailPlaceholder")
                        : t("workspaces.invite.addMore")
                    }
                    onChange={(event) => changeDraft(event.target.value)}
                    onPaste={(event) => {
                      const text = event.clipboardData.getData("text/plain");
                      if (!/[\r\n]/.test(text)) return;
                      event.preventDefault();
                      const { value, selectionStart, selectionEnd } = event.currentTarget;
                      changeDraft(
                        value.slice(0, selectionStart ?? value.length) +
                          text +
                          value.slice(selectionEnd ?? value.length)
                      );
                    }}
                    onKeyDown={handleKeyDown}
                    onBlur={() => dispatch({ type: "commit" })}
                    className="h-7 min-w-[8rem] flex-1 bg-transparent px-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
                  />
                </div>
                {listOpen ? (
                  <div
                    id={listId}
                    role="listbox"
                    aria-label={t("workspaces.invite.suggestions")}
                    className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg"
                  >
                    {suggestions.map((suggestion, index) => (
                      <div
                        key={suggestion.email}
                        id={`${listId}-${index}`}
                        role="option"
                        aria-selected={index === active}
                        // Keeps focus in the field, whose blur would chip the half-typed text.
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => pick(suggestion)}
                        className={cn(
                          "flex cursor-pointer flex-col rounded-lg px-2.5 py-1.5 text-sm",
                          index === active && "bg-muted"
                        )}
                      >
                        {suggestion.name ? (
                          <span dir="auto" className="truncate text-foreground">
                            {suggestion.name}
                          </span>
                        ) : null}
                        <span
                          className={cn(
                            "truncate",
                            suggestion.name ? "text-xs text-muted-foreground" : "text-foreground"
                          )}
                        >
                          <bdi dir="ltr">{suggestion.email}</bdi>
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
              <p id={hintId} className="text-xs text-muted-foreground">
                {t("workspaces.invite.emailHint")}
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <span id={roleLabelId} className="text-xs font-medium text-muted-foreground">
                {t("workspaces.invite.roleLabel")}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger
                  // The label names the field and the trigger's own text says the current role.
                  // Radix owns the trigger's id, which its menu is labelled by.
                  aria-labelledby={`${roleLabelId} ${roleValueId}`}
                  disabled={sending}
                  className="flex h-10 w-full items-center justify-between gap-2 rounded-xl border border-border/70 bg-surface-1 px-3 text-sm text-foreground outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span id={roleValueId} className="truncate">
                    {t(`workspaces.invite.role.${state.role}`)}
                  </span>
                  <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  aria-labelledby={roleLabelId}
                  align="start"
                  className="w-[var(--radix-dropdown-menu-trigger-width)]"
                >
                  <DropdownMenuRadioGroup
                    value={state.role}
                    onValueChange={(value) =>
                      dispatch({ type: "role", role: value === "admin" ? "admin" : "member" })
                    }
                  >
                    {ROLES.map((role) => (
                      <DropdownMenuRadioItem
                        key={role}
                        value={role}
                        className="items-start rounded-lg py-2 [&>span:first-child]:top-3"
                      >
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="text-sm text-foreground">
                            {t(`workspaces.invite.role.${role}`)}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {t(`workspaces.invite.roleDescription.${role}`)}
                          </span>
                        </span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {errorBar ? (
              <WorkspaceErrorBar
                id={errorId}
                tone="error"
                message={errorBar.message}
                action={errorBar.action}
              />
            ) : null}
            {warningBars.map((bar) => (
              <WorkspaceErrorBar
                key={bar.key}
                tone="warning"
                message={bar.message}
                action={bar.action}
              />
            ))}
          </div>

          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={onSend}
              disabled={sending || !summary.canSend}
              className={PRIMARY_BUTTON}
            >
              {sending ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  {t("workspaces.invite.submitting", { count: sendingCount })}
                </>
              ) : summary.sendable.length > 1 ? (
                t("workspaces.invite.submit", { count: summary.sendable.length })
              ) : (
                // One address, and the empty field, read "Send invite". A plural form can't say
                // that: fr, pt and ru reuse "one" for other counts, so it must carry the number.
                t("workspaces.invite.submitOne")
              )}
            </button>
            {sending ? null : (
              <button
                type="button"
                // Keeps focus in the field: its blur would chip a half-typed address, and the error
                // bar that can raise moves this button out from under the click.
                onMouseDown={(event) => event.preventDefault()}
                onClick={onCancel}
                className={SECONDARY_BUTTON}
              >
                {cancelLabel}
              </button>
            )}
          </div>
        </>
      )}
    </DialogContent>
  );
}

function RecipientChip({
  recipient,
  workspaceName,
  disabled,
  onRemove,
}: {
  recipient: InviteRecipient;
  workspaceName: string;
  disabled: boolean;
  onRemove: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const kind = recipientErrorKind(recipient);
  const error = kind
    ? t(`workspaces.invite.errors.${kind}`, {
        email: isolate(recipient.email),
        ...recipientErrorParams(recipient, workspaceName),
      })
    : undefined;

  return (
    <span
      title={error}
      className={cn(
        "inline-flex h-7 max-w-full items-center gap-0.5 rounded-full border ps-2.5 pe-0.5 text-xs",
        error ? CHIP_TONE_ERROR : CHIP_TONE_DEFAULT
      )}
    >
      <bdi dir="ltr" className="truncate">
        {recipient.email}
      </bdi>
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        aria-label={t("workspaces.invite.removeRecipient", { email: recipient.email })}
        className={CHIP_REMOVE_BUTTON}
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </span>
  );
}

function InviteDoneContent({
  workspaceName,
  sent,
  attachedCount,
  headline,
  undelivered,
  noEmailCount,
  skippedMessage,
  skippedEmails,
  onDone,
}: {
  workspaceName: string;
  sent: InviteFlowState["sent"];
  attachedCount: number;
  headline: string;
  /** Every invitation exists, but no email reached anyone, so this is no success to confirm. */
  undelivered: boolean;
  noEmailCount: number;
  skippedMessage: ReactNode;
  skippedEmails: string[];
  onDone: () => void;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <>
      <div className="flex flex-col items-center gap-3 text-center">
        <div
          className={cn(
            "flex size-[42px] items-center justify-center rounded-full",
            undelivered ? "bg-warning/10 text-warning" : "bg-success/10 text-success"
          )}
        >
          {undelivered ? (
            <AlertCircle className="size-4" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="size-4" aria-hidden="true" />
          )}
        </div>
        <DialogTitle className="text-lg font-medium leading-snug tracking-normal">
          {sent.length === 0
            ? t("workspaces.invite.attachedTitle", { count: attachedCount })
            : headline}
        </DialogTitle>
        <DialogDescription className="text-sm leading-normal">
          {sent.length === 0 ? (
            t("workspaces.invite.attachedBody", { count: attachedCount })
          ) : undelivered ? (
            t("workspaces.invite.noEmail", { count: noEmailCount })
          ) : sent.length === 1 ? (
            <BidiInterpolatedText
              text={t("workspaces.invite.sentOne", {
                email: BIDI_VALUE_TOKEN,
                workspace: isolate(workspaceName),
              })}
              value={sent[0].email}
            />
          ) : (
            t("workspaces.invite.sentMany", {
              count: sent.length,
              workspace: isolate(workspaceName),
            })
          )}
        </DialogDescription>
      </div>
      {sent.length > 0 && attachedCount > 0 ? (
        <p className="text-center text-xs text-muted-foreground">
          {t("workspaces.invite.attachedBody", { count: attachedCount })}
        </p>
      ) : null}
      {noEmailCount > 0 && !undelivered ? (
        <WorkspaceErrorBar
          tone="warning"
          message={t("workspaces.invite.noEmail", { count: noEmailCount })}
        />
      ) : null}
      {skippedMessage ? <WorkspaceErrorBar tone="warning" message={skippedMessage} /> : null}
      {skippedEmails.length > 0 ? (
        <ul className="max-h-24 overflow-y-auto text-xs text-muted-foreground">
          {skippedEmails.map((email) => (
            <li key={email} className="truncate">
              <bdi dir="ltr">{email}</bdi>
            </li>
          ))}
        </ul>
      ) : null}
      {/* The send button that had focus is gone, so focus would otherwise fall to the page. */}
      <button type="button" autoFocus onClick={onDone} className={PRIMARY_BUTTON}>
        {t("workspaces.invite.done")}
      </button>
    </>
  );
}
