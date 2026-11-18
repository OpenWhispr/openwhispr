import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, Office, Plus } from "../icons";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import { useToast } from "../ui/useToast";
import { TileGlyph } from "../notes/SpaceNameField";
import CreateSpaceDialog from "../notes/CreateSpaceDialog";
import { useWorkspaceSpaces } from "../../hooks/useWorkspaceSpaces";
import { workspaceCan } from "../../lib/capabilities";
import { formatList } from "../../lib/formatList";
import { classifyTeamAssignmentError } from "../../lib/workspaceErrors";
import { assignTeamToSpaces } from "../../services/spaceActions";
import { isolate } from "../../utils/bidiIsolate";
import type { Team, Workspace, WorkspaceSpace } from "../../types/electron";
import { HEADER_CELL, NAME_TILE, ROW_DIVIDER, TABLE_FRAME } from "./tableTokens";

const KEY = "settingsPage.workspace.teams";
const COPY = `${KEY}.spacesTab`;
const SPACES_KEY = "settingsPage.workspace.teamspaces";

interface SpaceRef {
  id: string;
  name: string;
  emoji: string | null;
}

interface TeamSpacesPanelProps {
  team: Team;
  workspace: Workspace;
  /** The team gained teamspaces, so the table's Teamspaces cell is out of date. */
  onChanged: () => void;
  /** The team is gone for this user. */
  onGone: () => void;
}

