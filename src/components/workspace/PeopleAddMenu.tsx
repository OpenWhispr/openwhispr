import { useEffect, useReducer, useRef, useState, type ReactElement, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useWorkspaceTeams, type WorkspaceTeamsState } from "../../hooks/useWorkspaceTeams";
import { teamCreationFor } from "../../lib/capabilities";
import { confirmActionReducer } from "../../lib/confirmActionFlow";
import { formatList } from "../../lib/formatList";
import { classifyTeamError } from "../../lib/workspaceErrors";
import { serverRefusalMessage } from "../../services/cloudApi";
import { addPeopleToTeam } from "../../services/spaceActions";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { Team, Workspace, WorkspaceMember } from "../../types/electron";
import { isolate } from "../../utils/bidiIsolate";
import { ChevronDown, Plus, UserPlus } from "../icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { useToast } from "../ui/useToast";
import { MENU_ICON, MENU_PANEL, MENU_ROW, MENU_ROWS, MENU_SUBMENU_TRIGGER } from "./menuTokens";
import { AddToTeamList, dialogBoundaryOf, teamCoverage } from "./AddToTeamList";
import type { AddToTeamspace } from "./AddToTeamspaceMenu";
import { WorkspaceActionDialog } from "./WorkspaceActionDialog";
import { RAISED_PILL, SPLIT_PILL, SPLIT_PILL_CHEVRON, SPLIT_PILL_LABEL } from "./dialogButtons";
import { cn } from "../lib/utils";

export { teamCoverage };

const COPY = "settingsPage.workspace.teams";
// Names fit in a sentence up to here; a longer list reads as a count.
const MAX_NAMED = 2;

interface AddSubject {
  team: Team;
  // What the dialog's title counts, fixed when the attempt starts: the roster can drop people who
  // left while the failure is showing.
  count: number;
  names: ReadonlyMap<string, string>;
  // Who the roster showed on the team before this action began, which is how a retry tells people
  // an earlier try of this very action added from people who were there already.
  onTeamBefore: ReadonlySet<string>;
  onAdded: () => void;
  returnFocus: () => void;
}

interface AddOptions {
  /** The people were added, so the caller clears its selection. */
  onAdded?: () => void;
  /** Hands focus back to the control that opened the menu once a cancelled dialog has closed. */
  returnFocus?: () => void;
}

export interface PeopleTeamAdd {
  teams: WorkspaceTeamsState;
  /** A menu that holds the team list opened: its next `open` reads the lists again. */
  menuOpened: () => void;
  /** The team list is read when a menu first opens it, so the page doesn't load it for nobody. */
  open: () => void;
  add: (team: Team, people: WorkspaceMember[], options?: AddOptions) => void;
  /** Outside any menu, which unmounts its content on close and would take a running dialog along. */
  dialog: ReactElement | null;
}

/**
 * Adds people to a team through the batch route, which keeps anyone already on it as they are (the
 * single-member route would lower an admin to member). A dialog holds the screen while it runs; a
 * failure keeps the caller's selection and offers Try again.
 */
