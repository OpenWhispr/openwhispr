import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type FocusEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  addRecipients,
  emailRecipient,
  teamRecipient,
  memberRecipient,
  pickerResults,
  recipientKey,
  recipientsFromText,
  type PickedRecipient,
} from "../../lib/spacePeoplePicker";
import type { Team, WorkspaceMember } from "../../types/electron";
import { isolate } from "../../utils/bidiIsolate";
import { Check, ChevronDown, Mail, X } from "../icons";
import { cn } from "../lib/utils";
import MemberAvatar from "../MemberAvatar";
import { BIDI_VALUE_TOKEN, BidiInterpolatedText } from "../ui/BidiInterpolatedText";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import {
  CHIP_REMOVE_BUTTON,
  CHIP_TONE_DEFAULT,
  CHIP_TONE_ERROR,
} from "../workspace/recipientChipStyles";
import { FIELD_CONTROL } from "../workspace/dialogButtons";
import { TileGlyph } from "./SpaceNameField";

type InviteRole = "admin" | "member";

export interface SpacePeopleFieldProps {
  id?: string;
  roster: WorkspaceMember[];
  teams: Team[];
  accessUserIds?: ReadonlySet<string>;
  accessTeamIds?: ReadonlySet<string>;
  hiddenUserIds?: ReadonlySet<string>;
  /** Addresses with an invitation waiting, lowercased: shown as pending, never offered again. */
  pendingEmails?: ReadonlySet<string>;
  canInvite: boolean;
  /** Members tab: the invite row offers a role menu and Select. Create: Invite to workspace. */
  inviteRoleChoice: boolean;
  picked: PickedRecipient[];
  onChange: (picked: PickedRecipient[]) => void;
  disabled?: boolean;
  placeholder: string;
  /** A control beside the input (Add members); the chips sit under both. */
  action?: ReactNode;
  /** A line between the input and the chips, for a form whose people arrive already chosen. */
  note?: ReactNode;
  /**
   * Each increase moves focus into the input with its list closed, to hand the field back after
   * a run: the list is for someone who came to pick, and would cover what the run just said.
   */
  focusRequest?: number;
  /** Told what is typed but not yet staged as a chip, for a form that waits on it. */
  onQueryChange?: (query: string) => void;
}

type PickerRow =
  | { kind: "member"; member: WorkspaceMember; hasAccess: boolean; picked: boolean }
  | { kind: "team"; team: Team; hasAccess: boolean; picked: boolean }
  | { kind: "invite"; email: string }
  | { kind: "pending"; email: string };

const NO_IDS: ReadonlySet<string> = new Set();

// An address list typed up to a separator, or a pasted "Name <address>" that is closed: complete,
// unlike the same words while a name is still being searched for.
const FINISHED_LIST = /[,;،，、]\s*$|<[^<>]*>\s*$/;
const PASTED_LIST = /[,;،，、\n\r]|<[^<>]*>/;

// The avatar's initial would read as a stray letter before the name it sits beside.
function PersonAvatar({
  name,
  email,
  image,
}: {
  name: string | null;
  email: string;
  image?: string | null;
}): ReactElement {
  return (
    <span aria-hidden="true" className="flex shrink-0">
      <MemberAvatar name={name} email={email} image={image} size="sm" />
    </span>
  );
}

const TILE =
  "flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-foreground/5 dark:bg-white/6";
// The tile's glyph is an emoji sized for a larger tile in the table.
const TEAM_TILE = cn(TILE, "[&>span]:text-xs");
const ACTION_PILL =
  "shrink-0 rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/15";

const isPickable = (row: PickerRow): boolean =>
  row.kind === "invite" || (row.kind !== "pending" && !row.hasAccess);

