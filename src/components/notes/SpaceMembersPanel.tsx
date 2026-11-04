import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactElement,
} from "react";
import type { TFunction } from "i18next";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { useToast } from "../ui/useToast";
import { WorkspaceActionDialog } from "../workspace/WorkspaceActionDialog";
import { cn } from "../lib/utils";
import { useAuth } from "../../hooks/useAuth";
import { useMemberRoster } from "../../hooks/useMemberRoster";
import { spaceCan, workspaceCan } from "../../lib/capabilities";
import { confirmActionReducer } from "../../lib/confirmActionFlow";
import { formatList } from "../../lib/formatList";
import { rosterFor } from "../../lib/peopleRoster";
import {
  attemptSummary,
  canRetry,
  remainingAfter,
  seatRoomLeft,
  settleListedInvites,
  spaceAccessEnd,
  type AddAttemptOutcome,
  type InviteRefusal,
  type SpaceAccessEnd,
} from "../../lib/addSpaceMembersFlow";
import { MAX_INVITE_RECIPIENTS } from "../../lib/inviteFlow";
import { buildSpaceMemberRows, type SpaceMemberRow } from "../../lib/spaceMemberRows";
import {
  addRecipients,
  memberRecipient,
  pickedSummary,
  type PickedRecipient,
} from "../../lib/spacePeoplePicker";
import { classifySpaceError, rowActionErrorOf } from "../../lib/workspaceErrors";
import { invitePeople } from "../../services/invitePeople";
import { SpacesService, type SpaceMemberEntry } from "../../services/SpacesService";
import {
  addPeopleToSpace,
  assignTeamToSpace,
  leaveSpace,
  removeSpaceMember,
  requestSpacesResync,
  setSpaceMemberRole,
  setSpaceTeamAccess,
  unassignTeamFromSpace,
} from "../../services/spaceActions";
import { TeamsService } from "../../services/TeamsService";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { SpaceInvitation, SpaceItem, Team, TeamRole } from "../../types/electron";
import { isolate } from "../../utils/bidiIsolate";
import { SpaceMembersTable, type SpaceMembersStatus } from "./SpaceMembersTable";
import { SpacePeopleField } from "./SpacePeopleField";

const COPY = "settingsPage.workspace.teamspaces.members";
const NO_INVITATIONS: SpaceInvitation[] = [];
const NO_TEAMS: Team[] = [];

interface SpaceMembersPanelProps {
  space: SpaceItem;
  /** The signed-in user's access ended (they left, or it's gone): whatever hosts this can close. */
  onLeft?: () => void;
}

type LoadStatus = "idle" | "loading" | "ready" | "failed";

// Reads one thing for the panel and reads it again on demand. A reload keeps showing what it had,
// so the field and its chips never give way to a placeholder in the middle of someone's work.
function useLoad<T>(
  load: (() => Promise<T>) | null,
  empty: T
): { status: LoadStatus; data: T; reload: () => Promise<T | null> } {
  const [state, setState] = useState<{ status: LoadStatus; data: T }>({
    status: load ? "loading" : "idle",
    data: empty,
  });
  const latest = useRef(0);

  // Resolves with what it read, or null when the read failed or was overtaken.
  const run = useCallback(async (): Promise<T | null> => {
    if (!load) return null;
    const request = ++latest.current;
    setState((current) =>
      current.status === "ready" ? current : { ...current, status: "loading" }
    );
    try {
      const data = await load();
      if (latest.current !== request) return null;
      setState({ status: "ready", data });
      return data;
    } catch {
      if (latest.current === request) setState((current) => ({ ...current, status: "failed" }));
      return null;
    }
  }, [load]);

  useEffect(() => {
    void run();
    // An answer for what was loaded before must not land on what is loaded now.
    return () => {
      latest.current += 1;
    };
  }, [run]);

  return { status: load ? state.status : "idle", data: state.data, reload: run };
}

type MemberRecipient = Extract<PickedRecipient, { kind: "member" }>;
type GroupRecipient = Extract<PickedRecipient, { kind: "group" }>;
type EmailRecipient = Extract<PickedRecipient, { kind: "email" }>;

const isMember = (recipient: PickedRecipient): recipient is MemberRecipient =>
  recipient.kind === "member";
const isGroup = (recipient: PickedRecipient): recipient is GroupRecipient =>
  recipient.kind === "group";
// An invalid address never goes out as one to invite; the field blocks Add members until it is fixed.
const isInvitable = (recipient: PickedRecipient): recipient is EmailRecipient =>
  recipient.kind === "email" && recipient.valid;

