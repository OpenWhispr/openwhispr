import { useEffect, useReducer, useRef, useState, type ReactElement, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useWorkspaceSpaces } from "../../hooks/useWorkspaceSpaces";
import { confirmActionReducer } from "../../lib/confirmActionFlow";
import {
  classifySpaceError,
  rowActionErrorOf,
  type RowActionError,
} from "../../lib/workspaceErrors";
import { serverRefusalMessage } from "../../services/cloudApi";
import { SpacesService } from "../../services/SpacesService";
import { addPeopleToSpace, localSpaceIdFor } from "../../services/spaceActions";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { Workspace, WorkspaceMember, WorkspaceSpace } from "../../types/electron";
import { isolate } from "../../utils/bidiIsolate";
import { Office } from "../icons";
import {
  MENU_CHECK_ROW,
  MENU_ICON,
  MENU_PANEL,
  MENU_ROWS,
  MENU_SUBMENU_TRIGGER,
} from "./menuTokens";
import { TileGlyph } from "../notes/SpaceNameField";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "../ui/dropdown-menu";
import { useToast } from "../ui/useToast";
import { accessOf, dialogBoundaryOf } from "./AddToTeamList";
import { WorkspaceActionDialog } from "./WorkspaceActionDialog";

const NO_COVERAGE: ReadonlyMap<string, number> = new Map();

interface AddSubject {
  space: WorkspaceSpace;
  // What the dialog's title counts, fixed when the attempt starts: the roster can drop people who
  // left while the failure is showing.
  count: number;
}

interface AddToTeamspaceProps {
  workspace: Workspace;
  people: WorkspaceMember[];
  /** The people were added, so the caller clears its selection. */
  onAdded: () => void;
  onOpenTeamspace?: (localSpaceId: number) => void;
  /** What takes focus when a failed attempt's dialog is cancelled: the menu item that opened it is gone. */
  returnFocusRef: RefObject<HTMLElement | null>;
}

export interface AddToTeamspace {
  /** The "Add to teamspace" submenu, for inside a menu's content. */
  submenu: ReactElement;
  /** The menu holding the submenu opened: the submenu's next opening reads coverage again. */
  menuOpened: () => void;
  /** Outside the menu, which unmounts its content on close and would take a running dialog with it. */
  dialog: ReactElement | null;
}

// The line a failed attempt shows under its explanation. Only the server's own reason has one, and
// for someone having left the workspace that is the refusal's text.
function failureOf(error: unknown): RowActionError {
  const failure = classifySpaceError(error);
  if (failure.kind === "notWorkspaceMembers") {
    const message = serverRefusalMessage(error);
    return message ? { kind: "refused", message } : { kind: "failed" };
  }
  return rowActionErrorOf(failure);
}

/**
 * "Add to teamspace", a submenu of the bar's menu: the workspace's teamspaces for the people
 * selected on the Members tab. Choosing one adds them at once (a dialog holds the screen while it
 * runs); a failure keeps the selection and offers Try again.
 */