// A team's teamspaces: the ones it is in, and a field to add it to more. Only teamspaces the caller
// administers are offered, since the server requires a space admin to assign a team. Removing an
// assignment stays in the teamspace's own Members tab.
export default function TeamSpacesPanel({
  team,
  workspace,
  onChanged,
  onGone,
}: TeamSpacesPanelProps): ReactElement {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const directory = useWorkspaceSpaces(workspace.id);
  const { reload } = directory;
  // An answer that lands after the dialog moved on to another tab must not act on a screen that is
  // gone; the toast still says what happened.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const running = useRef(false);
  const fieldRef = useRef<HTMLInputElement>(null);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  // What the last attempt said, shown where the confirmation was until the selection changes.
  const [failureText, setFailureText] = useState<string | null>(null);
  // With nothing assigned the empty state leads, and its button brings the field in.
  const [revealed, setRevealed] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  // After an add: the field comes back with its list closed, so the result isn't covered.
  const [returnFocusRequest, setReturnFocusRequest] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  // What this panel added, so it reads as assigned and stops being offered before (or without) the
  // directory read that confirms it.
  const [addedSpaces, setAddedSpaces] = useState<SpaceRef[]>([]);

  const canCreate = workspaceCan(workspace, "create_spaces");
  const ready = directory.status === "ready";
  const listed = directory.spaces;

  const assigned = useMemo<SpaceRef[]>(() => {
    const known = new Map<string, SpaceRef>();
    const remember = ({ id, name, emoji }: SpaceRef): void => {
      if (!known.has(id)) known.set(id, { id, name, emoji });
    };
    if (ready) {
      listed.filter((space) => space.teams.some((entry) => entry.id === team.id)).forEach(remember);
    }
    (team.spaces ?? []).forEach(remember);
    addedSpaces.forEach(remember);
    return [...known.values()];
  }, [ready, listed, team.id, team.spaces, addedSpaces]);

  const choices = useMemo<WorkspaceSpace[]>(() => {
    if (!ready) return [];
    const assignedIds = new Set(assigned.map((space) => space.id));
    return listed.filter(
      (space) => space.capabilities?.manage_members === true && !assignedIds.has(space.id)
    );
  }, [ready, listed, assigned]);

  // What is staged is whatever is still a choice, so a teamspace deleted or lost since drops out.
  const staged = choices.filter((space) => selectedIds.includes(space.id));
  const stagedNames = staged.map((space) => space.name);
  const teamName = isolate(team.name);

  useEffect(() => {
    if (focusRequest > 0) fieldRef.current?.focus();
  }, [focusRequest]);

  const toggle = (spaceId: string): void => {
    setFailureText(null);
    setSelectedIds((current) =>
      current.includes(spaceId) ? current.filter((id) => id !== spaceId) : [...current, spaceId]
    );
  };

  const wordFailure = (failed: WorkspaceSpace[], reasons: string[]): string => {
    const names = formatList(
      i18n.language,
      failed.map((space) => isolate(space.name))
    );
    if (reasons.every((reason) => reason === "spaceGone"))
      return t(`${COPY}.gone`, { team: teamName, names });
    if (reasons.every((reason) => reason === "notAllowed"))
      return t(`${COPY}.notAllowed`, { names });
    return t(`${COPY}.failed`, { team: teamName });
  };

  const handleAdd = async (): Promise<void> => {
    if (running.current || staged.length === 0) return;
    running.current = true;
    const picks = staged;
    setAdding(true);
    setFailureText(null);
    let failures: { spaceId: string; error: unknown }[];
    try {
      ({ failures } = await assignTeamToSpaces(
        team.id,
        picks.map((space) => space.id)
      ));
    } catch (error) {
      // The action settles each request itself, so this is something it didn't expect.
      failures = picks.map((space) => ({ spaceId: space.id, error }));
    }
    running.current = false;

    const failedIds = new Set(failures.map((failure) => failure.spaceId));
    const added = picks.filter((space) => !failedIds.has(space.id));
    const failed = picks.filter((space) => failedIds.has(space.id));
    const reasons = failures.map((failure) => classifyTeamAssignmentError(failure.error));
    if (added.length > 0) {
      onChanged();
      if (mounted.current) {
        setAddedSpaces((current) => [
          ...current,
          ...added.map(({ id, name, emoji }) => ({ id, name, emoji })),
        ]);
      }
    }
    void reload();

    if (reasons.includes("teamGone")) {
      // Nothing can be added to a team that isn't there any more.
      toast({ title: t(`${KEY}.members.gone`, { team: teamName }), variant: "destructive" });
      if (mounted.current) {
        setAdding(false);
        onGone();
      }
      return;
    }
    let title: string;
    if (failed.length === 0) {
      title = t(`${COPY}.added`, { team: teamName, count: added.length });
    } else if (added.length === 0) {
      title = wordFailure(failed, reasons);
    } else {
      title = t(`${COPY}.addedPartly`, {
        team: teamName,
        added: formatList(
          i18n.language,
          added.map((space) => isolate(space.name))
        ),
        failed: formatList(
          i18n.language,
          failed.map((space) => isolate(space.name))
        ),
      });
    }
    // A failure reads inline while the panel is there; the toast is for one that outlived it.
    if (failed.length === 0 || !mounted.current) {
      toast(failed.length === 0 ? { title } : { title, variant: "destructive" });
    }
    if (!mounted.current) return;
    setAdding(false);
    setReturnFocusRequest((count) => count + 1);
    setSelectedIds(failed.map((space) => space.id));
    setFailureText(failed.length > 0 ? title : null);
  };

  const openCreate = (): void => setCreateOpen(true);
  const handleCreateOpenChange = (open: boolean): void => {
    setCreateOpen(open);
    if (open) return;
    // The new teamspace may already hold the team, so the list and the table read it again.
    void reload();
    onChanged();
  };
  const revealField = useCallback((): void => {
    setRevealed(true);
    setFocusRequest((count) => count + 1);
  }, []);

  const hasAssigned = assigned.length > 0;
  const hasChoices = choices.length > 0;

  const createButton = canCreate ? (
    <Button type="button" onClick={openCreate} className="rounded-full px-4">
      <Plus className="size-3.5" aria-hidden="true" />
      {t(`${SPACES_KEY}.create`)}
    </Button>
  ) : null;

  let body: ReactElement;
  if (directory.status === "failed" && !hasAssigned) {
    body = (
      <Message
        title={t(`${SPACES_KEY}.failedTitle`)}
        body={t(`${SPACES_KEY}.failedBody`)}
        action={
          <Button type="button" variant="outline" onClick={() => void reload()}>
            {t(`${SPACES_KEY}.retry`)}
          </Button>
        }
      />
    );
  } else if (!ready && !hasAssigned) {
    body = (
      <Message title={t(`${SPACES_KEY}.loadingTitle`)} busy body={t(`${SPACES_KEY}.loadingBody`)} />
    );
  } else if (!hasAssigned && !hasChoices) {
    // Nothing to read and nothing this person can add the team to.
    body =
      canCreate || listed.length === 0 ? (
        <Message
          title={t(`${COPY}.noSpacesTitle`)}
          body={t(`${COPY}.noSpacesBody`)}
          action={createButton}
        />
      ) : (
        <Message icon title={t(`${COPY}.emptyTitle`)} body={t(`${COPY}.emptyBody`)} />
      );
  } else if (!hasAssigned && !revealed && staged.length === 0) {
    body = (
      <Message
        title={t(`${COPY}.emptyTitle`)}
        body={t(`${COPY}.emptyBody`)}
        action={
          <Button type="button" onClick={revealField} className="rounded-full px-4">
            <Plus className="size-3.5" aria-hidden="true" />
            {t(`${COPY}.emptyAction`)}
          </Button>
        }
      />
    );
  } else {
    const addButton = (
      <Button
        type="button"
        onClick={() => void handleAdd()}
        disabled={adding || staged.length === 0}
        className="h-10 shrink-0 px-4 text-xs"
      >
        {adding && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
        {adding ? t(`${COPY}.adding`) : t(`${COPY}.add`)}
      </Button>
    );
    body = (
      <div className="space-y-3">
        {hasChoices && (
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <TeamspacePicker
                choices={choices}
                selectedIds={staged.map((space) => space.id)}
                summary={formatList(i18n.language, stagedNames)}
                disabled={adding}
                canCreate={canCreate}
                inputRef={fieldRef}
                returnFocusRequest={returnFocusRequest}
                onToggle={toggle}
                onCreate={openCreate}
              />
            </div>
            {addButton}
          </div>
        )}
        {staged.length > 0 ? (
          <div className="flex flex-col items-center gap-1 px-6 py-10 text-center">
            <StateTile />
            <p className="text-sm font-medium text-foreground">
              {t(`${COPY}.selectedTitle`, { count: staged.length })}
            </p>
            <p
              role={failureText ? "alert" : undefined}
              className={cn("text-xs", failureText ? "text-destructive" : "text-muted-foreground")}
            >
              {failureText ??
                t(`${COPY}.selectedBody`, {
                  team: teamName,
                  names: formatList(
                    i18n.language,
                    stagedNames.map((name) => isolate(name))
                  ),
                })}
            </p>
          </div>
        ) : hasAssigned ? (
          <>
            {failureText && (
              // Every teamspace it named has left the choices, so nothing staged carries the line.
              <p role="alert" className="text-xs text-destructive">
                {failureText}
              </p>
            )}
            <AssignedList spaces={assigned} label={t(`${KEY}.dialog.tabSpaces`)} />
          </>
        ) : (
          <Message icon title={t(`${COPY}.emptyTitle`)} body={t(`${COPY}.emptyBody`)} />
        )}
      </div>
    );
  }

  return (
    <>
      {body}
      {createOpen && (
        <CreateSpaceDialog
          open
          onOpenChange={handleCreateOpenChange}
          initialTeam={team}
          initialWorkspaceId={workspace.id}
          revealOnCreate={false}
        />
      )}
    </>
  );
}

// The 32px tile above a teamspace message, with the teamspace glyph in the link blue.
function StateTile(): ReactElement {
  return (
    <span
      aria-hidden="true"
      className="mb-2 flex size-8 items-center justify-center rounded-full bg-surface-3 text-primary"
    >
      <Office className="size-4" />
    </span>
  );
}

function Message({
  title,
  body,
  action,
  busy,
  icon = false,
}: {
  title: string;
  body: string;
  action?: ReactElement | null;
  busy?: boolean;
  /** Shows the teamspace tile above the title, for the states that say what a teamspace is. */
  icon?: boolean;
}): ReactElement {
  return (
    <div
      role="status"
      aria-busy={busy || undefined}
      className="flex flex-col items-center gap-1 px-6 py-10 text-center"
    >
      {icon ? <StateTile /> : null}
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// Emoji and name only: removing an assignment is the teamspace's own Members tab.
function AssignedList({ spaces, label }: { spaces: SpaceRef[]; label: string }): ReactElement {
  const { t } = useTranslation();
  return (
    <div className={cn(TABLE_FRAME, "overflow-hidden")}>
      <div
        tabIndex={0}
        role="region"
        aria-label={label}
        className="max-h-64 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <table className="w-full table-fixed border-collapse">
          <thead>
            <tr>
              <th scope="col" className={cn(HEADER_CELL, "px-4 text-start")}>
                {t(`${KEY}.columns.name`)}
              </th>
            </tr>
          </thead>
          <tbody>
            {spaces.map((space) => (
              <tr key={space.id} data-testid="assigned-space" className={ROW_DIVIDER}>
                <td className="px-4 py-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span aria-hidden="true" className={NAME_TILE}>
                      <TileGlyph emoji={space.emoji} name={space.name} />
                    </span>
                    <span dir="auto" className="min-w-0 truncate text-sm text-foreground">
                      {space.name}
                    </span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface TeamspacePickerProps {
  choices: WorkspaceSpace[];
  selectedIds: string[];
  /** The chosen names as a list in the reader's language, shown while the field's list is closed. */
  summary: string;
  disabled: boolean;
  canCreate: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  /** Each increase moves focus into the field with its list closed. */
  returnFocusRequest: number;
  onToggle: (spaceId: string) => void;
  onCreate: () => void;
}

// The field and its checkbox dropdown. It isn't SpacePeopleField: these are teamspaces, picked from
// a short list with no chips (the chosen names read in the field) and no invitations.
function TeamspacePicker({
  choices,
  selectedIds,
  summary,
  disabled,
  canCreate,
  inputRef,
  returnFocusRequest,
  onToggle,
  onCreate,
}: TeamspacePickerProps): ReactElement {
  const { t } = useTranslation();
  const listId = useId();
  const anchorRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(-1);

  const open = focused && !dismissed && !disabled;
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? choices.filter((space) => space.name.toLowerCase().includes(needle))
    : choices;
  // "Create new" is the list's last navigable row, so the keyboard reaches it from the field.
  const rowCount = matches.length + (canCreate ? 1 : 0);
  const activeIndex = active < rowCount ? active : -1;
  const createActive = canCreate && activeIndex === matches.length;

  useEffect(() => {
    if (returnFocusRequest === 0) return;
    inputRef.current?.focus();
    // Focus opens the list; this focus is only the field coming back.
    setDismissed(true);
  }, [returnFocusRequest, inputRef]);

  useEffect(() => {
    if (activeIndex < 0) return;
    // Missing in some test environments.
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, listId]);

  const handleChange = (value: string): void => {
    // Typing over the closed field's names starts a search rather than editing them.
    const typed =
      !open && summary && value.startsWith(summary) ? value.slice(summary.length) : value;
    setQuery(typed);
    setDismissed(false);
    setActive(-1);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (rowCount === 0) return;
      event.preventDefault();
      setDismissed(false);
      const down = event.key === "ArrowDown";
      setActive((current) => {
        const from = current < rowCount ? current : -1;
        if (from < 0) return down ? 0 : rowCount - 1;
        return (from + (down ? 1 : -1) + rowCount) % rowCount;
      });
    } else if (event.key === "Enter" && open && activeIndex >= 0) {
      event.preventDefault();
      if (createActive) {
        setDismissed(true);
        onCreate();
      } else {
        onToggle(matches[activeIndex].id);
      }
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // Radix closes the list on Escape before the dialog around it sees the key.
        if (!next) setDismissed(true);
      }}
    >
      <PopoverAnchor asChild>
        <div ref={anchorRef}>
          <Input
            ref={inputRef}
            dir="auto"
            type="text"
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={open && matches.length > 0 ? listId : undefined}
            aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
            disabled={disabled}
            value={open ? query : summary}
            placeholder={open ? t(`${COPY}.searchPlaceholder`) : t(`${COPY}.placeholder`)}
            onChange={(event) => handleChange(event.target.value)}
            onFocus={() => {
              setFocused(true);
              setDismissed(false);
            }}
            onBlur={() => {
              setFocused(false);
              setQuery("");
              setActive(-1);
            }}
            onClick={() => setDismissed(false)}
            onKeyDown={handleKeyDown}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        // Focus stays in the field, so typing carries on.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (event.target instanceof Node && anchorRef.current?.contains(event.target)) {
            event.preventDefault();
          }
        }}
        onMouseDown={(event) => event.preventDefault()}
        // The dialog's scroll lock cancels the wheel anywhere outside the dialog, and this list
        // sits in the body; the wheel stops here, so the lock never sees it.
        onWheel={(event) => event.stopPropagation()}
        className="max-h-[min(18rem,var(--radix-popover-content-available-height))] w-[var(--radix-popover-trigger-width)] min-w-0 overflow-y-auto rounded-xl p-1.5"
      >
        {matches.length > 0 ? (
          <div
            id={listId}
            role="listbox"
            aria-multiselectable="true"
            aria-label={t(`${COPY}.searchPlaceholder`)}
            className="flex flex-col gap-0.5"
          >
            {matches.map((space, index) => {
              const checked = selectedIds.includes(space.id);
              return (
                <div
                  key={space.id}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={checked}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => onToggle(space.id)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-start",
                    index === activeIndex && "bg-muted"
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
                      checked
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border/80"
                    )}
                  >
                    {checked && <Check className="size-3" />}
                  </span>
                  <span
                    aria-hidden="true"
                    className="flex size-4 shrink-0 items-center justify-center [&_.font-emoji]:text-sm"
                  >
                    <TileGlyph emoji={space.emoji} name={space.name} />
                  </span>
                  <span dir="auto" className="min-w-0 flex-1 truncate text-sm">
                    {space.name}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <p role="status" className="px-2.5 py-2 text-sm text-muted-foreground">
            {t(`${COPY}.noMatches`)}
          </p>
        )}
        {canCreate && (
          <div className="mt-1 border-t border-border/60 pt-1">
            <button
              type="button"
              id={`${listId}-${matches.length}`}
              onMouseEnter={() => setActive(matches.length)}
              onClick={() => {
                setDismissed(true);
                onCreate();
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-start text-sm text-foreground hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
                createActive && "bg-muted"
              )}
            >
              <Plus className="size-3.5 text-muted-foreground" aria-hidden="true" />
              {t(`${COPY}.createNew`)}
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
