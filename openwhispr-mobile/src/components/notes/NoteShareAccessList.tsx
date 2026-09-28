import { useEffect, useState } from 'react';
import { Alert, View } from 'react-native';
import { SearchField } from '@/components/ui/SearchField';
import { Text } from '@/components/ui/Text';
import { searchNoteAccessPrincipals } from '@/data/remote/noteSharingApi';
import { confirmDestructive } from '@/lib/alerts';
import type {
  AccessPrincipalSuggestion,
  NoteAccessGrant,
  NoteAccessPrincipalType,
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
import { ShareTextButton } from './ShareTextButton';

const PRINCIPAL_LABEL: Record<NoteAccessPrincipalType, string> = {
  user: 'Person',
  email: 'Email',
  team: 'Team',
  space: 'Team space',
  folder: 'Folder',
  workspace: 'Workspace',
};

function grantDetail(grant: NoteAccessGrant): string {
  if (isScopeGrant(grant) && grant.source !== 'direct')
    return `Inherited from ${PRINCIPAL_LABEL[grant.source].toLowerCase()}`;
  // Stored group grants are flagged inherited because their members inherit them.
  return isGroupPrincipal(grant.principal.type) ? PRINCIPAL_LABEL[grant.principal.type] : 'Direct';
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

interface NoteShareAccessListProps {
  remoteId?: string;
  access: NoteAccessState;
  invitations: NoteShareInvitation[];
  /** External sharing is off, which suspends stored grants and invitations on the server. */
  paused?: boolean;
  /** Organization policy allows invitations, new grants, and raising a permission to editor. */
  canInvite?: boolean;
  busy: boolean;
  onAddPrincipal?: (principal: AccessPrincipalSuggestion) => void;
  onUpdateGrant: (grant: NoteAccessGrant, permission: NoteAccessGrant['permission']) => void;
  onRemoveGrant: (grant: NoteAccessGrant) => void;
  onRevokeInvitation: (invitation: NoteShareInvitation) => void;
  onResendInvitation: (invitation: NoteShareInvitation) => void;
}

export function NoteShareAccessList({
  remoteId,
  access,
  invitations,
  paused = false,
  canInvite = true,
  busy,
  onAddPrincipal,
  onUpdateGrant,
  onRemoveGrant,
  onRevokeInvitation,
  onResendInvitation,
}: NoteShareAccessListProps) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<AccessPrincipalSuggestion[]>([]);
  const [searchError, setSearchError] = useState(false);
  useEffect(() => {
    setSuggestions([]);
    setSearchError(false);
    if (!remoteId || !access.can_manage_access || query.trim().length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchNoteAccessPrincipals(remoteId, query.trim(), { signal: controller.signal })
        .then((result) => {
          if (!controller.signal.aborted) setSuggestions(result.suggestions);
        })
        .catch(() => {
          if (!controller.signal.aborted) setSearchError(true);
        });
    }, 300);
    return (): void => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [remoteId, access.can_manage_access, query]);
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
  const existingIds = new Set(access.grants.map((grant) => grant.principal.id).filter(Boolean));
  const existingEmails = new Set([
    ...access.grants.map((grant) => grant.principal.email?.toLowerCase()).filter(Boolean),
    ...invitations
      .filter((invite) => !invite.revoked_at)
      .map((invite) => invite.email.toLowerCase()),
  ]);
  const available = suggestions.filter(
    (principal) =>
      !principal.existing_grant_id &&
      !existingIds.has(principal.id) &&
      !existingEmails.has(principal.email?.toLowerCase()) &&
      (!isGroupPrincipal(principal.type) || access.can_manage_inherited_access),
  );

  return (
    <View className="gap-2">
      <Text className="px-1 text-[13px] uppercase tracking-wider text-secondaryLabel">
        People with access
      </Text>
      {paused && (
        <Text className="px-1 text-[12px] text-secondaryLabel">
          People you added and invitations are paused until you share this note again.
        </Text>
      )}
      {access.can_manage_access && canInvite && remoteId && onAddPrincipal && (
        <View className="gap-2">
          <View className="flex-row">
            <SearchField
              accessibilityLabel="Find people or groups"
              placeholder="Find people or groups"
              value={query}
              onChangeText={setQuery}
            />
          </View>
          {searchError && (
            <Text className="text-[12px] text-systemRed">Search unavailable. Try again.</Text>
          )}
          {available.length > 0 && (
            <GroupedList dividerInset={16}>
              {available.map((principal) => (
                <GroupedList.Row
                  key={`${principal.type}:${principal.id ?? principal.email}`}
                  onPress={() => {
                    onAddPrincipal(principal);
                    setQuery('');
                  }}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={`Grant access to ${principal.name || principal.email}`}
                >
                  <Text
                    className={busy ? 'text-[15px] text-tertiaryLabel' : 'text-[15px] text-label'}
                  >
                    {principal.name || principal.email}
                  </Text>
                  <Text className="text-[12px] text-secondaryLabel">
                    {PRINCIPAL_LABEL[principal.type]}
                  </Text>
                </GroupedList.Row>
              ))}
            </GroupedList>
          )}
        </View>
      )}
      <GroupedList dividerInset={16}>
        <GroupedList.Row>
          <View className="flex-row items-center justify-between">
            <Text className="text-[15px] font-medium text-label">
              {access.owner.name || access.owner.email || 'Owner'}
            </Text>
            <Text className="text-[13px] text-secondaryLabel">Owner</Text>
          </View>
        </GroupedList.Row>
        {grants.map((grant) => {
          const name = grant.principal.name || grant.principal.email || 'Unnamed group';
          const canEdit = canChangeGrant(access, grant);
          return (
            <GroupedList.Row key={grant.id}>
              <Text className="text-[15px] font-medium text-label">{name}</Text>
              <Text className="text-[12px] text-secondaryLabel">
                {grant.permission === 'editor' ? 'Editor' : 'Viewer'}
                {` · ${grantDetail(grant)}`}
                {grant.pending ? ' · Pending' : ''}
                {paused && isPausedBySharingOff(grant) ? ' · Paused' : ''}
              </Text>
              {canEdit && (
                <View className="flex-row gap-6">
                  {(canInvite || grant.permission === 'editor') && (
                    <ShareTextButton
                      label={grant.permission === 'viewer' ? 'Make editor' : 'Make viewer'}
                      accessibilityLabel={`${grant.permission === 'viewer' ? 'Make' : 'Change'} ${name} ${grant.permission === 'viewer' ? 'an editor' : 'a viewer'}`}
                      disabled={busy}
                      onPress={() =>
                        grant.permission === 'viewer'
                          ? confirmEditor(name, () => onUpdateGrant(grant, 'editor'))
                          : onUpdateGrant(grant, 'viewer')
                      }
                    />
                  )}
                  <ShareTextButton
                    label="Remove"
                    accessibilityLabel={`Remove access for ${name}`}
                    destructive
                    disabled={busy}
                    onPress={() =>
                      confirmDestructive(
                        'Remove access?',
                        `${name} will lose the access granted on this note.`,
                        () => onRemoveGrant(grant),
                        { destructiveLabel: 'Remove' },
                      )
                    }
                  />
                </View>
              )}
            </GroupedList.Row>
          );
        })}
        {pending.map((invite) => {
          const invitationGrant = access.grants.find((grant) => grant.id === `invite:${invite.id}`);
          return (
            <GroupedList.Row key={invite.id}>
              <Text className="text-[15px] font-medium text-label">{invite.email}</Text>
              <Text className="text-[12px] text-secondaryLabel">
                Pending invitation
                {paused ? ' · Paused' : ''}
                {` · ${invite.permission === 'editor' ? 'Editor' : 'Viewer'}`}
              </Text>
              {access.can_manage_access && (
                <View className="flex-row gap-6">
                  {invitationGrant && (canInvite || invite.permission === 'editor') && (
                    <ShareTextButton
                      label={invite.permission === 'viewer' ? 'Make editor' : 'Make viewer'}
                      accessibilityLabel={`Make ${invite.email} ${invite.permission === 'viewer' ? 'an editor' : 'a viewer'}`}
                      disabled={busy}
                      onPress={() =>
                        invite.permission === 'viewer'
                          ? confirmEditor(invite.email, () =>
                              onUpdateGrant(invitationGrant, 'editor'),
                            )
                          : onUpdateGrant(invitationGrant, 'viewer')
                      }
                    />
                  )}
                  {canInvite && !paused && (
                    <ShareTextButton
                      label="Resend"
                      accessibilityLabel={`Resend invitation to ${invite.email}`}
                      disabled={busy}
                      onPress={() => onResendInvitation(invite)}
                    />
                  )}
                  <ShareTextButton
                    label="Revoke"
                    accessibilityLabel={`Revoke invitation for ${invite.email}`}
                    destructive
                    disabled={busy}
                    onPress={() =>
                      confirmDestructive(
                        'Revoke invitation?',
                        `${invite.email} will lose the access this invitation gave them.`,
                        () => onRevokeInvitation(invite),
                        { destructiveLabel: 'Revoke' },
                      )
                    }
                  />
                </View>
              )}
            </GroupedList.Row>
          );
        })}
      </GroupedList>
    </View>
  );
}