const recipientLabel = (recipient: PickedRecipient): string =>
  recipient.kind === "email" ? recipient.email : recipient.label;

function emptyOutcome(): AddAttemptOutcome {
  return {
    addedMembers: [],
    failedMembers: [],
    addedGroups: [],
    failedGroups: [],
    invited: [],
    undeliveredInvites: [],
    failedInvites: [],
    refusedInvites: [],
    skippedInvites: [],
    leftMembers: [],
  };
}

// One Add members attempt: people in one batch, each group on its own, then the addresses once
// for each role. Nothing here throws; whatever didn't go is reported as failed so it stays staged.
async function runAddAttempt(input: {
  space: SpaceItem;
  cloudSpaceId: string;
  picked: PickedRecipient[];
}): Promise<{
  outcome: AddAttemptOutcome;
  rosterStale: boolean;
  knownAddresses: string[];
  ended: SpaceAccessEnd | null;
}> {
  const { space, cloudSpaceId, picked } = input;
  const outcome = emptyOutcome();
  let rosterStale = false;
  // Addresses the server says belong to a workspace member, which the roster should now resolve.
  const knownAddresses: string[] = [];
  // Nothing else can go either, and nothing is held for a retry that can't work. Addresses come
  // last, so none has been tried yet.
  const stoppedBy = (ended: SpaceAccessEnd) => {
    outcome.failedMembers = [];
    outcome.failedGroups = [];
    return { outcome, rosterStale, knownAddresses, ended };
  };

  const people = picked.filter(isMember);
  if (people.length > 0) {
    try {
      // People who are in already come back as already_members: nothing left to do for them.
      await addPeopleToSpace(
        cloudSpaceId,
        people.map((recipient) => recipient.userId)
      );
      outcome.addedMembers = people;
    } catch (error) {
      const failure = classifySpaceError(error);
      const ended = spaceAccessEnd(failure);
      if (ended) return stoppedBy(ended);
      const gone =
        failure.kind === "notWorkspaceMembers" ? new Set(failure.userIds) : new Set<string>();
      // One person who left must not hold everyone else back, nor be sent again and refused again.
      outcome.leftMembers = people.filter((recipient) => gone.has(recipient.userId));
      outcome.failedMembers = people.filter((recipient) => !gone.has(recipient.userId));
      if (outcome.leftMembers.length > 0) rosterStale = true;
    }
  }

  for (const recipient of picked.filter(isGroup)) {
    try {
      await assignTeamToSpace(space, recipient.teamId);
      outcome.addedGroups.push(recipient);
    } catch (error) {
      const ended = spaceAccessEnd(classifySpaceError(error));
      if (ended) return stoppedBy(ended);
      outcome.failedGroups.push(recipient);
    }
  }

  const addresses = picked.filter(isInvitable);
  for (const role of ["member", "admin"] as const) {
    const batch = addresses.filter((recipient) => recipient.role === role);
    if (batch.length === 0) continue;
    const byAddress = new Map(batch.map((recipient) => [recipient.email.toLowerCase(), recipient]));
    const reported = new Set<string>();
    try {
      await invitePeople.sendInvitations({
        workspaceId: space.workspace_id,
        emails: batch.map((recipient) => recipient.email),
        role,
        spaceIds: [cloudSpaceId],
        onResult: (email, result) => {
          const key = email.toLowerCase();
          const recipient = byAddress.get(key);
          if (!recipient) return;
          reported.add(key);
          if (result.ok === true || result.grantsAdded === true) {
            outcome.invited.push(recipient);
            if (result.ok === true && !result.emailSent) outcome.undeliveredInvites.push(recipient);
          }
          // An older API attaches no teamspace to an invitation that already exists, so this
          // address isn't in the teamspace, and sending it again wouldn't change that.
          else if (result.kind === "alreadyInvited") outcome.skippedInvites.push(recipient);
          else if (result.kind === "alreadyMember") {
            // They are a workspace member after all: the roster this field offered from is stale.
            outcome.failedInvites.push(recipient);
            rosterStale = true;
            knownAddresses.push(key);
          } else if (result.kind === "requestFailed") outcome.failedInvites.push(recipient);
          else outcome.refusedInvites.push({ recipient, failure: result });
        },
      });
    } catch {
      // Whatever it didn't get to report is handled below.
    }
    for (const [key, recipient] of byAddress) {
      if (!reported.has(key)) outcome.failedInvites.push(recipient);
    }
  }

  return { outcome, rosterStale, knownAddresses, ended: null };
}

interface StatusLine {
  text: string;
  tone: "info" | "error";
}

