import { type ReactNode } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { MenuView, type MenuAction } from '@react-native-menu/menu';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { confirmDestructive } from '@/lib/alerts';
import type {
  NoteAccessGrant,
  NoteAccessState,
  NoteShareInvitation,
} from '@/data/remote/noteSharingTypes';
import {
  canChangeGrant,
  isGroupPrincipal,
  isPausedBySharingOff,
  isScopeGrant,
} from '@/lib/notes/noteShareAccess';
import { GroupedList } from './GroupedList';
import { PRINCIPAL_LABEL, PrincipalAvatar } from './NoteSharePrincipal';

type Permission = NoteAccessGrant['permission'];

const ROLE_LABEL: Record<Permission, string> = { editor: 'Editor', viewer: 'Viewer' };

function grantDetail(grant: NoteAccessGrant): string | null {
  if (isScopeGrant(grant) && grant.source !== 'direct')
    return `Inherited from ${PRINCIPAL_LABEL[grant.source].toLowerCase()}`;
  // Stored group grants are flagged inherited because their members inherit them.
  if (isGroupPrincipal(grant.principal.type)) return PRINCIPAL_LABEL[grant.principal.type];
  return grant.principal.name ? grant.principal.email : null;
}

function confirmEditor(name: string, onConfirm: () => void): void {
  Alert.alert(
    `Make ${name} an editor?`,
    'Editors can change this note and manage who it is shared with.',
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Make editor', onPress: onConfirm },
    ],
  );
}

/** The editor/viewer choice, as its own section of the row's menu. */
function roleSection(rowId: string, current: Permission, busy: boolean): MenuAction {
  return {
    id: `${rowId}:roles`,
    title: '',
    displayInline: true,
    subactions: (['editor', 'viewer'] as const).map((permission) => ({
      id: `${rowId}:${permission}`,
      title: ROLE_LABEL[permission],
      state: permission === current ? 'on' : 'off',
      attributes: { disabled: busy },
    })),
  };
}

interface RoleMenuProps {
  role: Permission;
  accessibilityLabel: string;
  actions: MenuAction[];
  busy: boolean;
  onAction: (id: string) => void;
}

/** The trailing role label, which opens the row's actions when there are any. */
function RoleMenu({ role, accessibilityLabel, actions, busy, onAction }: RoleMenuProps) {
  if (actions.length === 0) {
    return <Text className="text-[13px] text-secondaryLabel">{ROLE_LABEL[role]}</Text>;
  }
  return (
    <MenuView
      actions={actions}
      onPressAction={({ nativeEvent }) => onAction(nativeEvent.event)}
      shouldOpenOnLongPress={false}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={{ text: ROLE_LABEL[role] }}
        accessibilityState={{ disabled: busy }}
        className="min-h-[44px] flex-row items-center gap-1 pl-2 active:opacity-60"
      >
        <Text className={busy ? 'text-[13px] text-tertiaryLabel' : 'text-[13px] text-link'}>
          {ROLE_LABEL[role]}
        </Text>
        <SystemIcon
          name="chevron.down"
          mdName="ChevronDown"
          size={10}
          color={busy ? 'tertiaryLabel' : 'link'}
        />
      </Pressable>
    </MenuView>
  );
}

interface PersonRowProps {
  avatar: ReactNode;
  name: string;
  detail: string | null;
  trailing: ReactNode;
}

function PersonRow({ avatar, name, detail, trailing }: PersonRowProps) {
  return (
    <GroupedList.Row leadingIconSlot={avatar}>
      <View className="flex-row items-center gap-3">
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-[15px] font-medium text-label">
            {name}
          </Text>
          {detail ? (
            <Text numberOfLines={1} className="text-[12px] text-secondaryLabel">
              {detail}
            </Text>
          ) : null}
        </View>
        {trailing}
      </View>
    </GroupedList.Row>
  );
}

interface NoteShareAccessListProps {
  access: NoteAccessState;
  invitations: NoteShareInvitation[];
  /** External sharing is off, which suspends stored grants and invitations on the server. */
  paused?: boolean;
  /** Organization policy allows invitations, new grants, and raising a permission to editor. */
  canInvite?: boolean;
  busy: boolean;
  /** The field that adds people, shown as the card's first row. */
  inviteField?: ReactNode;
  onUpdateGrant: (grant: NoteAccessGrant, permission: Permission) => void;
  onRemoveGrant: (grant: NoteAccessGrant) => void;
  onRevokeInvitation: (invitation: NoteShareInvitation) => void;
  onResendInvitation: (invitation: NoteShareInvitation) => void;
}

