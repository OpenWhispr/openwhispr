import { noteShareMenuActions } from './noteShareMenuActions';
import { type ReactNode } from 'react';
import { Alert, Platform, Pressable, View } from 'react-native';
import { MenuView, type MenuAction } from '@react-native-menu/menu';
import { useAndroidCopy } from '@/hooks/useAndroidCopy';
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
import { PRINCIPAL_LABEL, PrincipalAvatar, usePrincipalLabels } from './NoteSharePrincipal';

type Permission = NoteAccessGrant['permission'];

type Copy = ReturnType<typeof useAndroidCopy>['copy'];
type PrincipalLabels = ReturnType<typeof usePrincipalLabels>;

function roleLabel(role: Permission, copy: Copy): string {
  return role === 'editor'
    ? copy('noteAccess.editor', 'Editor')
    : copy('noteAccess.viewer', 'Viewer');
}

function grantDetail(grant: NoteAccessGrant, copy: Copy, labels: PrincipalLabels): string | null {
  if (isScopeGrant(grant) && grant.source !== 'direct')
    return copy(
      `noteAccess.inherited.${grant.source}`,
      `Inherited from ${PRINCIPAL_LABEL[grant.source].toLowerCase()}`,
    );
  // Stored group grants are flagged inherited because their members inherit them.
  if (isGroupPrincipal(grant.principal.type)) return labels[grant.principal.type];
  return grant.principal.name ? grant.principal.email : null;
}

function confirmEditor(name: string, onConfirm: () => void, copy: Copy): void {
  Alert.alert(
    copy('noteAccess.makeEditorTitle', `Make ${name} an editor?`, { name }),
    copy('noteAccess.editorBody', 'Editors can change this note and manage who it is shared with.'),
    [
      { text: copy('cancel', 'Cancel'), style: 'cancel' },
      { text: copy('noteAccess.makeEditor', 'Make editor'), onPress: onConfirm },
    ],
  );
}