function describeAttempt(
  t: TFunction,
  language: string,
  outcome: AddAttemptOutcome,
  workspaceName: string
): StatusLine {
  const names = (recipients: PickedRecipient[]): string =>
    formatList(
      language,
      recipients.map((recipient) => isolate(recipientLabel(recipient)))
    );
  const sentences: string[] = [];
  const kind = attemptSummary(outcome).kind;
  const delivered = outcome.invited.filter(
    (recipient) => !outcome.undeliveredInvites.includes(recipient)
  );
  const undelivered = outcome.undeliveredInvites;
  // Their invitation is there, but nobody told them: Invitations is where it can be sent again.
  const invitedSentences = (): string[] => [
    ...(delivered.length > 0 ? [t(`${COPY}.resultInvited`, { names: names(delivered) })] : []),
    ...(undelivered.length > 0
      ? [t(`${COPY}.resultInvitedNoEmail`, { names: names(undelivered) })]
      : []),
  ];

  // What the invite dialog says about each kind. Some of its lines name nobody, and a refused
  // address leaves the field, so they are followed by who wasn't invited.
  const refusalSentences = (refusals: InviteRefusal[]): string[] => {
    const { failure } = refusals[0];
    const recipients = refusals.map(({ recipient }) => recipient);
    const notInvited = t(
      recipients.length === 1 ? `${COPY}.notInvited` : `${COPY}.notInvitedMany`,
      { names: names(recipients) }
    );
    switch (failure.kind) {
      case "seatLimit": {
        const room = seatRoomLeft(failure);
        return room > 0
          ? [t("workspaces.invite.ceilingLeft", { count: room, excess: recipients.length - room })]
          : [t("workspaces.invite.errors.seatLimit"), notInvited];
      }
      case "notAllowed":
      case "ssoRequired":
        return [
          t(`workspaces.invite.errors.${failure.kind}`, { workspace: isolate(workspaceName) }),
          notInvited,
        ];
      case "refused":
        return [
          t("workspaces.invite.errors.refused", {
            email: names(recipients),
            reason: isolate(failure.message),
          }),
        ];
      default:
        return [t(`workspaces.invite.errors.${failure.kind}`, { email: names(recipients) })];
    }
  };

  if (kind === "allDone") {
    if (outcome.addedMembers.length > 0) {
      sentences.push(t(`${COPY}.resultAdded`, { names: names(outcome.addedMembers) }));
    }
    sentences.push(...invitedSentences());
    if (outcome.addedGroups.length === 1) {
      sentences.push(t(`${COPY}.resultGroup`, { group: names(outcome.addedGroups) }));
    } else if (outcome.addedGroups.length > 1) {
      sentences.push(t(`${COPY}.resultGroups`, { names: names(outcome.addedGroups) }));
    }
  } else if (kind === "allFailed") {
    sentences.push(t(`${COPY}.failed`));
  } else {
    const added = [...outcome.addedMembers, ...outcome.addedGroups];
    if (added.length > 0) {
      sentences.push(
        t(added.length === 1 ? `${COPY}.partialAdded` : `${COPY}.partialAddedMany`, {
          names: names(added),
        })
      );
    }
    sentences.push(...invitedSentences());
    if (outcome.failedInvites.length > 0) {
      sentences.push(
        t(
          outcome.failedInvites.length === 1
            ? `${COPY}.partialInviteFailed`
            : `${COPY}.partialInviteFailedMany`,
          { names: names(outcome.failedInvites) }
        )
      );
    }
    const notAdded = [...outcome.failedMembers, ...outcome.failedGroups];
    if (notAdded.length > 0) {
      sentences.push(t(`${COPY}.partialAddFailed`, { names: names(notAdded) }));
    }
  }

  // A batch's refusal answers for every address in it, so each reason is said once.
  const byReason = new Map<string, InviteRefusal[]>();
  for (const refusal of outcome.refusedInvites) {
    const { failure } = refusal;
    const reason = failure.kind === "refused" ? `refused:${failure.message}` : failure.kind;
    byReason.set(reason, [...(byReason.get(reason) ?? []), refusal]);
  }
  for (const refusals of byReason.values()) sentences.push(...refusalSentences(refusals));

  if (outcome.leftMembers.length > 0) {
    sentences.push(t(`${COPY}.partialLeft`, { names: names(outcome.leftMembers) }));
  }
  if (outcome.skippedInvites.length > 0) {
    sentences.push(
      t(
        outcome.skippedInvites.length === 1
          ? `${COPY}.skippedInvited`
          : `${COPY}.skippedInvitedMany`,
        { names: names(outcome.skippedInvites) }
      )
    );
  }
  return {
    text: sentences.join(" "),
    tone:
      kind === "allDone" && outcome.refusedInvites.length === 0 && undelivered.length === 0
        ? "info"
        : "error",
  };
}