export function useAddToTeamspace({
  workspace,
  people,
  onAdded,
  onOpenTeamspace,
  returnFocusRef,
}: AddToTeamspaceProps): AddToTeamspace {
  const { t } = useTranslation();
  const { toast } = useToast();
  const refreshMembers = useWorkspaceStore((state) => state.refreshMembers);
  // The directory is read when the menu first opens, so the People page doesn't load it for nobody.
  const [opened, setOpened] = useState(false);
  const directory = useWorkspaceSpaces(workspace.id, opened);
  const [coverage, setCoverage] = useState(NO_COVERAGE);
  const coverageRequestRef = useRef(0);
  const [state, dispatch] = useReducer(confirmActionReducer<AddSubject>, { kind: "closed" });
  const inFlightRef = useRef(false);
  const [boundary, setBoundary] = useState<Element | null>(null);

  // The same shape as Add to team: a failed dialog's Try again belongs to the workspace it failed in.
  useEffect(() => {
    dispatch({ type: "dismiss" });
  }, [workspace.id]);

  async function readCoverage(userIds: string[]): Promise<void> {
    const request = ++coverageRequestRef.current;
    setCoverage(NO_COVERAGE);
    try {
      const rows = await SpacesService.coverage(workspace.id, userIds);
      if (request === coverageRequestRef.current) {
        setCoverage(new Map(rows.map((row) => [row.space_id, row.count])));
      }
    } catch {
      // Every box stays empty. Adding still works, since the server leaves anyone already in as
      // they are and reports them.
    }
  }

  // A submenu opens and closes as the pointer passes over it, so coverage is read once per opening
  // of the menu holding it rather than blanking the boxes on every pass.
  const coverageReadThisOpening = useRef(false);
  function menuOpened(): void {
    coverageReadThisOpening.current = false;
  }
  function handleOpenChange(open: boolean): void {
    if (!open) return;
    setBoundary(dialogBoundaryOf(returnFocusRef.current));
    setOpened(true);
    if (coverageReadThisOpening.current) return;
    coverageReadThisOpening.current = true;
    void readCoverage(people.map((person) => person.user_id));
  }

  async function openTeamspace(space: WorkspaceSpace): Promise<void> {
    let localId: number | null = null;
    try {
      localId = await localSpaceIdFor(space.id);
    } catch {
      // Reported the same way as a missing copy.
    }
    if (localId != null) {
      onOpenTeamspace?.(localId);
      return;
    }
    toast({
      title: t("common.error"),
      description: t("common.unknownError"),
      variant: "destructive",
    });
  }

  async function addTo(space: WorkspaceSpace): Promise<void> {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const userIds = people.map((person) => person.user_id);
    dispatch({ type: "open", subject: { space, count: userIds.length } });
    dispatch({ type: "confirm" });
    try {
      const { added } = await addPeopleToSpace(space.id, userIds);
      // A retry after a lost answer finds everyone already in, so it counts the selection.
      const count = added.length > 0 ? added.length : userIds.length;
      dispatch({ type: "succeeded" });
      onAdded();
      toast({
        title: t("settingsPage.workspace.teamspaces.addPeople.done", {
          count,
          space: isolate(space.name),
        }),
        actions: onOpenTeamspace
          ? [
              {
                label: t("settingsPage.workspace.teamspaces.openTeamspace"),
                onClick: () => openTeamspace(space),
              },
            ]
          : undefined,
      });
    } catch (error) {
      const failure = classifySpaceError(error);
      if (failure.kind === "gone" || failure.kind === "archived") {
        // Deleted or archived since the list was read, which no retry changes: say so and read the
        // list again, so the next opening shows what is left. `failed` first, since a running
        // dialog can't be dismissed.
        dispatch({ type: "failed", error: { kind: "failed" } });
        dispatch({ type: "dismiss" });
        toast({
          title: t("settingsPage.workspace.teamspaces.addPeople.failedTitle", {
            count: userIds.length,
          }),
          variant: "destructive",
        });
        void directory.reload();
        return;
      }
      if (failure.kind === "notWorkspaceMembers") {
        // Someone left the workspace since the roster loaded. Reading it again also drops them from
        // the selection, so Try again adds whoever is left.
        void refreshMembers(workspace.id).catch(() => undefined);
      }
      dispatch({ type: "failed", error: failureOf(error) });
    } finally {
      inFlightRef.current = false;
    }
  }

  const subject = state.kind === "running" || state.kind === "failed" ? state.subject : null;
  const failed = state.kind === "failed";
  const spaceName = subject ? isolate(subject.space.name) : "";
  // No connection to check and nothing to try again: this user can't do this any more.
  const ended =
    state.kind === "failed" &&
    (state.error.kind === "notAllowed" || state.error.kind === "ssoRequired")
      ? state.error.kind
      : null;

  const dismiss = (): void => {
    dispatch({ type: "dismiss" });
    // The menu item that opened this is gone, so nothing hands focus back and it would drop to the
    // page; the frame lets the dialog finish closing first.
    requestAnimationFrame(() => returnFocusRef.current?.focus());
  };

  const submenu = (
    <DropdownMenuSub onOpenChange={handleOpenChange}>
      <DropdownMenuSubTrigger className={MENU_SUBMENU_TRIGGER}>
        <Office className={MENU_ICON} aria-hidden="true" />
        {t("settingsPage.workspace.people.selection.addToTeamspace")}
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent
          sideOffset={6}
          collisionBoundary={boundary ?? undefined}
          className={MENU_PANEL}
        >
          {directory.status === "ready" && directory.spaces.length === 0 ? (
            <DropdownMenuItem disabled className="text-sm text-muted-foreground">
              {t("settingsPage.workspace.teamspaces.addPeople.none")}
            </DropdownMenuItem>
          ) : directory.status === "ready" ? (
            <div
              className={`${MENU_ROWS} max-h-[min(18rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto`}
            >
              {directory.spaces.map((space) => {
                const access = accessOf(coverage.get(space.id) ?? 0, people.length);
                return (
                  <DropdownMenuCheckboxItem
                    key={space.id}
                    checked={access}
                    // Everyone selected is in already, so there is nothing to add. It stays at full
                    // strength, as the frame draws it: a ticked box, not a dimmed choice.
                    disabled={access === true}
                    onSelect={() => void addTo(space)}
                    className={MENU_CHECK_ROW}
                  >
                    <span
                      aria-hidden="true"
                      className="flex size-4 shrink-0 items-center justify-center [&_.font-emoji]:text-sm"
                    >
                      <TileGlyph emoji={space.emoji} name={space.name} />
                    </span>
                    <span dir="auto" className="min-w-0 flex-1 truncate">
                      {space.name}
                    </span>
                  </DropdownMenuCheckboxItem>
                );
              })}
            </div>
          ) : directory.status === "failed" ? (
            <>
              <p role="status" className="px-2.5 py-2 text-sm text-muted-foreground">
                {t("settingsPage.workspace.teamspaces.addPeople.failed")}
              </p>
              <DropdownMenuItem
                className="text-sm"
                // Keeps the menu open, so the list can load into it.
                onSelect={(event) => {
                  event.preventDefault();
                  void directory.reload();
                }}
              >
                {t("settingsPage.workspace.teamspaces.retry")}
              </DropdownMenuItem>
            </>
          ) : (
            <p role="status" className="px-2.5 py-2 text-sm text-muted-foreground">
              {t("settingsPage.workspace.teamspaces.addPeople.loading")}
            </p>
          )}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );

  const dialog = subject ? (
    <WorkspaceActionDialog
      open
      icon="info"
      title={
        failed
          ? t("settingsPage.workspace.teamspaces.addPeople.failedTitle", {
              count: subject.count,
            })
          : t("settingsPage.workspace.teamspaces.addPeople.addingTitle", {
              count: subject.count,
            })
      }
      body={
        ended === "notAllowed"
          ? t("settingsPage.workspace.teamspaces.members.notAllowed", { space: spaceName })
          : ended === "ssoRequired"
            ? t("workspaces.ssoRequired", { workspace: isolate(workspace.name) })
            : failed
              ? t("settingsPage.workspace.teamspaces.addPeople.failedBody", { space: spaceName })
              : t("settingsPage.workspace.teamspaces.addPeople.addingBody", { space: spaceName })
      }
      error={state.kind === "failed" && state.error.kind === "refused" ? state.error.message : null}
      primary={
        ended
          ? { label: t("common.close"), onClick: dismiss, tone: "primary" }
          : {
              label: failed
                ? t("workspaces.exit.tryAgain")
                : t("settingsPage.workspace.teamspaces.addPeople.addingAction"),
              onClick: () => void addTo(subject.space),
              tone: "primary",
            }
      }
      cancelLabel={ended ? undefined : t("common.cancel")}
      busy={!failed}
      onDismiss={dismiss}
    />
  ) : null;

  return { submenu, menuOpened, dialog };
}