/** The editor/viewer choice, as its own section of the row's menu. */
function roleSection(rowId: string, current: Permission, busy: boolean, copy: Copy): MenuAction {
  return {
    id: `${rowId}:roles`,
    title: '',
    displayInline: true,
    subactions: (['editor', 'viewer'] as const).map((permission) => ({
      id: `${rowId}:${permission}`,
      title: roleLabel(permission, copy),
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
  const { copy } = useAndroidCopy();
  if (actions.length === 0) {
    return <Text className="text-[13px] text-secondaryLabel">{roleLabel(role, copy)}</Text>;
  }
  return (
    <MenuView
      actions={noteShareMenuActions(actions)}
      onPressAction={({ nativeEvent }) => onAction(nativeEvent.event)}
      shouldOpenOnLongPress={false}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={{ text: roleLabel(role, copy) }}
        accessibilityState={{ disabled: busy }}
        className={
          Platform.OS === 'android'
            ? 'min-h-[48px] flex-row items-center gap-1 pl-2 active:opacity-60'
            : 'min-h-[44px] flex-row items-center gap-1 pl-2 active:opacity-60'
        }
      >
        <Text className={busy ? 'text-[13px] text-tertiaryLabel' : 'text-[13px] text-link'}>
          {roleLabel(role, copy)}
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
      <View className={Platform.OS === 'android' ? 'min-w-0 gap-2' : 'flex-row items-center gap-3'}>
        <View className={Platform.OS === 'android' ? 'min-w-0' : 'min-w-0 flex-1'}>
          <Text
            numberOfLines={Platform.OS === 'android' ? undefined : 1}
            className="text-[15px] font-medium text-label"
          >
            {name}
          </Text>
          {detail ? (
            <Text
              numberOfLines={Platform.OS === 'android' ? undefined : 1}
              className="text-[12px] text-secondaryLabel"
            >
              {detail}
            </Text>
          ) : null}
        </View>
        {Platform.OS === 'android' ? (
          <View className="max-w-full self-start">{trailing}</View>
        ) : (
          trailing
        )}
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
  const { copy } = useAndroidCopy();
  const labels = usePrincipalLabels();
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
    if (permission === 'editor') confirmEditor(name, () => onUpdateGrant(grant, 'editor'), copy);
    else onUpdateGrant(grant, 'viewer');
  };

  const grantRow = (grant: NoteAccessGrant): ReactNode => {
    const name =
      grant.principal.name ||
      grant.principal.email ||
      copy('noteAccess.unnamedGroup', 'Unnamed group');
    const actions: MenuAction[] = [];
    if (canChangeGrant(access, grant)) {
      if (canInvite || grant.permission === 'editor')
        actions.push(roleSection(grant.id, grant.permission, busy, copy));
      actions.push({
        id: `${grant.id}:remove`,
        title: copy('noteAccess.removeAccess', 'Remove access'),
        attributes: { destructive: true, disabled: busy },
      });
    }
    const detail = [
      grantDetail(grant, copy, labels),
      grant.pending ? copy('noteAccess.pending', 'Pending') : null,
      paused && isPausedBySharingOff(grant) ? copy('noteAccess.paused', 'Paused') : null,
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
            accessibilityLabel={copy('noteAccess.changeAccess', `Change access for ${name}`, {
              name,
            })}
            actions={actions}
            busy={busy}
            onAction={(id) => {
              if (!id.endsWith(':remove')) {
                changeRole(grant, grant.permission, name, id);
                return;
              }
              confirmDestructive(
                copy('noteAccess.removeTitle', 'Remove access?'),
                copy(
                  'noteAccess.removeBody',
                  `${name} will lose the access granted on this note.`,
                  { name },
                ),
                () => onRemoveGrant(grant),
                {
                  destructiveLabel: copy('noteAccess.remove', 'Remove'),
                  cancelLabel: copy('cancel', 'Cancel'),
                },
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
        actions.push(roleSection(rowId, invite.permission, busy, copy));
      // A paused share's emailed link can't open the note, so resending would only confuse.
      if (canInvite && !paused)
        actions.push({
          id: `${rowId}:resend`,
          title: copy('noteAccess.resend', 'Resend invitation'),
          attributes: { disabled: busy },
        });
      actions.push({
        id: `${rowId}:revoke`,
        title: copy('noteAccess.revokeInvitation', 'Revoke invitation'),
        attributes: { destructive: true, disabled: busy },
      });
    }
    return (
      <PersonRow
        key={invite.id}
        avatar={<PrincipalAvatar type="email" email={invite.email} />}
        name={invite.email}
        detail={[
          copy('noteAccess.pendingInvitation', 'Pending invitation'),
          paused ? copy('noteAccess.paused', 'Paused') : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        trailing={
          <RoleMenu
            role={invite.permission}
            accessibilityLabel={copy(
              'noteAccess.changeAccess',
              `Change access for ${invite.email}`,
              { name: invite.email },
            )}
            actions={actions}
            busy={busy}
            onAction={(id) => {
              if (id.endsWith(':resend')) {
                onResendInvitation(invite);
              } else if (id.endsWith(':revoke')) {
                confirmDestructive(
                  copy('noteAccess.revokeTitle', 'Revoke invitation?'),
                  copy(
                    'noteAccess.revokeBody',
                    `${invite.email} will lose the access this invitation gave them.`,
                    { email: invite.email },
                  ),
                  () => onRevokeInvitation(invite),
                  {
                    destructiveLabel: copy('noteAccess.revoke', 'Revoke'),
                    cancelLabel: copy('cancel', 'Cancel'),
                  },
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
        {copy('noteAccess.people', 'People with access')}
      </Text>
      <GroupedList>
        {inviteField}
        <PersonRow
          avatar={
            <PrincipalAvatar type="user" name={access.owner.name} email={access.owner.email} />
          }
          name={access.owner.name || access.owner.email || copy('noteAccess.owner', 'Owner')}
          detail={access.owner.name ? access.owner.email : null}
          trailing={
            <Text className="text-[13px] text-secondaryLabel">
              {copy('noteAccess.owner', 'Owner')}
            </Text>
          }
        />
        {grants.map(grantRow)}
        {pending.map(invitationRow)}
      </GroupedList>
      {paused && (
        <Text className="px-4 text-[12px] text-secondaryLabel">
          {copy(
            'noteAccess.pausedBody',
            'People you added and invitations are paused until you share this note again.',
          )}
        </Text>
      )}
    </View>
  );
}
