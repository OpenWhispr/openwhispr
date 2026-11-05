import { useReducer, useRef, useState, type ReactElement } from "react";
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
import { ChevronDown, Plus } from "../icons";
import { TileGlyph } from "../notes/SpaceNameField";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { useToast } from "../ui/useToast";
import { WorkspaceActionDialog } from "./WorkspaceActionDialog";

const NO_COVERAGE: ReadonlyMap<string, number> = new Map();

interface AddSubject {
  space: WorkspaceSpace;
  // What the dialog's title counts, fixed when the attempt starts: the roster can drop people who
  // left while the failure is showing.
  count: number;
}

interface AddToTeamspaceMenuProps {
  workspace: Workspace;
  people: WorkspaceMember[];
  /** The people were added, so the caller clears its selection. */
  onAdded: () => void;
  onOpenTeamspace?: (localSpaceId: number) => void;
}

// One box state for the row: nobody, some (a dash) or everyone selected already has access.
function accessOf(covered: number, total: number): boolean | "indeterminate" {
  if (total > 0 && covered >= total) return true;
  return covered > 0 ? "indeterminate" : false;
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
 * The bar's "Add to teamspace": a menu of the workspace's teamspaces for the people selected on the
 * Members tab. Choosing one adds them at once (a dialog holds the screen while it runs); a failure
 * keeps the selection and offers Try again.
 */
export function AddToTeamspaceMenu({
  workspace,
  people,
  onAdded,
  onOpenTeamspace,
}: AddToTeamspaceMenuProps): ReactElement {
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
  const triggerRef = useRef<HTMLButtonElement>(null);

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

  function handleOpenChange(open: boolean): void {
    if (!open) return;
    setOpened(true);
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
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <>
      <DropdownMenu onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button ref={triggerRef} type="button" variant="ghost" size="sm">
            <Plus className="size-3.5" aria-hidden="true" />
            {t("settingsPage.workspace.people.selection.addToTeamspace")}
            <ChevronDown className="size-3 text-muted-foreground" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="w-64 max-w-[calc(100vw-32px)]">
          {directory.status === "ready" && directory.spaces.length === 0 ? (
            <DropdownMenuItem disabled className="text-sm text-muted-foreground">
              {t("settingsPage.workspace.teamspaces.addPeople.none")}
            </DropdownMenuItem>
          ) : directory.status === "ready" ? (
            <div className="max-h-[min(18rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto">
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
                    className="gap-2 rounded-lg py-2 pe-2.5 focus:bg-muted data-[disabled]:opacity-100"
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
        </DropdownMenuContent>
      </DropdownMenu>

      {subject ? (
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
                  ? t("settingsPage.workspace.teamspaces.addPeople.failedBody", {
                      space: spaceName,
                    })
                  : t("settingsPage.workspace.teamspaces.addPeople.addingBody", {
                      space: spaceName,
                    })
          }
          error={
            state.kind === "failed" && state.error.kind === "refused" ? state.error.message : null
          }
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
      ) : null}
    </>
  );
}