export function SpacePeopleField({
  id,
  roster,
  teams,
  accessUserIds = NO_IDS,
  accessTeamIds = NO_IDS,
  hiddenUserIds,
  pendingEmails,
  canInvite,
  inviteRoleChoice,
  picked,
  onChange,
  disabled = false,
  placeholder,
  action,
  note,
  focusRequest = 0,
  onQueryChange,
}: SpacePeopleFieldProps): ReactElement {
  const { t } = useTranslation();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    onQueryChange?.(query);
  }, [query, onQueryChange]);
  const [focused, setFocused] = useState(false);
  // Escape closes the list until the person types, arrows or clicks the field again.
  const [dismissed, setDismissed] = useState(false);
  // Who set the highlight matters: a resting pointer highlights a row too, and only the keyboard
  // may scroll to it or use left and right on it.
  const [highlight, setHighlight] = useState<{ index: number; byKeyboard: boolean }>({
    index: -1,
    byKeyboard: false,
  });
  const [inviteRole, setInviteRole] = useState<InviteRole>("member");
  const [fieldElement, setFieldElement] = useState<HTMLDivElement | null>(null);
  const [listElement, setListElement] = useState<HTMLDivElement | null>(null);

  const results = pickerResults({
    query,
    roster,
    teams,
    picked,
    accessUserIds,
    accessTeamIds,
    hiddenUserIds,
    pendingEmails,
    canInvite,
  });
  const rows: PickerRow[] = [
    ...results.members.map(({ member, hasAccess, picked }): PickerRow => ({
      kind: "member",
      member,
      hasAccess,
      picked,
    })),
    ...results.teams.map(({ team, hasAccess, picked }): PickerRow => ({
      kind: "team",
      team,
      hasAccess,
      picked,
    })),
    ...(results.inviteEmail ? [{ kind: "invite", email: results.inviteEmail } as const] : []),
    ...(results.pendingInvite ? [{ kind: "pending", email: results.pendingInvite } as const] : []),
  ];
  // An empty field with nobody left to list has nothing to say.
  const showEmptyState = results.noResults && query.trim() !== "";
  const listOpen = focused && !dismissed && !disabled && (rows.length > 0 || showEmptyState);
  const active =
    listOpen &&
    highlight.index >= 0 &&
    highlight.index < rows.length &&
    isPickable(rows[highlight.index])
      ? highlight.index
      : -1;
  const hasInvalid = picked.some((recipient) => recipient.kind === "email" && !recipient.valid);
  // The role the invite row shows is the one every address typed or pasted here is staged with.
  const shownRole: InviteRole = inviteRoleChoice ? inviteRole : "member";
  const stagingRules = { accessUserIds, hiddenUserIds, pendingEmails };

  // Highlighting with the arrow keys must never leave the row out of sight, or Enter picks blind.
  // A pointer's row is already under it, and scrolling to it would move the list while it is used.
  const scrollTarget = highlight.byKeyboard ? active : -1;
  useEffect(() => {
    if (scrollTarget >= 0) {
      document.getElementById(`${listId}-${scrollTarget}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [scrollTarget, listId]);

  useEffect(() => {
    if (focusRequest === 0) return;
    inputRef.current?.focus();
    // Focus opens the list; this focus is only the field coming back.
    setDismissed(true);
  }, [focusRequest]);

  const stage = (incoming: PickedRecipient[], replaceRole = false): void => {
    const next = addRecipients(picked, incoming, { ...stagingRules, replaceRole });
    if (next !== picked) onChange(next);
  };

  // Stages every address in the text and returns what couldn't be staged, to leave in the field:
  // an address nobody here may invite, or a member who already has access.
  const stageText = (text: string): string => {
    const parsed = recipientsFromText(text, roster, shownRole);
    const allowed = canInvite ? parsed : parsed.filter((recipient) => recipient.kind === "member");
    const next = addRecipients(picked, allowed, stagingRules);
    if (next !== picked) onChange(next);
    const stagedKeys = new Set(next.map(recipientKey));
    return parsed
      .filter((recipient) => !stagedKeys.has(recipientKey(recipient)))
      .map((recipient) => (recipient.kind === "team" ? recipient.label : recipient.email))
      .join(", ");
  };

  // The field's own text is used up when nothing of it is left; the role shown was for it.
  const consume = (text: string): void => {
    const leftover = stageText(text);
    setQuery(leftover);
    if (leftover === "") setInviteRole("member");
  };

  // Half a name is a search; only text that reads as an address is chipped.
  const commitQuery = (): void => {
    if (query.includes("@")) consume(query);
  };

  const unstage = (recipient: PickedRecipient): void => {
    onChange(picked.filter((entry) => recipientKey(entry) !== recipientKey(recipient)));
  };

  // A picked row stays listed with a check, and choosing it again takes the chip back out.
  const pick = (row: PickerRow): void => {
    if (!isPickable(row)) return;
    if (row.kind === "member") {
      const recipient = memberRecipient(row.member);
      if (row.picked) unstage(recipient);
      else stage([recipient]);
    } else if (row.kind === "team") {
      const recipient = teamRecipient(row.team);
      if (row.picked) unstage(recipient);
      else stage([recipient]);
    } else {
      // The only place a role replaces one already staged: the row is a choice made on purpose.
      stage([emailRecipient(row.email.toLowerCase(), shownRole)], true);
      // Never carried to the next address: an admin invitation is a choice made each time.
      setInviteRole("member");
      // The row is about to unmount, and focus must not go with it.
      inputRef.current?.focus();
    }
    setQuery("");
    setHighlight({ index: -1, byKeyboard: false });
  };

  const move = (step: 1 | -1): void => {
    const pickable = rows.flatMap((row, index) => (isPickable(row) ? [index] : []));
    if (pickable.length === 0) return;
    const position = pickable.indexOf(active);
    const next =
      position === -1
        ? step === 1
          ? 0
          : pickable.length - 1
        : (position + step + pickable.length) % pickable.length;
    setHighlight({ index: pickable[next], byKeyboard: true });
  };

  const handleChange = (value: string): void => {
    setHighlight({ index: -1, byKeyboard: false });
    setDismissed(false);
    // Without an address the invite row is gone and so is the role chosen on it; keeping it would
    // stage the next address, or a whole pasted list, as Admin.
    if (!value.includes("@")) setInviteRole("member");
    if (value.includes("@") && FINISHED_LIST.test(value)) consume(value);
    else setQuery(value);
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>): void => {
    const pasted = event.clipboardData.getData("text/plain");
    // One address or a name pastes into the field like any text.
    if (!pasted.includes("@") || !PASTED_LIST.test(pasted)) return;
    event.preventDefault();
    const leftover = stageText(pasted);
    setQuery(leftover === "" ? query : leftover);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (listOpen) move(event.key === "ArrowDown" ? 1 : -1);
      else setDismissed(false);
    } else if (
      (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      inviteRoleChoice &&
      highlight.byKeyboard &&
      active >= 0 &&
      rows[active].kind === "invite"
    ) {
      // Tab would leave the field and close the list, so the role of the highlighted invitation
      // is chosen here; the caret keeps left and right on every other row, and whenever the row is
      // only under the pointer, since an Admin invitation must be a choice made on purpose.
      event.preventDefault();
      setInviteRole((current) => (current === "member" ? "admin" : "member"));
    } else if (event.key === "Enter") {
      // Enter belongs to the field: the dialog around it is not submitted from here.
      event.preventDefault();
      if (active >= 0) pick(rows[active]);
      else commitQuery();
    }
  };

  // Blur bubbles up from the field, the list and its role menu alike; only leaving all of them is
  // leaving the field, so choosing a role never chips the address it is for.
  const handleBlur = (event: FocusEvent<HTMLElement>): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && (fieldElement?.contains(next) || listElement?.contains(next))) {
      return;
    }
    setFocused(false);
    commitQuery();
  };

  const emojiByTeam = new Map(teams.map((team) => [team.id, team.emoji ?? null]));

  return (
    <div
      className={cn(
        action ? "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2" : "flex flex-col gap-2"
      )}
      onBlur={handleBlur}
    >
      <Popover
        open={listOpen}
        onOpenChange={(open) => {
          // Radix closes the list on Escape before the dialog around it sees the key.
          if (!open) setDismissed(true);
        }}
      >
        <PopoverAnchor asChild>
          <div ref={setFieldElement}>
            <input
              ref={inputRef}
              id={id}
              dir="auto"
              type="text"
              className={FIELD_CONTROL}
              autoComplete="off"
              spellCheck={false}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={listOpen}
              aria-controls={listOpen && rows.length > 0 ? listId : undefined}
              aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
              aria-invalid={hasInvalid ? true : undefined}
              disabled={disabled}
              value={query}
              placeholder={placeholder}
              onChange={(event) => handleChange(event.target.value)}
              onFocus={() => {
                setFocused(true);
                setDismissed(false);
              }}
              onClick={() => setDismissed(false)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
            />
          </div>
        </PopoverAnchor>
        <PopoverContent
          ref={setListElement}
          // Focus stays in the field, so typing carries on and its blur doesn't chip the text.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            if (event.target instanceof Node && fieldElement?.contains(event.target)) {
              event.preventDefault();
            }
          }}
          onMouseDown={(event) => event.preventDefault()}
          // The dialog's scroll lock cancels the wheel anywhere outside the dialog, and this list
          // sits in the body; the wheel stops here, so the lock never sees it.
          onWheel={(event) => event.stopPropagation()}
          className="max-h-[min(18rem,var(--radix-popover-content-available-height))] w-[var(--radix-popover-trigger-width)] min-w-0 overflow-y-auto rounded-xl p-1.5"
        >
          {rows.length > 0 ? (
            <div
              id={listId}
              role="listbox"
              aria-multiselectable="true"
              aria-label={t("workspaces.invite.suggestions")}
              className="flex flex-col gap-0.5"
            >
              {rows.map((row, index) => {
                const disabledRow = !isPickable(row);
                return (
                  <div
                    key={rowKey(row)}
                    id={`${listId}-${index}`}
                    role="option"
                    // Who is picked; the row the arrow keys are on is aria-activedescendant.
                    aria-selected={(row.kind === "member" || row.kind === "team") && row.picked}
                    aria-disabled={disabledRow || undefined}
                    onMouseEnter={() => {
                      if (!disabledRow) setHighlight({ index, byKeyboard: false });
                    }}
                    onClick={() => pick(row)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-start",
                      disabledRow ? "cursor-default opacity-50" : "cursor-pointer",
                      index === active && "bg-muted"
                    )}
                  >
                    <RowContent
                      row={row}
                      inviteRoleChoice={inviteRoleChoice}
                      inviteRole={inviteRole}
                      onInviteRoleChange={setInviteRole}
                      onMenuClosed={() => inputRef.current?.focus()}
                      menuContainer={listElement}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <div role="status" className="flex flex-col gap-0.5 px-2.5 py-2">
              <p className="text-xs font-medium text-foreground">
                {t("settingsPage.workspace.teamspaces.picker.noResultsTitle")}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {canInvite
                  ? t("settingsPage.workspace.teamspaces.picker.noResultsBody")
                  : t("settingsPage.workspace.teamspaces.picker.noResultsBodyNoInvite")}
              </p>
            </div>
          )}
        </PopoverContent>
      </Popover>
      {action}
      {note ? <div className="col-span-2">{note}</div> : null}

      {picked.length > 0 ? (
        <ul className="col-span-2 flex flex-wrap gap-1.5">
          {picked.map((recipient) => (
            <RecipientChip
              key={recipientKey(recipient)}
              recipient={recipient}
              emoji={recipient.kind === "team" ? (emojiByTeam.get(recipient.teamId) ?? null) : null}
              showRole={inviteRoleChoice}
              disabled={disabled}
              onRemove={() => unstage(recipient)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function rowKey(row: PickerRow): string {
  if (row.kind === "member") return `member:${row.member.user_id}`;
  if (row.kind === "team") return `team:${row.team.id}`;
  return row.kind;
}

function RowContent({
  row,
  inviteRoleChoice,
  inviteRole,
  onInviteRoleChange,
  onMenuClosed,
  menuContainer,
}: {
  row: PickerRow;
  inviteRoleChoice: boolean;
  inviteRole: InviteRole;
  onInviteRoleChange: (role: InviteRole) => void;
  onMenuClosed: () => void;
  menuContainer: HTMLElement | null;
}): ReactElement {
  const { t } = useTranslation();

  if (row.kind === "member") {
    const { member, hasAccess } = row;
    const secondary: ReactNode = hasAccess ? (
      t("settingsPage.workspace.teamspaces.picker.hasAccess")
    ) : member.name ? (
      <bdi dir="ltr">{member.email}</bdi>
    ) : null;
    return (
      <>
        <PersonAvatar name={member.name} email={member.email} image={member.image} />
        <RowText
          primary={
            member.name ? (
              <span dir="auto">{member.name}</span>
            ) : (
              <bdi dir="ltr">{member.email}</bdi>
            )
          }
          secondary={secondary}
        />
        {row.picked ? <PickedCheck /> : null}
      </>
    );
  }

  if (row.kind === "team") {
    const { team, hasAccess } = row;
    const count = team.member_count ?? 0;
    return (
      <>
        <span aria-hidden="true" className={TEAM_TILE}>
          <TileGlyph emoji={team.emoji ?? null} name={team.name} />
        </span>
        <RowText
          primary={<span dir="auto">{team.name}</span>}
          secondary={
            hasAccess
              ? t("settingsPage.workspace.teamspaces.picker.teamHasAccess", { count })
              : t("settingsPage.workspace.teamspaces.picker.teamPeople", { count })
          }
        />
        {row.picked ? <PickedCheck /> : null}
      </>
    );
  }

  if (row.kind === "pending") {
    return (
      <>
        <MailTile />
        <RowText
          primary={<bdi dir="ltr">{row.email}</bdi>}
          secondary={t("settingsPage.workspace.teamspaces.members.invitationPending")}
        />
      </>
    );
  }

  return (
    <>
      <MailTile />
      <RowText
        primary={<bdi dir="ltr">{row.email}</bdi>}
        secondary={
          inviteRoleChoice
            ? t("settingsPage.workspace.teamspaces.picker.newToWorkspace")
            : t("settingsPage.workspace.teamspaces.picker.noMember")
        }
      />
      {inviteRoleChoice ? (
        <>
          {/* The menu is part of this row's React tree, so its clicks would reach the row and stage. */}
          <div className="shrink-0" onClick={(event) => event.stopPropagation()}>
            <InviteRoleMenu
              role={inviteRole}
              onRoleChange={onInviteRoleChange}
              onClosed={onMenuClosed}
              container={menuContainer}
            />
          </div>
          <button type="button" className={ACTION_PILL}>
            {t("settingsPage.workspace.teamspaces.picker.select")}
          </button>
        </>
      ) : (
        <span className={ACTION_PILL}>
          {t("settingsPage.workspace.teamspaces.picker.inviteToWorkspace")}
        </span>
      )}
    </>
  );
}

function MailTile(): ReactElement {
  return (
    <span aria-hidden="true" className={cn(TILE, "text-muted-foreground")}>
      <Mail className="size-3" aria-hidden="true" />
    </span>
  );
}

function PickedCheck(): ReactElement {
  return <Check className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

function RowText({
  primary,
  secondary,
}: {
  primary: ReactNode;
  secondary: ReactNode;
}): ReactElement {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-xs text-foreground">{primary}</span>
      {secondary ? (
        <span className="truncate text-[11px] text-muted-foreground">{secondary}</span>
      ) : null}
    </span>
  );
}

function InviteRoleMenu({
  role,
  onRoleChange,
  onClosed,
  container,
}: {
  role: InviteRole;
  onRoleChange: (role: InviteRole) => void;
  /** Where focus goes when the menu closes: back to the field, not to this trigger. */
  onClosed: () => void;
  container: HTMLElement | null;
}): ReactElement {
  const { t } = useTranslation();
  const itemClass = "items-start rounded-lg py-2 [&>span:first-child]:top-3";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-foreground outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-foreground/5">
        <span className="sr-only">{t("workspaces.invite.roleLabel")}</span>
        {/* Announced when the arrow keys change it, as the menu isn't open for that. */}
        <span aria-live="polite">
          {role === "admin"
            ? t("workspaces.invite.role.admin")
            : t("workspaces.invite.role.member")}
        </span>
        <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
      </DropdownMenuTrigger>
      {/* In the list's own element, so moving focus into the menu is not leaving the field. */}
      <DropdownMenuContent
        align="end"
        container={container}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onClosed();
        }}
        className="w-64"
      >
        <DropdownMenuRadioGroup
          value={role}
          onValueChange={(value) => onRoleChange(value === "admin" ? "admin" : "member")}
        >
          <DropdownMenuRadioItem value="member" className={itemClass}>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-foreground">{t("workspaces.invite.role.member")}</span>
              <span className="text-xs text-muted-foreground">
                {t("workspaces.invite.roleDescription.member")}
              </span>
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="admin" className={itemClass}>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-foreground">{t("workspaces.invite.role.admin")}</span>
              <span className="text-xs text-muted-foreground">
                {t("workspaces.invite.roleDescription.admin")}
              </span>
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RecipientChip({
  recipient,
  emoji,
  showRole,
  disabled,
  onRemove,
}: {
  recipient: PickedRecipient;
  emoji: string | null;
  showRole: boolean;
  disabled: boolean;
  onRemove: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const invalid = recipient.kind === "email" && !recipient.valid;

  let leading: ReactElement;
  let label: ReactNode;
  let removeName: string;
  if (recipient.kind === "member") {
    leading = <PersonAvatar name={recipient.label} email={recipient.email} />;
    label = <span dir="auto">{recipient.label}</span>;
    removeName = recipient.label;
  } else if (recipient.kind === "team") {
    leading = (
      <span aria-hidden="true" className={TEAM_TILE}>
        <TileGlyph emoji={emoji} name={recipient.label} />
      </span>
    );
    label = (
      <span dir="auto">
        {t("settingsPage.workspace.teamspaces.picker.teamChip", {
          name: isolate(recipient.label),
          count: recipient.memberCount,
        })}
      </span>
    );
    removeName = recipient.label;
  } else {
    leading = <MailTile />;
    label = showRole ? (
      <BidiInterpolatedText
        text={t("settingsPage.workspace.teamspaces.picker.emailChip", {
          email: BIDI_VALUE_TOKEN,
          // An invitation's role is across the workspace, not this teamspace's.
          role:
            recipient.role === "admin"
              ? t("workspaces.invite.role.admin")
              : t("workspaces.invite.role.member"),
        })}
        value={recipient.email}
      />
    ) : (
      <bdi dir="ltr">{recipient.email}</bdi>
    );
    removeName = recipient.email;
  }

  return (
    <li
      data-chip={recipient.kind}
      data-invalid={invalid ? "" : undefined}
      title={
        invalid ? t("workspaces.invite.errors.invalid", { email: isolate(removeName) }) : undefined
      }
      className={cn(
        "inline-flex h-[29px] max-w-full items-center gap-1.5 rounded-full ps-1 pe-0.5 text-xs",
        invalid ? CHIP_TONE_ERROR : CHIP_TONE_DEFAULT
      )}
    >
      {leading}
      <span className="truncate">{label}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        aria-label={t("workspaces.invite.removeRecipient", { email: isolate(removeName) })}
        className={CHIP_REMOVE_BUTTON}
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </li>
  );
}