export function NoteShareAccessList({
  access,
  invitations,
  paused = false,
  canInvite = true,
  busy,
  inviteField,
  onUpdateGrant,
  onRemoveGrant,
  onRevokeInvitation,
  onResendInvitation,
}: NoteShareAccessListProps) {
  const pending = invitations.filter((invite) => !invite.revoked_at && !invite.accepted_at);
  const invitationEmails = new Set(pending.map((invite) => invite.email.toLowerCase()));
  const grants = access.grants.filter(
    (grant) =>
      !(
        grant.id.startsWith('invite:') &&
        grant.principal.email &&
        invitationEmails.has(grant.principal.email.toLowerCase())
      ),
  );

  const changeRole = (
    grant: NoteAccessGrant,
    current: Permission,
    name: string,
    selectedId: string,
  ): void => {
    const permission: Permission = selectedId.endsWith(':editor') ? 'editor' : 'viewer';
    if (permission === current) return;
    if (permission === 'editor') confirmEditor(name, () => onUpdateGrant(grant, 'editor'));
    else onUpdateGrant(grant, 'viewer');
  };

  const grantRow = (grant: NoteAccessGrant): ReactNode => {
    const name = grant.principal.name || grant.principal.email || 'Unnamed group';
    const actions: MenuAction[] = [];
    if (canChangeGrant(access, grant)) {
      if (canInvite || grant.permission === 'editor')
        actions.push(roleSection(grant.id, grant.permission, busy));
      actions.push({
        id: `${grant.id}:remove`,
        title: 'Remove access',
        attributes: { destructive: true, disabled: busy },
      });
    }
    const detail = [
      grantDetail(grant),
      grant.pending ? 'Pending' : null,
      paused && isPausedBySharingOff(grant) ? 'Paused' : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return (
      <PersonRow
        key={grant.id}
        avatar={
          <PrincipalAvatar
            type={grant.principal.type}
            name={grant.principal.name}
            email={grant.principal.email}
          />
        }
        name={name}
        detail={detail}
        trailing={
          <RoleMenu
            role={grant.permission}
            accessibilityLabel={`Change access for ${name}`}
            actions={actions}
            busy={busy}
            onAction={(id) => {
              if (!id.endsWith(':remove')) {
                changeRole(grant, grant.permission, name, id);
                return;
              }
              confirmDestructive(
                'Remove access?',
                `${name} will lose the access granted on this note.`,
                () => onRemoveGrant(grant),
                { destructiveLabel: 'Remove' },
              );
            }}
          />
        }
      />
    );
  };

  const invitationRow = (invite: NoteShareInvitation): ReactNode => {
    const invitationGrant = access.grants.find((grant) => grant.id === `invite:${invite.id}`);
    const rowId = `invitation:${invite.id}`;
    const actions: MenuAction[] = [];
    if (access.can_manage_access) {
      if (invitationGrant && (canInvite || invite.permission === 'editor'))
        actions.push(roleSection(rowId, invite.permission, busy));
      // A paused share's emailed link can't open the note, so resending would only confuse.
      if (canInvite && !paused)
        actions.push({
          id: `${rowId}:resend`,
          title: 'Resend invitation',
          attributes: { disabled: busy },
        });
      actions.push({
        id: `${rowId}:revoke`,
        title: 'Revoke invitation',
        attributes: { destructive: true, disabled: busy },
      });
    }
    return (
      <PersonRow
        key={invite.id}
        avatar={<PrincipalAvatar type="email" email={invite.email} />}
        name={invite.email}
        detail={`Pending invitation${paused ? ' · Paused' : ''}`}
        trailing={
          <RoleMenu
            role={invite.permission}
            accessibilityLabel={`Change access for ${invite.email}`}
            actions={actions}
            busy={busy}
            onAction={(id) => {
              if (id.endsWith(':resend')) {
                onResendInvitation(invite);
              } else if (id.endsWith(':revoke')) {
                confirmDestructive(
                  'Revoke invitation?',
                  `${invite.email} will lose the access this invitation gave them.`,
                  () => onRevokeInvitation(invite),
                  { destructiveLabel: 'Revoke' },
                );
              } else if (invitationGrant) {
                changeRole(invitationGrant, invite.permission, invite.email, id);
              }
            }}
          />
        }
      />
    );
  };

  return (
    <View className="gap-2">
      <Text className="px-1 text-[13px] uppercase tracking-wider text-secondaryLabel">
        People with access
      </Text>
      <GroupedList>
        {inviteField}
        <PersonRow
          avatar={
            <PrincipalAvatar type="user" name={access.owner.name} email={access.owner.email} />
          }
          name={access.owner.name || access.owner.email || 'Owner'}
          detail={access.owner.name ? access.owner.email : null}
          trailing={<Text className="text-[13px] text-secondaryLabel">Owner</Text>}
        />
        {grants.map(grantRow)}
        {pending.map(invitationRow)}
      </GroupedList>
      {paused && (
        <Text className="px-4 text-[12px] text-secondaryLabel">
          People you added and invitations are paused until you share this note again.
        </Text>
      )}
    </View>
  );
}