export function useAddPeopleToTeam(workspace: Workspace): PeopleTeamAdd {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const refreshMembers = useWorkspaceStore((state) => state.refreshMembers);
  const [activated, setActivated] = useState(false);
  const teams = useWorkspaceTeams(workspace.id, activated);
  const [state, dispatch] = useReducer(confirmActionReducer<AddSubject>, { kind: "closed" });
  const inFlightRef = useRef(false);
  // People the server said have left the workspace drop out of a retry; counted from this action's
  // first try.
  const remainingRef = useRef<string[]>([]);
  const attemptsRef = useRef(0);
  // An answer can land after the page moved on. It still has to reach the user, but it has no
  // dialog or selection left to act on.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A failed dialog's Try again would add to the old workspace's team once the page has moved to
  // another. A running one can't be taken back and finishes for the team it started on.
  useEffect(() => {
    dispatch({ type: "dismiss" });
  }, [workspace.id]);

  function namesOf(subject: AddSubject, userIds: string[]): string {
    return formatList(
      i18n.language,
      userIds.map((id) => isolate(subject.names.get(id) ?? id))
    );
  }

  // What the toast says, by what the server reported.
  function outcomeTitle(
    subject: AddSubject,
    result: { added: string[]; already_members: string[] }
  ): string {
    let added = result.added;
    let already = result.already_members;
    if (attemptsRef.current > 1) {
      // A try whose answer was lost may have landed, so on Try again its people come back as
      // already members. Only those who were on the team before the action began were.
      added = [...added, ...already.filter((id) => !subject.onTeamBefore.has(id))];
      already = already.filter((id) => subject.onTeamBefore.has(id));
    }
    const team = isolate(subject.team.name);
    if (added.length > 0 && already.length > 0) {
      if (added.length <= MAX_NAMED && already.length <= MAX_NAMED) {
        return t(`${COPY}.addPeople.${already.length === 1 ? "someDone" : "someDonePlural"}`, {
          added: namesOf(subject, added),
          already: namesOf(subject, already),
          team,
        });
      }
      return t(`${COPY}.addPeople.done`, { count: added.length, team });
    }
    // Nobody new: the roster was a step behind. A retry after a lost answer never lands here, since
    // those people were counted as added above.
    if (added.length === 0) return t(`${COPY}.addPeople.allAlready`, { team });
    return t(`${COPY}.addPeople.done`, { count: added.length, team });
  }

  function dismiss(subject: AddSubject): void {
    dispatch({ type: "dismiss" });
    // The menu item that opened the dialog is gone, so nothing hands focus back and it would drop
    // to the page; the frame lets the dialog finish closing first.
    requestAnimationFrame(subject.returnFocus);
  }

  async function run(first: AddSubject): Promise<void> {
    if (inFlightRef.current) return;
    if (remainingRef.current.length === 0) {
      // Everyone left the workspace, so there is nobody to retry for.
      dismiss(first);
      return;
    }
    inFlightRef.current = true;
    attemptsRef.current += 1;
    const userIds = remainingRef.current;
    // The title counts who this attempt sends, which is fewer after someone left.
    const subject = { ...first, count: userIds.length };
    dispatch({ type: "open", subject });
    dispatch({ type: "confirm" });
    try {
      const result = await addPeopleToTeam(subject.team.id, userIds);
      // The Team column reads the roster, so it is read again before the selection clears.
      if (mountedRef.current) await refreshMembers(workspace.id).catch(() => undefined);
      const title = outcomeTitle(subject, result);
      if (mountedRef.current) {
        dispatch({ type: "succeeded" });
        subject.onAdded();
      }
      toast({ title });
    } catch (error) {
      const failure = classifyTeamError(error);
      const teamName = isolate(subject.team.name);
      if (failure.kind === "gone" || failure.kind === "notAllowed") {
        // Neither changes with a retry: the team is deleted, or the caller no longer manages it.
        // `failed` first, since a running dialog can't be dismissed.
        if (mountedRef.current) {
          dispatch({ type: "failed", error: { kind: "failed" } });
          dismiss(subject);
        }
        toast({
          title: t(`${COPY}.members.${failure.kind === "gone" ? "gone" : "notAllowed"}`, {
            team: teamName,
          }),
          variant: "destructive",
        });
        void teams.reload();
        return;
      }
      if (!mountedRef.current) {
        toast({
          title: t(`${COPY}.addPeople.failedTitle`, { count: subject.count }),
          variant: "destructive",
        });
        return;
      }
      if (failure.kind === "notWorkspaceMembers") {
        // Someone left the workspace since the roster loaded. Reading it again drops them from the
        // selection, and Try again adds whoever is left.
        const left = new Set(failure.userIds);
        remainingRef.current = userIds.filter((id) => !left.has(id));
        void refreshMembers(workspace.id).catch(() => undefined);
        // The server's own text names nobody and is English everywhere, so who left is named here.
        const named = failure.userIds.flatMap((id) => subject.names.get(id) ?? []);
        const message =
          named.length > 0 && named.length === failure.userIds.length
            ? t(`${COPY}.addPeople.left`, { names: formatList(i18n.language, named.map(isolate)) })
            : serverRefusalMessage(error);
        dispatch({
          type: "failed",
          error: message ? { kind: "refused", message } : { kind: "failed" },
        });
        return;
      }
      if (failure.kind === "ssoRequired") {
        dispatch({ type: "failed", error: failure });
        return;
      }
      if (failure.kind === "refused") {
        // A directory team's refusal and the like: the list may be stale as well.
        void teams.reload();
      }
      dispatch({
        type: "failed",
        error: failure.kind === "refused" ? failure : { kind: "failed" },
      });
    } finally {
      inFlightRef.current = false;
    }
  }

  function add(team: Team, people: WorkspaceMember[], options: AddOptions = {}): void {
    if (inFlightRef.current) return;
    const userIds = people.map((person) => person.user_id);
    remainingRef.current = userIds;
    attemptsRef.current = 0;
    void run({
      team,
      count: userIds.length,
      names: new Map(people.map((person) => [person.user_id, person.name || person.email])),
      onTeamBefore: new Set(
        people.filter((person) => teamCoverage([person], team.id) > 0).map((p) => p.user_id)
      ),
      onAdded: options.onAdded ?? (() => undefined),
      returnFocus: options.returnFocus ?? (() => undefined),
    });
  }

  const subject = state.kind === "running" || state.kind === "failed" ? state.subject : null;
  const failed = state.kind === "failed";
  const teamName = subject ? isolate(subject.team.name) : "";
  // Signing in with the company's SSO is the only way out of that refusal, which a retry can't be.
  const needsSso = state.kind === "failed" && state.error.kind === "ssoRequired";
  let errorLine: string | null = null;
  if (state.kind === "failed" && state.error.kind === "refused") errorLine = state.error.message;
  if (needsSso) errorLine = t("workspaces.ssoRequired", { workspace: isolate(workspace.name) });
  const dialog = subject ? (
    <WorkspaceActionDialog
      open
      icon="info"
      title={t(`${COPY}.addPeople.${failed ? "failedTitle" : "addingTitle"}`, {
        count: subject.count,
      })}
      body={t(`${COPY}.addPeople.${failed ? "failedBody" : "addingBody"}`, { team: teamName })}
      error={errorLine}
      primary={
        needsSso
          ? { label: t("common.close"), onClick: () => dismiss(subject), tone: "primary" }
          : {
              label: failed ? t("workspaces.exit.tryAgain") : t(`${COPY}.addPeople.addingAction`),
              onClick: () => void run(subject),
              tone: "primary",
            }
      }
      cancelLabel={needsSso ? undefined : t("common.cancel")}
      busy={!failed}
      onDismiss={() => dismiss(subject)}
    />
  ) : null;

  // The boxes read the roster and the list, both as they were when the page loaded, so each opening
  // reads them again: someone else may have changed a team since, and a stale ticked box can't be
  // picked. The first opening has no list yet, and activating loads it. A submenu opens and closes
  // as the pointer passes over it, so that is once per opening of the menu holding it.
  const readThisOpening = useRef(false);
  function menuOpened(): void {
    readThisOpening.current = false;
  }
  function open(): void {
    if (readThisOpening.current) return;
    readThisOpening.current = true;
    if (activated) void teams.reload();
    else setActivated(true);
    void refreshMembers(workspace.id).catch(() => undefined);
  }

  return { teams, menuOpened, open, add, dialog };
}

