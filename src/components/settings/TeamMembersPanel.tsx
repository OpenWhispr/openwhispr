import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { TFunction } from "i18next";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { EnvelopePlus } from "../icons";
import { cn } from "../lib/utils";
import MemberAvatar from "../MemberAvatar";
import { Button } from "../ui/button";
import { useToast } from "../ui/useToast";
import { SpacePeopleField } from "../notes/SpacePeopleField";
import { SpaceRoleMenu, type SpaceRoleMenuCopy } from "../notes/SpaceRoleMenu";
import { WorkspaceActionDialog } from "../workspace/WorkspaceActionDialog";
import { ROW_BUTTON_CLASS } from "../workspace/dialogButtons";
import { HEADER_CELL, ROW_DIVIDER, TABLE_FRAME } from "./tableTokens";
import { useAuth } from "../../hooks/useAuth";
import { useLoad } from "../../hooks/useLoad";
import { useMemberRoster } from "../../hooks/useMemberRoster";
import { teamCan, workspaceCan } from "../../lib/capabilities";
import { confirmActionReducer } from "../../lib/confirmActionFlow";
import { formatList } from "../../lib/formatList";
import { rosterFor } from "../../lib/peopleRoster";
import {
  canRetry,
  remainingAfter,
  seatRoomLeft,
  settleListedInvites,
  type AddAttemptOutcome,
  type InviteRefusal,
} from "../../lib/addSpaceMembersFlow";
import { MAX_INVITE_RECIPIENTS } from "../../lib/inviteFlow";
import {
  addRecipients,
  memberRecipient,
  pickedSummary,
  type PickedRecipient,
} from "../../lib/spacePeoplePicker";
import {
  classifyRowActionError,
  classifyTeamError,
  rowActionErrorOf,
  type TeamActionError,
} from "../../lib/workspaceErrors";
import { InvitationsService } from "../../services/InvitationsService";
import { invitePeople } from "../../services/invitePeople";
import { addPeopleToTeam, removeTeamMember, setTeamMemberRole } from "../../services/spaceActions";
import { TeamsService } from "../../services/TeamsService";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { Team, TeamInvitation, TeamMember, TeamRole, Workspace } from "../../types/electron";
import { isolate } from "../../utils/bidiIsolate";

const COPY = "settingsPage.workspace.teams";
const MEMBERS = `${COPY}.members`;
const NO_INVITATIONS: TeamInvitation[] = [];

const ROLE_MENU_COPY: SpaceRoleMenuCopy = {
  roleMember: `${MEMBERS}.roleMember`,
  roleMemberBody: `${MEMBERS}.roleMemberBody`,
  roleAdmin: `${MEMBERS}.roleAdmin`,
  roleAdminBody: `${MEMBERS}.roleAdminBody`,
  remove: `${MEMBERS}.remove`,
};

const COLUMN_DIVIDER = "border-s border-border/60 dark:border-border-subtle/50";
// Seven rows fit with the header; a longer list scrolls inside the table, and on a short window
// the cap shrinks so the dialog around it never has to scroll as a whole.
const ROWS_SCROLLER = "max-h-[clamp(9rem,calc(85vh-25rem),22rem)] overflow-y-auto";
const PILL = "bg-primary/10 text-primary hover:bg-primary/15";

type EmailRecipient = Extract<PickedRecipient, { kind: "email" }>;

const isMember = (
  recipient: PickedRecipient
): recipient is Extract<PickedRecipient, { kind: "member" }> => recipient.kind === "member";
// An invalid address never goes out as one to invite; the field blocks Add members until it is fixed.
const isInvitable = (recipient: PickedRecipient): recipient is EmailRecipient =>
  recipient.kind === "email" && recipient.valid;

const recipientLabel = (recipient: PickedRecipient): string =>
  recipient.kind === "email" ? recipient.email : recipient.label;

function emptyOutcome(): AddAttemptOutcome {
  return {
    addedMembers: [],
    failedMembers: [],
    addedTeams: [],
    failedTeams: [],
    invited: [],
    undeliveredInvites: [],
    pendingInvites: [],
    failedInvites: [],
    refusedInvites: [],
    skippedInvites: [],
    leftMembers: [],
  };
}