type RemovalSubject =
  | { kind: "person"; member: SpaceMemberEntry }
  | { kind: "group"; team: { id: string; name: string; memberCount: number | null } };

// Everyone with access to a teamspace, in one table: people added directly, people who come
// through a group, invitations still waiting, and the groups themselves. Rendered inside
// SpaceSettingsDialog's Members tab. Admins of the teamspace also add people here.
export default function SpaceMembersPanel({
  space,
  onLeft,
}: SpaceMembersPanelProps): ReactElement | null {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const attemptRunning = useRef(false);
  const { workspace, roster, rosterLoaded, refreshMembers } = useWorkspaceStore(
    useShallow((s) => ({
      workspace: s.workspaces.find((w) => w.id === space.workspace_id),
      roster: rosterFor(s, space.workspace_id),
      rosterLoaded: s.membersWorkspaceId === space.workspace_id,
      refreshMembers: s.refreshMembers,
    }))
  );
  const spaceId = space.cloud_space_id;
  const workspaceId = space.workspace_id;

  const canManage = spaceCan(space, "manage_members") || workspaceCan(workspace, "manage_settings");
  // Workspace invitations are refused without manage_members.
  const canInvite = workspaceCan(workspace, "manage_members");

  const [picked, setPicked] = useState<PickedRecipient[]>([]);
  const [adding, setAdding] = useState(false);
  // What the last attempt said, until the selection it was about changes.
  const [attempt, setAttempt] = useState<StatusLine | null>(null);
  const [needsRetry, setNeedsRetry] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  // Where focus goes once an attempt hands the field back: a disabled control drops it. The
  // field takes it back through a counter, the button when something is left to try again.
  const [fieldFocusRequest, setFieldFocusRequest] = useState(0);
  const [refocusButton, setRefocusButton] = useState(false);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [removal, dispatchRemoval] = useReducer(confirmActionReducer<RemovalSubject>, {
    kind: "closed",
  });
  // The user's own row, while they confirm giving up admin.
  const [steppingDown, setSteppingDown] = useState<SpaceMemberRow | null>(null);

  const loadMembers = useCallback(
    () => (spaceId ? SpacesService.listMembers(spaceId) : Promise.resolve<SpaceMemberEntry[]>([])),
    [spaceId]
  );
  const { members, loading, loadFailed, reload: reloadMembers } = useMemberRoster(loadMembers);

  // The first read has nothing to show yet, and the hook only says it is loading once its effect
  // has run, so "loading" also covers the commit before that.
  const wasLoading = useRef(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  useEffect(() => {
    if (loading) wasLoading.current = true;
    else if (wasLoading.current) setLoadedOnce(true);
  }, [loading]);
  const membersStatus: SpaceMembersStatus =
    members.length > 0
      ? "ready"
      : loadFailed
        ? "failed"
        : loading || !loadedOnce
          ? "loading"
          : "ready";

  // Invitations are only listed to those who manage the teamspace; a failed read hides them and
  // says nothing, since the members are what this tab is for.
  const loadInvitations = useCallback(() => SpacesService.listInvitations(spaceId), [spaceId]);
  const invitationsLoad = useLoad(canManage && spaceId ? loadInvitations : null, NO_INVITATIONS);
  // An answer that failed shows nothing rather than a list that may be out of date.
  const invitations =
    canManage && invitationsLoad.status === "ready" ? invitationsLoad.data : NO_INVITATIONS;
  const reloadInvitations = invitationsLoad.reload;

  const loadTeams = useCallback(() => TeamsService.list(workspaceId), [workspaceId]);
  const teamsLoad = useLoad(workspaceId ? loadTeams : null, NO_TEAMS);
  const workspaceTeams = teamsLoad.data;

  const loadRoster = useCallback(() => refreshMembers(workspaceId), [refreshMembers, workspaceId]);
  const rosterLoad = useLoad(canManage && workspaceId ? loadRoster : null, undefined);
  const reloadRoster = rosterLoad.reload;

  // A read overtaken by another workspace's resolves without filling the store for this one.
  const rosterFailed =
    rosterLoad.status === "failed" || (rosterLoad.status === "ready" && !rosterLoaded);
  const teamsFailed = teamsLoad.status === "failed";
  const peopleFailed = rosterFailed || teamsFailed;
  const peopleReady = rosterLoad.status === "ready" && rosterLoaded && teamsLoad.status === "ready";

  const retryPeople = (): void => {
    if (rosterFailed) void reloadRoster();
    if (teamsFailed) void teamsLoad.reload();
  };

  const isWorkspaceAdmin = workspaceCan(workspace, "manage_settings");
  const admins = members.filter((member) => member.role === "admin");
  // Leave blocks this user until there is another admin, and nobody here can be made one.
  const nobodyToPromote =
    !isWorkspaceAdmin &&
    admins.length === 1 &&
    admins[0].user_id === user?.id &&
    admins[0].direct_role === "admin" &&
    members.every((member) => member.user_id === user?.id || member.direct_role == null);

  const rows = useMemo(
    () =>
      buildSpaceMemberRows({
        members,
        invitations,
        teams: space.teams,
        teamCounts: new Map(
          workspaceTeams
            .filter((team) => team.member_count != null)
            .map((team): [string, number] => [team.id, team.member_count])
        ),
        canManage,
        promoteInherited: nobodyToPromote,
        formatNames: (names) => formatList(i18n.language, names),
      }),
    [members, invitations, space.teams, workspaceTeams, canManage, nobodyToPromote, i18n.language]
  );
  const groupEmoji = useMemo(
    () =>
      new Map(workspaceTeams.map((team): [string, string | null] => [team.id, team.emoji ?? null])),
    [workspaceTeams]
  );

  const accessUserIds = useMemo(() => new Set(members.map((member) => member.user_id)), [members]);
  const accessGroupIds = useMemo(() => new Set(space.teams.map((team) => team.id)), [space.teams]);
  // Lowercased, as the field compares: an address waiting for an answer is shown as pending in
  // its list rather than offered a second time.
  const pendingEmails = useMemo(
    () => new Set(invitations.map((invitation) => invitation.email.toLowerCase())),
    [invitations]
  );

  const summary = useMemo(() => pickedSummary(picked), [picked]);
  const spaceName = isolate(space.name);
  const workspaceName = workspace?.name ?? "";

  // Why this user can't manage the teamspace any more, which trying again won't change.
  const accessEndLine = (ended: "notAllowed" | "ssoRequired"): string =>
    ended === "notAllowed"
      ? t(`${COPY}.notAllowed`, { space: spaceName })
      : t("workspaces.ssoRequired", { workspace: isolate(workspaceName) });

  // The panel can do nothing for a teamspace that is gone, so it says so and goes with it. A toast
  // outlives the dialog this sits in. Not found proves less than deleted: the caller may simply
  // have been removed from the workspace.
  const closeLostTeamspace = (ended: "deleted" | "gone"): void => {
    toast({
      title:
        ended === "deleted"
          ? t("settingsPage.workspace.teamspaces.exit.deleted", { space: spaceName })
          : t("notes.spaces.accessRevoked", { space: spaceName }),
      variant: "destructive",
    });
    requestSpacesResync();
    onLeft?.();
  };

  useEffect(() => {
    if (!refocusButton || adding) return;
    addButtonRef.current?.focus();
    setRefocusButton(false);
  }, [refocusButton, adding]);

  const handlePickedChange = (next: PickedRecipient[]): void => {
    setPicked(next);
    // What the last attempt said was about the selection before this one.
    setAttempt(null);
    setNeedsRetry(false);
  };

  const describeProgress = (recipients: PickedRecipient[]): string => {
    const who = recipients.filter((recipient) => recipient.kind !== "email");
    const invitationCount = recipients.filter(isInvitable).length;
    const names = formatList(
      i18n.language,
      who.map((recipient) => isolate(recipientLabel(recipient)))
    );
    if (who.length > 0 && invitationCount > 0) {
      return t(`${COPY}.progressBoth`, { names, count: invitationCount });
    }
    if (invitationCount > 0) return t(`${COPY}.progressInvites`, { count: invitationCount });
    return t(`${COPY}.progressPeople`, { names });
  };

  // The roster is read again after an answer showed it out of date. An address the server calls a
  // member's becomes that member in the selection, so Try again adds the person it meant.
  const refreshRoster = async (knownAddresses: string[]): Promise<void> => {
    await reloadRoster();
    if (knownAddresses.length === 0) return;
    const fresh = rosterFor(useWorkspaceStore.getState(), workspaceId);
    const byAddress = new Map(
      fresh.filter((member) => member.email).map((member) => [member.email.toLowerCase(), member])
    );
    setPicked((current) =>
      addRecipients(
        [],
        current.map((recipient) => {
          if (recipient.kind !== "email") return recipient;
          const address = recipient.email.toLowerCase();
          const member = knownAddresses.includes(address) ? byAddress.get(address) : undefined;
          return member ? memberRecipient(member) : recipient;
        })
      )
    );
  };

  const handleAdd = async (): Promise<void> => {
    if (attemptRunning.current || !spaceId || picked.length === 0 || summary.hasInvalid) return;
    attemptRunning.current = true;
    const staged = picked;
    setAdding(true);
    setAttempt(null);
    setProgress(describeProgress(staged));
    try {
      const ran = await runAddAttempt({ space, cloudSpaceId: spaceId, picked: staged });
      if (ran.ended === "deleted" || ran.ended === "gone") {
        closeLostTeamspace(ran.ended);
        return;
      }
      const invitationsRead = reloadInvitations();
      let outcome = ran.outcome;
      if (outcome.skippedInvites.length > 0) {
        // An address that answers "already invited" may be one an earlier try of this Add invited
        // for this teamspace before its answer was lost; the teamspace's own list says which.
        const listed = await invitationsRead;
        if (listed) {
          outcome = settleListedInvites(
            outcome,
            new Set(listed.map((invitation) => invitation.email.toLowerCase()))
          );
        }
      }
      const remaining = remainingAfter(staged, outcome);
      const said = describeAttempt(t, i18n.language, outcome, workspaceName);
      setPicked(remaining);
      setAttempt(
        ran.ended
          ? {
              text: [said.text, accessEndLine(ran.ended)].filter(Boolean).join(" "),
              tone: "error",
            }
          : said
      );
      setNeedsRetry(canRetry(outcome));
      if (remaining.length === 0) setFieldFocusRequest((count) => count + 1);
      else setRefocusButton(true);

      void reloadMembers();
      if (ran.rosterStale) void refreshRoster(ran.knownAddresses);
    } finally {
      attemptRunning.current = false;
      setProgress(null);
      setAdding(false);
    }
  };

  const reportFailure = (error: unknown): void => {
    if (classifySpaceError(error).kind === "lastAdmin") {
      toast({
        title: t("settingsPage.workspace.teamspaces.exit.blockedBody", { space: spaceName }),
        variant: "destructive",
      });
      return;
    }
    toast({
      title: t("common.error"),
      description: error instanceof Error ? error.message : t("common.unknownError"),
      variant: "destructive",
    });
  };

  const runPending = async (id: string, action: () => Promise<void>): Promise<void> => {
    setPendingIds((current) => new Set(current).add(id));
    try {
      await action();
    } catch (error) {
      reportFailure(error);
    } finally {
      setPendingIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  const changePersonRole = (row: SpaceMemberRow, role: TeamRole): void => {
    if (row.kind !== "person" && row.kind !== "inherited") return;
    void runPending(row.id, async () => {
      await setSpaceMemberRole(space, row.member.user_id, role);
      toast({ title: t("notes.spaces.members.roleUpdated") });
      await reloadMembers();
    });
  };

  const handleRoleChange = (row: SpaceMemberRow, role: TeamRole): void => {
    if (row.kind === "person") {
      // Whoever steps down can't take it back, since managing roles is what they give up. A
      // workspace admin stays an admin here whatever this row says.
      if (
        role === "member" &&
        row.member.user_id === user?.id &&
        row.member.direct_role === "admin" &&
        !isWorkspaceAdmin
      ) {
        setSteppingDown(row);
        return;
      }
      changePersonRole(row, role);
    } else if (row.kind === "inherited") {
      if (row.promotable) changePersonRole(row, role);
    } else if (row.kind === "group") {
      // Downgrading the only group that makes someone an admin is allowed here, as unassigning
      // it is: any workspace admin can reverse it, and it never touches note access.
      void runPending(row.id, async () => {
        await setSpaceTeamAccess(space, row.team.id, role);
        toast({
          title: t("notes.spaces.teamsMembers.accessChanged", { team: isolate(row.team.name) }),
        });
        await reloadMembers();
      });
    }
  };

  const handleRemove = (row: SpaceMemberRow): void => {
    if (row.kind === "person") {
      dispatchRemoval({ type: "open", subject: { kind: "person", member: row.member } });
    } else if (row.kind === "group") {
      dispatchRemoval({ type: "open", subject: { kind: "group", team: row.team } });
    }
  };

  const runRemoval = async (subject: RemovalSubject): Promise<void> => {
    dispatchRemoval({ type: "confirm" });
    let title: string;
    let left = false;
    try {
      if (subject.kind === "person") {
        const name = isolate(subject.member.name || subject.member.email);
        const groupsOf = (teams: { name: string }[]): string =>
          formatList(
            i18n.language,
            teams.map((team) => isolate(team.name))
          );
        // A workspace admin keeps implicit access to every teamspace, so removing their own direct
        // row leaves nothing: it is a plain removal, with nothing to purge and no panel to close.
        if (user?.id && subject.member.user_id === user.id && !isWorkspaceAdmin) {
          // Dropping your own grant can revoke access to what the device holds, which Leave's sync
          // purges; a removal of someone else's has nothing of the kind to do.
          const { still_via_teams } = await leaveSpace(space, user.id);
          left = still_via_teams.length === 0;
          title = left
            ? t("settingsPage.workspace.teamspaces.exit.left", { space: spaceName })
            : t("notes.spaces.stillViaGroups", {
                space: spaceName,
                groups: groupsOf(still_via_teams),
              });
        } else {
          const { still_via_teams } = await removeSpaceMember(space, subject.member.user_id);
          // Access through a group stays; the toast says so rather than claiming they are gone.
          title =
            still_via_teams.length > 0
              ? t("notes.spaces.members.stillViaGroups", {
                  name,
                  groups: groupsOf(still_via_teams),
                })
              : t(`${COPY}.removed`, { name, space: spaceName });
        }
      } else {
        await unassignTeamFromSpace(space, subject.team.id);
        title = t("notes.spaces.teamsMembers.teamRemoved", {
          team: isolate(subject.team.name),
          space: spaceName,
        });
      }
    } catch (error) {
      const failure = classifySpaceError(error);
      if (failure.kind === "gone") {
        // Already out, so there is nothing to say; the list just needs to catch up.
        dispatchRemoval({ type: "succeeded" });
        void reloadMembers();
        return;
      }
      if (failure.kind === "archived") {
        dispatchRemoval({ type: "succeeded" });
        closeLostTeamspace("deleted");
        return;
      }
      dispatchRemoval({
        type: "failed",
        error:
          failure.kind === "lastAdmin"
            ? {
                kind: "refused",
                message: t("settingsPage.workspace.teamspaces.exit.blockedBody", {
                  space: spaceName,
                }),
              }
            : rowActionErrorOf(failure),
      });
      return;
    }
    toast({ title });
    dispatchRemoval({ type: "succeeded" });
    void reloadMembers();
    if (left) onLeft?.();
  };

  if (!spaceId) return null;

  // What is staged, said before it is added: who is invited, and what a group grants.
  const stagedSentences: string[] = [];
  if (summary.emails.length > 0) stagedSentences.push(t(`${COPY}.stagedNew`));
  const stagedGroups = picked.filter(isGroup);
  if (stagedGroups.length === 1) {
    stagedSentences.push(
      t(`${COPY}.stagedGroup`, { group: isolate(stagedGroups[0].label), space: spaceName })
    );
  } else if (stagedGroups.length > 1) {
    stagedSentences.push(t(`${COPY}.stagedGroups`, { space: spaceName }));
  }

  let line: StatusLine | null = null;
  if (adding) line = progress ? { text: progress, tone: "info" } : null;
  else if (summary.hasInvalid) line = { text: t(`${COPY}.invalid`), tone: "error" };
  else if (attempt && attempt.text !== "") line = attempt;
  else if (stagedSentences.length > 0) line = { text: stagedSentences.join(" "), tone: "info" };

  const tooManyInvites = summary.emails.length > MAX_INVITE_RECIPIENTS;
  if (!adding && !summary.hasInvalid && tooManyInvites) {
    line = {
      text: t("workspaces.invite.tooMany", { count: MAX_INVITE_RECIPIENTS }),
      tone: "error",
    };
  }

  const addLabel = adding
    ? t(`${COPY}.adding`)
    : needsRetry
      ? t(`${COPY}.retry`)
      : t(`${COPY}.add`);

  const addButton = (
    <Button
      ref={addButtonRef}
      type="button"
      onClick={() => void handleAdd()}
      disabled={
        adding || !peopleReady || picked.length === 0 || summary.hasInvalid || tooManyInvites
      }
      className="h-10 shrink-0 rounded-lg px-4"
    >
      {addLabel}
    </Button>
  );

  const confirmSubject = removal.kind === "closed" ? null : removal.subject;
  const removalFailed = removal.kind === "failed";
  // No connection to check and nothing to try again: this user can't do this any more.
  const removalEnded =
    removal.kind === "failed" &&
    (removal.error.kind === "notAllowed" || removal.error.kind === "ssoRequired")
      ? removal.error.kind
      : null;
  const subjectName =
    confirmSubject?.kind === "person"
      ? isolate(confirmSubject.member.name || confirmSubject.member.email)
      : confirmSubject
        ? isolate(confirmSubject.team.name)
        : "";

  return (
    <div className="space-y-3">
      {canManage && (
        <div className="space-y-2">
          {peopleReady ? (
            <SpacePeopleField
              roster={roster}
              groups={workspaceTeams}
              accessUserIds={accessUserIds}
              accessGroupIds={accessGroupIds}
              pendingEmails={pendingEmails}
              canInvite={canInvite}
              inviteRoleChoice={canInvite}
              picked={picked}
              onChange={handlePickedChange}
              disabled={adding}
              placeholder={t("settingsPage.workspace.teamspaces.form.peoplePlaceholder")}
              action={addButton}
              focusRequest={fieldFocusRequest}
            />
          ) : (
            // Nothing to pick from yet, so the button waits beside a stand-in for the field.
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                {peopleFailed ? (
                  <div className="flex h-10 items-center justify-between gap-2 rounded border border-border/70 px-3 dark:border-border-subtle/60">
                    <p className="truncate text-xs text-muted-foreground">
                      {rosterFailed
                        ? t("settingsPage.workspace.members.loadError")
                        : t("notes.spaces.teams.loadError")}
                    </p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={retryPeople}
                      className="h-6 shrink-0 px-2 text-xs"
                    >
                      {t("settingsPage.workspace.loadError.retry")}
                    </Button>
                  </div>
                ) : (
                  <div
                    aria-hidden="true"
                    className="h-10 animate-pulse rounded-lg bg-foreground/5 dark:bg-white/5"
                  />
                )}
              </div>
              {addButton}
            </div>
          )}
          {line && (
            <p
              role={line.tone === "error" ? "alert" : "status"}
              className={cn(
                "text-[11px] leading-snug",
                line.tone === "error" ? "text-destructive" : "text-muted-foreground"
              )}
            >
              {line.text}
            </p>
          )}
        </div>
      )}

      <SpaceMembersTable
        status={membersStatus}
        rows={rows}
        groupEmoji={groupEmoji}
        label={t("notes.spaces.teamsMembers.title", { space: spaceName })}
        canManage={canManage}
        pendingIds={pendingIds}
        onRetry={() => void reloadMembers()}
        onRoleChange={handleRoleChange}
        onRemove={handleRemove}
      />

      {steppingDown && (
        <WorkspaceActionDialog
          open
          icon="info"
          title={t(`${COPY}.stepDownTitle`, { space: spaceName })}
          body={t(`${COPY}.stepDownBody`)}
          primary={{
            label: t(`${COPY}.stepDownConfirm`),
            onClick: () => {
              changePersonRole(steppingDown, "member");
              setSteppingDown(null);
            },
            tone: "destructive",
          }}
          cancelLabel={t("common.cancel")}
          onDismiss={() => setSteppingDown(null)}
        />
      )}

      {confirmSubject && (
        <WorkspaceActionDialog
          open
          icon="info"
          title={
            removalFailed
              ? t(`${COPY}.removeFailedTitle`, { name: subjectName })
              : confirmSubject.kind === "person"
                ? t(`${COPY}.removeTitle`, { name: subjectName, space: spaceName })
                : t(`${COPY}.removeGroupTitle`, { group: subjectName, space: spaceName })
          }
          body={
            removalEnded
              ? accessEndLine(removalEnded)
              : removalFailed
                ? t(`${COPY}.removeFailedBody`, { name: subjectName, space: spaceName })
                : confirmSubject.kind === "person"
                  ? t(
                      confirmSubject.member.via_teams.length > 0
                        ? `${COPY}.removeBody`
                        : `${COPY}.removeBodyPlain`,
                      { name: subjectName }
                    )
                  : confirmSubject.team.memberCount != null
                    ? t(`${COPY}.removeGroupBody`, { count: confirmSubject.team.memberCount })
                    : t(`${COPY}.removeGroupBodyNoCount`)
          }
          error={
            removal.kind === "failed" && removal.error.kind === "refused"
              ? removal.error.message
              : null
          }
          primary={
            removalEnded
              ? {
                  label: t("common.close"),
                  onClick: () => dispatchRemoval({ type: "dismiss" }),
                  tone: "primary",
                }
              : {
                  label: removalFailed
                    ? t(`${COPY}.retry`)
                    : confirmSubject.kind === "person"
                      ? t(`${COPY}.removeConfirm`)
                      : t(`${COPY}.removeItem`),
                  onClick: () => void runRemoval(confirmSubject),
                  tone: removalFailed ? "primary" : "destructive",
                  pending: removal.kind === "running",
                }
          }
          cancelLabel={removalEnded ? undefined : t("common.cancel")}
          busy={removal.kind === "running"}
          onDismiss={() => dispatchRemoval({ type: "dismiss" })}
        />
      )}
    </div>
  );
}