interface PeopleAddMenuProps {
  workspace: Workspace;
  people: WorkspaceMember[];
  /** The people were added, so the caller clears its selection. */
  onAdded: () => void;
  /**
   * The page owns both controllers (and their dialogs), since the bar goes away when the roster
   * refresh empties the selection and a dialog inside it would go with it.
   */
  teamAdd: PeopleTeamAdd;
  teamspace: AddToTeamspace;
  /** Whichever button opened a menu, which the teamspace controller hands focus back to. */
  openerRef: RefObject<HTMLElement | null>;
  /** Create team with selected, which opens the form or the paywall; the page decides which. */
  onCreateTeam: () => void;
}

/**
 * The selection bar's split button, one pill like People's Add. The label opens the team list; the
 * chevron opens the menu with Add to team ▸, Add to teamspace ▸ and Create team with selected.
 */
export function PeopleAddMenu({
  workspace,
  people,
  onAdded,
  teamAdd,
  teamspace,
  openerRef,
  onCreateTeam,
}: PeopleAddMenuProps): ReactElement {
  const { t } = useTranslation();
  const labelRef = useRef<HTMLButtonElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const [boundary, setBoundary] = useState<Element | null>(null);

  const choose = (team: Team): void =>
    teamAdd.add(team, people, {
      onAdded,
      returnFocus: () => openerRef.current?.focus(),
    });

  return (
    <div className={cn(SPLIT_PILL, RAISED_PILL)}>
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) return;
          openerRef.current = labelRef.current;
          teamAdd.menuOpened();
          teamAdd.open();
        }}
      >
        <DropdownMenuTrigger asChild>
          <button ref={labelRef} type="button" className={SPLIT_PILL_LABEL}>
            <Plus className="size-3.5" aria-hidden="true" />
            {t("settingsPage.workspace.people.selection.addToTeam")}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="w-64 max-w-[calc(100vw-32px)]">
          <AddToTeamList
            workspace={workspace}
            teams={teamAdd.teams}
            people={people}
            onChoose={choose}
          />
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) return;
          openerRef.current = chevronRef.current;
          setBoundary(dialogBoundaryOf(chevronRef.current));
          teamAdd.menuOpened();
          teamspace.menuOpened();
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            ref={chevronRef}
            type="button"
            aria-label={t("settingsPage.workspace.people.addMenu.label")}
            className={SPLIT_PILL_CHEVRON}
          >
            <ChevronDown className="size-3.5" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className={`${MENU_PANEL} ${MENU_ROWS}`}>
          <DropdownMenuSub onOpenChange={(open) => open && teamAdd.open()}>
            <DropdownMenuSubTrigger className={MENU_SUBMENU_TRIGGER}>
              <UserPlus className={MENU_ICON} aria-hidden="true" />
              {t("settingsPage.workspace.people.selection.addToTeam")}
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent
                sideOffset={6}
                collisionBoundary={boundary ?? undefined}
                className={MENU_PANEL}
              >
                <AddToTeamList
                  workspace={workspace}
                  teams={teamAdd.teams}
                  people={people}
                  onChoose={choose}
                />
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
          {teamspace.submenu}
          {teamCreationFor(workspace) !== "unavailable" ? (
            <>
              <DropdownMenuSeparator className="mx-0 my-0" />
              <DropdownMenuItem className={MENU_ROW} onSelect={onCreateTeam}>
                <UserPlus className={MENU_ICON} aria-hidden="true" />
                {t("settingsPage.workspace.people.selection.createTeam")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