/** A write the team itself refused, which no retry changes. */
type TeamAccessEnd = "gone" | "notAllowed" | "ssoRequired";

function teamAccessEnd(failure: TeamActionError): TeamAccessEnd | null {
  return failure.kind === "gone" || failure.kind === "notAllowed" || failure.kind === "ssoRequired"
    ? failure.kind
    : null;
}

// One Add members attempt: the people in one batch, then the addresses once for each role, each
// carrying this team so accepting adds them to it. Nothing here throws; whatever didn't go is
// reported as failed so it stays staged.
async function runAddAttempt(input: { team: Team; picked: PickedRecipient[] }): Promise<{
  outcome: AddAttemptOutcome;
  rosterStale: boolean;
  knownAddresses: string[];
  ended: TeamAccessEnd | null;
}> {
  const { team, picked } = input;
  const outcome = emptyOutcome();
  let rosterStale = false;
  // Addresses the server says belong to a workspace member, which the roster should now resolve.
  const knownAddresses: string[] = [];

  const people = picked.filter(isMember);
  if (people.length > 0) {
    try {
      // People who are in already come back as already_members: nothing left to do for them.
      const result = await addPeopleToTeam(
        team.id,
        people.map((recipient) => recipient.userId)
      );
      const already = new Set(result.already_members);
      outcome.addedMembers = people.filter((recipient) => !already.has(recipient.userId));
      outcome.alreadyMembers = people.filter((recipient) => already.has(recipient.userId));
    } catch (error) {
      const failure = classifyTeamError(error);
      const ended = teamAccessEnd(failure);
      // Nothing else can go either, and nothing is held for a retry that can't work.
      if (ended) return { outcome: emptyOutcome(), rosterStale, knownAddresses, ended };
      const gone =
        failure.kind === "notWorkspaceMembers" ? new Set(failure.userIds) : new Set<string>();
      // One person who left must not hold everyone else back, nor be sent again and refused again.
      outcome.leftMembers = people.filter((recipient) => gone.has(recipient.userId));
      outcome.failedMembers = people.filter((recipient) => !gone.has(recipient.userId));
      if (outcome.leftMembers.length > 0) rosterStale = true;
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
        workspaceId: team.workspace_id,
        emails: batch.map((recipient) => recipient.email),
        role,
        teamIds: [team.id],
        onResult: (email, result) => {
          const key = email.toLowerCase();
          const recipient = byAddress.get(key);
          if (!recipient) return;
          reported.add(key);
          // `=== true`: src compiles without strictNullChecks, where a bare `ok` doesn't narrow.
          if (result.ok === true || result.grantsAdded === true) {
            outcome.invited.push(recipient);
            if (result.ok === true && !result.emailSent) outcome.undeliveredInvites.push(recipient);
            if (result.ok !== true) outcome.pendingInvites.push(recipient);
          }
          // An older API attaches no team to an invitation that already exists, so this address
          // isn't in the team, and sending it again wouldn't change that.
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

// What an attempt says: who went, then what didn't. A clean run is only a toast.
function describeAttempt(
  t: TFunction,
  language: string,
  outcome: AddAttemptOutcome,
  workspaceName: string,
  teamName: string
): StatusLine {
  const names = (recipients: PickedRecipient[]): string =>
    formatList(
      language,
      recipients.map((recipient) => isolate(recipientLabel(recipient)))
    );
  const sentences: string[] = [];
  const { addedMembers: added } = outcome;
  // Their invitation is there, but nobody told them: Resend is how it goes out again.
  const undelivered = outcome.undeliveredInvites;
  const invited = outcome.invited.filter((recipient) => !undelivered.includes(recipient));
  if (added.length > 0 && invited.length > 0) {
    sentences.push(
      t(`${MEMBERS}.addedAndInvited`, { names: names(added), invited: names(invited) })
    );
  } else if (added.length > 0) {
    sentences.push(t(`${MEMBERS}.added`, { names: names(added) }));
  } else if (invited.length > 0) {
    sentences.push(t(`${MEMBERS}.invited`, { invited: names(invited) }));
  } else if ((outcome.alreadyMembers ?? []).length > 0) {
    // The roster was a step behind: nobody new went in, and saying "Added" would be false.
    sentences.push(t(`${COPY}.addPeople.allAlready`, { team: teamName }));
  }

  if (undelivered.length > 0) {
    sentences.push(t(`${MEMBERS}.invitedNoEmail`, { invited: names(undelivered) }));
  }

  const failed = [...outcome.failedMembers, ...outcome.failedInvites];
  if (failed.length > 0) sentences.push(t(`${MEMBERS}.addFailed`));

  // What the invite dialog says about each kind. Some of its lines name nobody, and a refused
  // address leaves the field, so they are followed by who wasn't invited.
  const refusalSentences = (refusals: InviteRefusal[]): string[] => {
    const { failure } = refusals[0];
    const recipients = refusals.map(({ recipient }) => recipient);
    const notInvited = t(
      recipients.length === 1
        ? "settingsPage.workspace.teamspaces.members.notInvited"
        : "settingsPage.workspace.teamspaces.members.notInvitedMany",
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

  // A batch's refusal answers for every address in it, so each reason is said once.
  const byReason = new Map<string, InviteRefusal[]>();
  for (const refusal of outcome.refusedInvites) {
    const { failure } = refusal;
    const reason = failure.kind === "refused" ? `refused:${failure.message}` : failure.kind;
    byReason.set(reason, [...(byReason.get(reason) ?? []), refusal]);
  }
  for (const refusals of byReason.values()) sentences.push(...refusalSentences(refusals));

  if (outcome.leftMembers.length > 0) {
    sentences.push(
      t("settingsPage.workspace.teamspaces.members.partialLeft", {
        names: names(outcome.leftMembers),
      })
    );
  }
  // An older API leaves an existing invitation without this team, and sending it again changes
  // nothing, so it is said once and not kept staged.
  if (outcome.skippedInvites.length > 0) {
    sentences.push(
      t(`${MEMBERS}.skippedInvited`, {
        names: names(outcome.skippedInvites),
        team: teamName,
      })
    );
  }
  const clean =
    failed.length === 0 &&
    undelivered.length === 0 &&
    outcome.skippedInvites.length === 0 &&
    outcome.refusedInvites.length === 0 &&
    outcome.leftMembers.length === 0;
  return { text: sentences.join(" "), tone: clean ? "info" : "error" };
}

interface TeamMembersPanelProps {
  team: Team;
  workspace: Workspace;
  /** A directory-managed team reads as a list, whatever the viewer holds. */
  managed: boolean;
  /** A write changed who is in the team or what the viewer may do here. */
  onChanged: () => void;
  /** The viewer is no longer in the team, or it is gone: whatever hosts this can close. */
  onGone: () => void;
}

// Who is in a team, and the people it is waiting on. Members the viewer manages are added here by
// name or address (an address gets a workspace invitation that joins the team on accepting), given
// a role, or removed; invitations still waiting are listed under the table.
export default function TeamMembersPanel({
  team,
  workspace,
  managed,
  onChanged,
  onGone,
}: TeamMembersPanelProps): ReactElement {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const userId = user?.id;
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const attemptRunning = useRef(false);
  // An answer that lands after the dialog moved on to another team must not act for this one.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { roster, rosterLoaded, refreshMembers } = useWorkspaceStore(
    useShallow((s) => ({
      roster: rosterFor(s, workspace.id),
      rosterLoaded: s.membersWorkspaceId === workspace.id,
      refreshMembers: s.refreshMembers,
    }))
  );

  const canManage = !managed && teamCan(team, workspace, "manage_members");
  // Workspace invitations, and sending them again, are refused without manage_members.
  const canInvite = workspaceCan(workspace, "manage_members");
  const teamName = isolate(team.name);

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
  const [rolePendingIds, setRolePendingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [resendingIds, setResendingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [removal, dispatchRemoval] = useReducer(confirmActionReducer<TeamMember>, {
    kind: "closed",
  });

  const loadMembers = useCallback(() => TeamsService.listMembers(team.id), [team.id]);
  const {
    members,
    loading,
    loadFailed,
    loadError,
    reload: reloadMembers,
  } = useMemberRoster(loadMembers);

  // The first read has nothing to show yet, and the hook only says it is loading once its effect
  // has run, so "loading" also covers the commit before that.
  const wasLoading = useRef(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  useEffect(() => {
    if (loading) wasLoading.current = true;
    else if (wasLoading.current) setLoadedOnce(true);
  }, [loading]);
  const membersStatus: MembersStatus =
    members.length > 0
      ? "ready"
      : loadFailed
        ? "failed"
        : loading || !loadedOnce
          ? "loading"
          : "ready";

  // Invitations are only listed to those who manage the team; a failed read (an API without the
  // route) hides them and says nothing, since the members are what this tab is for.
  const loadInvitations = useCallback(() => TeamsService.listInvitations(team.id), [team.id]);
  const invitationsLoad = useLoad(canManage ? loadInvitations : null, NO_INVITATIONS);
  const invitations =
    canManage && invitationsLoad.status === "ready" ? invitationsLoad.data : NO_INVITATIONS;
  const reloadInvitations = invitationsLoad.reload;

  const loadRoster = useCallback(
    () => refreshMembers(workspace.id),
    [refreshMembers, workspace.id]
  );
  const rosterLoad = useLoad(canManage ? loadRoster : null, undefined);
  const reloadRoster = rosterLoad.reload;
  // A read overtaken by another workspace's resolves without filling the store for this one.
  const rosterFailed =
    rosterLoad.status === "failed" || (rosterLoad.status === "ready" && !rosterLoaded);
  const peopleReady = rosterLoad.status === "ready" && rosterLoaded;

  const accessUserIds = useMemo(() => new Set(members.map((member) => member.user_id)), [members]);
  // Lowercased, as the field compares: an address waiting for an answer is shown as pending in
  // its list rather than offered a second time.
  const pendingEmails = useMemo(
    () => new Set(invitations.map((invitation) => invitation.email.toLowerCase())),
    [invitations]
  );
  const summary = useMemo(() => pickedSummary(picked), [picked]);

  useEffect(() => {
    if (!refocusButton || adding) return;
    addButtonRef.current?.focus();
    setRefocusButton(false);
  }, [refocusButton, adding]);

  // The panel can do nothing for a team the viewer is out of, so it says so and goes with it. A
  // toast outlives the dialog this sits in.
  const closeLostTeam = (ended: "gone" | "notAllowed"): void => {
    if (!mounted.current) return;
    toast({
      title: t(ended === "gone" ? `${MEMBERS}.gone` : `${MEMBERS}.notAllowed`, { team: teamName }),
      variant: "destructive",
    });
    onGone();
  };

  // A team deleted since the list was read can't be read again: say so rather than offer a Retry
  // that always fails.
  useEffect(() => {
    if (loadError && classifyTeamError(loadError).kind === "gone") closeLostTeam("gone");
    // Only a new failure matters; closeLostTeam reads the team as it is then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadError]);

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
      return t(`${MEMBERS}.addingStatus`, { names, count: invitationCount });
    }
    if (invitationCount > 0) return t(`${MEMBERS}.invitingOnly`, { count: invitationCount });
    return t(`${MEMBERS}.addingOnly`, { names });
  };

  // The roster is read again after an answer showed it out of date. An address the server calls a
  // member's becomes that member in the selection, so Try again adds the person it meant.
  const refreshRoster = async (knownAddresses: string[]): Promise<void> => {
    await reloadRoster();
    if (knownAddresses.length === 0) return;
    const fresh = rosterFor(useWorkspaceStore.getState(), workspace.id);
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
    if (attemptRunning.current || picked.length === 0 || summary.hasInvalid) return;
    attemptRunning.current = true;
    const staged = picked;
    setAdding(true);
    setAttempt(null);
    setProgress(describeProgress(staged));
    try {
      const ran = await runAddAttempt({ team, picked: staged });
      if (ran.ended === "gone" || ran.ended === "notAllowed") {
        closeLostTeam(ran.ended);
        return;
      }
      if (ran.ended === "ssoRequired") {
        if (!mounted.current) return;
        setNeedsRetry(false);
        setRefocusButton(true);
        setAttempt({
          text: t("workspaces.ssoRequired", { workspace: isolate(workspace.name) }),
          tone: "error",
        });
        return;
      }
      const invitationsRead = reloadInvitations();
      let outcome = ran.outcome;
      if (outcome.skippedInvites.length > 0) {
        // An address that answers "already invited" may be one an earlier try of this Add invited
        // for this team before its answer was lost; the team's own list says which.
        const listed = await invitationsRead;
        if (listed) {
          outcome = settleListedInvites(
            outcome,
            new Set(listed.map((invitation) => invitation.email.toLowerCase()))
          );
        }
      }
      const remaining = remainingAfter(staged, outcome);
      const said = describeAttempt(t, i18n.language, outcome, workspace.name, teamName);
      if (!mounted.current) {
        // Nothing is left to show it in, so the toast says what went and what didn't.
        toast({ title: said.text, variant: said.tone === "error" ? "destructive" : undefined });
        if (outcome.addedMembers.length + outcome.invited.length > 0) onChanged();
        return;
      }
      setPicked(remaining);
      setNeedsRetry(canRetry(outcome));
      if (said.tone === "info") {
        // Everything went: the table and the list show it, and the toast says who.
        toast({ title: said.text });
      } else {
        setAttempt(said);
      }
      if (remaining.length === 0) setFieldFocusRequest((count) => count + 1);
      else setRefocusButton(true);

      void reloadMembers();
      if (outcome.addedMembers.length + outcome.invited.length > 0) onChanged();
      if (ran.rosterStale) void refreshRoster(ran.knownAddresses);
    } finally {
      attemptRunning.current = false;
      if (mounted.current) {
        setProgress(null);
        setAdding(false);
      }
    }
  };

  const trackIn = async (
    setIds: typeof setRolePendingIds,
    id: string,
    action: () => Promise<void>
  ): Promise<void> => {
    setIds((current) => new Set(current).add(id));
    try {
      await action();
    } finally {
      if (mounted.current) {
        setIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    }
  };

  const changeRole = (member: TeamMember, role: TeamRole): void => {
    void trackIn(setRolePendingIds, member.user_id, async () => {
      try {
        await setTeamMemberRole(team.id, member.user_id, role);
      } catch (error) {
        const failure = classifyTeamError(error);
        if (failure.kind === "lastAdmin") {
          toast({
            title: t(`${COPY}.exit.blockedTitle`),
            variant: "destructive",
          });
        } else if (failure.kind === "gone" || failure.kind === "notAllowed") {
          closeLostTeam(failure.kind);
        } else if (failure.kind === "memberGone") {
          // Removed by someone else since the list was read: the list catches up.
          toast({
            title: t(`${MEMBERS}.memberGone`, {
              name: isolate(member.name || member.email),
              team: teamName,
            }),
            variant: "destructive",
          });
          onChanged();
          await reloadMembers();
        } else if (failure.kind === "ssoRequired") {
          toast({
            title: t("workspaces.ssoRequired", { workspace: isolate(workspace.name) }),
            variant: "destructive",
          });
        } else {
          toast({
            title: t(`${MEMBERS}.roleFailed`, { name: isolate(member.name || member.email) }),
            variant: "destructive",
          });
        }
        return;
      }
      onChanged();
      await reloadMembers();
    });
  };

  const runRemoval = async (member: TeamMember): Promise<void> => {
    dispatchRemoval({ type: "confirm" });
    try {
      await removeTeamMember(team.id, member.user_id);
    } catch (error) {
      const failure = classifyTeamError(error);
      // Removing someone who is already out succeeds, so the only 404 is for the team itself.
      if (failure.kind === "gone" || failure.kind === "notAllowed") {
        dispatchRemoval({ type: "succeeded" });
        closeLostTeam(failure.kind);
        return;
      }
      dispatchRemoval({ type: "failed", error: rowActionErrorOf(failure) });
      return;
    }
    toast({
      title: t(`${MEMBERS}.removed`, {
        name: isolate(member.name || member.email),
        team: teamName,
      }),
    });
    dispatchRemoval({ type: "succeeded" });
    onChanged();
    void reloadMembers();
  };

  const resend = (invitation: TeamInvitation): void => {
    if (resendingIds.has(invitation.id)) return;
    void trackIn(setResendingIds, invitation.id, async () => {
      const email = isolate(invitation.email);
      let sent = false;
      try {
        sent = (await InvitationsService.resend(workspace.id, invitation.id)).email_sent;
      } catch (error) {
        // Said below, as for an invitation whose email didn't go out. An invitation that is gone
        // (accepted or cancelled meanwhile) leaves a stale row, so the list is read again.
        if (classifyRowActionError(error).kind === "gone") void reloadInvitations();
      }
      toast(
        sent
          ? { title: t(`${MEMBERS}.resent`, { email }) }
          : { title: t(`${MEMBERS}.resendFailed`, { email }), variant: "destructive" }
      );
    });
  };

  let line: StatusLine | null = null;
  if (adding) line = progress ? { text: progress, tone: "info" } : null;
  else if (summary.hasInvalid) line = { text: t(`${COPY}.form.invalidEmail`), tone: "error" };
  else if (attempt && attempt.text !== "") line = attempt;

  const tooManyInvites = summary.emails.length > MAX_INVITE_RECIPIENTS;
  if (!adding && !summary.hasInvalid && tooManyInvites) {
    line = {
      text: t("workspaces.invite.tooMany", { count: MAX_INVITE_RECIPIENTS }),
      tone: "error",
    };
  }

  const addButton = (
    <Button
      ref={addButtonRef}
      type="button"
      onClick={() => void handleAdd()}
      disabled={
        adding || !peopleReady || picked.length === 0 || summary.hasInvalid || tooManyInvites
      }
      className="h-10 shrink-0 px-4 text-xs"
    >
      {adding ? t(`${MEMBERS}.adding`) : needsRetry ? t(`${COPY}.retry`) : t(`${MEMBERS}.add`)}
    </Button>
  );

  const removing = removal.kind === "closed" ? null : removal.subject;
  const removingName = removing ? isolate(removing.name || removing.email) : "";
  const removalFailed = removal.kind === "failed";

  return (
    <div className="space-y-3">
      {canManage && (
        <div className="space-y-2">
          {peopleReady ? (
            <SpacePeopleField
              roster={roster}
              teams={[]}
              accessUserIds={accessUserIds}
              pendingEmails={pendingEmails}
              canInvite={canInvite}
              inviteRoleChoice={canInvite}
              picked={picked}
              onChange={handlePickedChange}
              disabled={adding}
              placeholder={t(`${MEMBERS}.placeholder`)}
              action={addButton}
              focusRequest={fieldFocusRequest}
            />
          ) : (
            // Nothing to pick from yet, so the button waits beside a stand-in for the field.
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                {rosterFailed ? (
                  <div className="flex h-10 items-center justify-between gap-2 rounded border border-border/70 px-3 dark:border-border-subtle/60">
                    <p className="truncate text-xs text-muted-foreground">
                      {t("settingsPage.workspace.members.loadError")}
                    </p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void reloadRoster()}
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
          {!line && summary.emails.length > 0 && (
            // Below the chips, and gone once the line has something else to say.
            <p className="text-xs leading-snug text-muted-foreground">
              {t(`${MEMBERS}.inviteNote`)}
            </p>
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

      <MembersTable
        status={membersStatus}
        members={members}
        label={t(`${MEMBERS}.title`, { team: teamName })}
        canManage={canManage}
        currentUserId={userId}
        pendingIds={rolePendingIds}
        onRetry={() => void reloadMembers()}
        onRoleChange={changeRole}
        onRemove={(member) => dispatchRemoval({ type: "open", subject: member })}
      />

      {invitations.length > 0 && (
        <PendingInvitations
          invitations={invitations}
          canResend={canInvite}
          resendingIds={resendingIds}
          onResend={resend}
        />
      )}

      {removing && (
        <WorkspaceActionDialog
          open
          icon="info"
          title={
            removalFailed
              ? t(`${MEMBERS}.removeFailedTitle`, { name: removingName })
              : t(`${MEMBERS}.removeTitle`, { name: removingName, team: teamName })
          }
          body={
            removalFailed
              ? t(`${MEMBERS}.removeFailedBody`, { name: removingName, team: teamName })
              : t(`${MEMBERS}.removeBody`, { name: removingName })
          }
          error={
            removal.kind === "failed" && removal.error.kind === "refused"
              ? removal.error.message
              : removal.kind === "failed" && removal.error.kind === "ssoRequired"
                ? t("workspaces.ssoRequired", { workspace: isolate(workspace.name) })
                : null
          }
          primary={{
            label: removalFailed ? t(`${COPY}.retry`) : t(`${MEMBERS}.removeAction`),
            onClick: () => void runRemoval(removing),
            tone: removalFailed ? "primary" : "destructive",
            pending: removal.kind === "running",
          }}
          cancelLabel={t("common.cancel")}
          busy={removal.kind === "running"}
          onDismiss={() => dispatchRemoval({ type: "dismiss" })}
        />
      )}
    </div>
  );
}

type MembersStatus = "loading" | "failed" | "ready";

interface MembersTableProps {
  status: MembersStatus;
  members: TeamMember[];
  /** Names the table for screen readers, which can't see the dialog's heading from inside it. */
  label: string;
  canManage: boolean;
  currentUserId: string | undefined;
  /** Rows with a change in flight. */
  pendingIds: ReadonlySet<string>;
  onRetry: () => void;
  onRoleChange: (member: TeamMember, role: TeamRole) => void;
  onRemove: (member: TeamMember) => void;
}

function MembersTable({
  status,
  members,
  label,
  canManage,
  currentUserId,
  pendingIds,
  onRetry,
  onRoleChange,
  onRemove,
}: MembersTableProps): ReactElement {
  const { t } = useTranslation();

  return (
    <div className={cn(TABLE_FRAME, "overflow-hidden")}>
      {/* Focusable, so the keyboard can scroll it when no row holds a control (a plain member). */}
      <div
        tabIndex={0}
        role="region"
        aria-label={label}
        className={cn(
          ROWS_SCROLLER,
          "outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        )}
      >
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            <col className="w-[75%]" />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className={cn(HEADER_CELL, "ps-4 pe-3 text-start")}>
                {t(`${MEMBERS}.columnName`)}
              </th>
              <th scope="col" className={cn(HEADER_CELL, COLUMN_DIVIDER, "px-4 text-start")}>
                {t(`${MEMBERS}.columnRole`)}
              </th>
            </tr>
          </thead>
          <tbody>
            {status === "ready" && members.length > 0 ? (
              members.map((member) => (
                <MemberRow
                  key={member.user_id}
                  member={member}
                  canManage={canManage}
                  isSelf={member.user_id === currentUserId}
                  pending={pendingIds.has(member.user_id)}
                  onRoleChange={onRoleChange}
                  onRemove={onRemove}
                />
              ))
            ) : (
              <tr className={ROW_DIVIDER}>
                <td colSpan={2} className="px-4 py-8 text-center">
                  <TableMessage status={status} onRetry={onRetry} />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TableMessage({
  status,
  onRetry,
}: {
  status: MembersStatus;
  onRetry: () => void;
}): ReactElement {
  const { t } = useTranslation();

  if (status === "failed") {
    return (
      <div className="flex flex-col items-center gap-3">
        <p className="text-xs text-muted-foreground">
          {t("settingsPage.workspace.members.loadError")}
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t("settingsPage.workspace.loadError.retry")}
        </Button>
      </div>
    );
  }
  if (status === "loading") {
    return <div aria-hidden="true" className="h-10 animate-pulse rounded-lg bg-foreground/5" />;
  }
  return <p className="text-xs text-muted-foreground">{t("notes.spaces.members.empty")}</p>;
}

interface MemberRowProps {
  member: TeamMember;
  canManage: boolean;
  isSelf: boolean;
  pending: boolean;
  onRoleChange: (member: TeamMember, role: TeamRole) => void;
  onRemove: (member: TeamMember) => void;
}

function MemberRow({
  member,
  canManage,
  isSelf,
  pending,
  onRoleChange,
  onRemove,
}: MemberRowProps): ReactElement {
  const { t } = useTranslation();

  return (
    <tr className={cn("h-[45px]", ROW_DIVIDER)}>
      <td className="max-w-0 ps-4 pe-3 py-1.5">
        <NameCell
          lead={
            <MemberAvatar name={member.name} email={member.email} image={member.image} size="sm" />
          }
          primary={
            member.name ? (
              <span dir="auto">{member.name}</span>
            ) : (
              <bdi dir="ltr">{member.email}</bdi>
            )
          }
          secondary={member.name ? <bdi dir="ltr">{member.email}</bdi> : null}
        />
      </td>
      <td className={cn(COLUMN_DIVIDER, "px-4")}>
        {canManage ? (
          <SpaceRoleMenu
            role={member.role}
            subject={member.name || member.email}
            pending={pending}
            onRoleChange={(role) => onRoleChange(member, role)}
            // Leaving is how the viewer goes, and it has its own checks.
            onRemove={isSelf ? undefined : () => onRemove(member)}
            copy={ROLE_MENU_COPY}
          />
        ) : (
          <span className="text-xs text-foreground">
            {member.role === "admin"
              ? t("notes.spaces.members.roleAdmin")
              : t("notes.spaces.members.roleMember")}
          </span>
        )}
      </td>
    </tr>
  );
}

function NameCell({
  lead,
  primary,
  secondary,
}: {
  lead: ReactNode;
  primary: ReactNode;
  secondary: ReactNode;
}): ReactElement {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span aria-hidden="true" className="flex shrink-0">
        {lead}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-xs font-medium text-foreground">{primary}</span>
        {secondary ? (
          <span className="truncate text-[11px] text-muted-foreground">{secondary}</span>
        ) : null}
      </span>
    </div>
  );
}

interface PendingInvitationsProps {
  invitations: TeamInvitation[];
  canResend: boolean;
  resendingIds: ReadonlySet<string>;
  onResend: (invitation: TeamInvitation) => void;
}

// People who were invited to the workspace and the team together: they join the team once they
// accept, so they are not table rows.
function PendingInvitations({
  invitations,
  canResend,
  resendingIds,
  onResend,
}: PendingInvitationsProps): ReactElement {
  const { t } = useTranslation();
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h3 id={headingId} className="text-xs font-normal text-muted-foreground">
        {t(`${MEMBERS}.pending`)}
      </h3>
      <ul className={cn(TABLE_FRAME, "overflow-hidden")}>
        {invitations.map((invitation, index) => (
          <li
            key={invitation.id}
            className={cn(
              "flex min-h-[45px] items-center gap-2.5 px-4 py-1.5",
              index > 0 && ROW_DIVIDER
            )}
          >
            <span
              aria-hidden="true"
              className="flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground/5 text-muted-foreground dark:bg-white/6"
            >
              <EnvelopePlus className="size-3" aria-hidden="true" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-xs font-medium text-foreground">
                <bdi dir="ltr">{invitation.email}</bdi>
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {t(`${MEMBERS}.pendingBody`, {
                  role:
                    invitation.workspace_role === "admin"
                      ? t("notes.spaces.members.roleAdmin")
                      : t("notes.spaces.members.roleMember"),
                })}
              </span>
            </span>
            <span className={cn(ROW_BUTTON_CLASS, PILL, "pointer-events-none h-6")}>
              {t(`${MEMBERS}.invitedPill`)}
            </span>
            {canResend && (
              <button
                type="button"
                onClick={() => onResend(invitation)}
                disabled={resendingIds.has(invitation.id)}
                className={cn(ROW_BUTTON_CLASS, PILL, "h-6")}
              >
                {t(`${MEMBERS}.resend`)}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
