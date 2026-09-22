import { useEffect, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { searchNoteAccessPrincipals } from '@/data/remote/noteSharingApi';
import type {
  AccessPrincipalSuggestion,
  NoteAccessGrant,
  NoteAccessState,
  NoteShareInvitation,
} from '@/data/remote/noteSharingTypes';
import { GroupedList } from './GroupedList';

interface NoteShareAccessListProps {
  remoteId?: string;
  access?: NoteAccessState;
  invitations: NoteShareInvitation[];
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
    if (!remoteId || !access?.can_manage_access || query.trim().length < 2) return;
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
  }, [remoteId, access?.can_manage_access, query]);
  const pending = invitations.filter((invite) => !invite.revoked_at && !invite.accepted_at);
  const invitationEmails = new Set(pending.map((invite) => invite.email.toLowerCase()));
  const grants = access?.grants.filter(
    (grant) =>
      !(
        grant.id.startsWith('invite:') &&
        grant.principal.email &&
        invitationEmails.has(grant.principal.email.toLowerCase())
      ),
  );
  const existingIds = new Set(access?.grants.map((grant) => grant.principal.id).filter(Boolean));
  const existingEmails = new Set([
    ...(access?.grants.map((grant) => grant.principal.email?.toLowerCase()).filter(Boolean) ?? []),
    ...invitations
      .filter((invite) => !invite.revoked_at)
      .map((invite) => invite.email.toLowerCase()),
  ]);
  const available = suggestions.filter(
    (principal) =>
      !principal.existing_grant_id &&
      !existingIds.has(principal.id) &&
      !existingEmails.has(principal.email?.toLowerCase()) &&
      (!['team', 'folder', 'workspace'].includes(principal.type) ||
        access?.can_manage_inherited_access),
  );
  if (!access && pending.length === 0) return null;

  return (
    <View className="gap-2">
      <Text className="px-1 text-[13px] uppercase tracking-wider text-secondaryLabel">
        People with access
      </Text>
      {access?.can_manage_access && remoteId && onAddPrincipal && (
        <View className="gap-2">
          <TextInput
            accessibilityLabel="Find people or groups"
            className="rounded-lg border border-separator bg-secondarySystemGroupedBackground px-3 py-2 text-label"
            placeholder="Find people or groups"
            autoCapitalize="none"
            value={query}
            onChangeText={setQuery}
          />
          {searchError && (
            <Text className="text-[12px] text-systemRed">Search unavailable. Try again.</Text>
          )}
          {available.length > 0 && (
            <GroupedList dividerInset={16}>
              {available.map((principal) => (
                <GroupedList.Row
                  key={`${principal.type}:${principal.id ?? principal.email}`}
                  onPress={
                    busy
                      ? undefined
                      : () => {
                          onAddPrincipal(principal);
                          setQuery('');
                        }
                  }
                  accessibilityRole="button"
                  accessibilityLabel={`Grant access to ${principal.name || principal.email}`}
                >
                  <Text
                    className={busy ? 'text-[15px] text-tertiaryLabel' : 'text-[15px] text-label'}
                  >
                    {principal.name || principal.email}
                  </Text>
                  <Text className="text-[12px] text-secondaryLabel">{principal.type}</Text>
                </GroupedList.Row>
              ))}
            </GroupedList>
          )}
        </View>
      )}
      <GroupedList dividerInset={16}>
        {access && (
          <GroupedList.Row>
            <View className="flex-row items-center justify-between">
              <Text className="text-[15px] font-medium text-label">
                {access.owner.name || access.owner.email || 'Owner'}
              </Text>
              <Text className="text-[13px] text-secondaryLabel">Owner</Text>
            </View>
          </GroupedList.Row>
        )}
        {grants?.map((grant) => {
          const name = grant.principal.name || grant.principal.email || 'Unnamed group';
          const canEdit =
            access?.can_manage_access &&
            !grant.inherited &&
            (!['team', 'folder', 'workspace'].includes(grant.principal.type) ||
              access.can_manage_inherited_access);
          return (
            <GroupedList.Row key={grant.id}>
              <Text className="text-[15px] font-medium text-label">{name}</Text>
              <Text className="text-[12px] text-secondaryLabel">
                {grant.permission === 'editor' ? 'Editor' : 'Viewer'}
                {grant.inherited ? ` · Inherited from ${grant.source}` : ' · Direct'}
                {grant.pending ? ' · Pending' : ''}
              </Text>
              {canEdit && (
                <View className="mt-2 flex-row gap-4">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${grant.permission === 'viewer' ? 'Make' : 'Change'} ${name} ${grant.permission === 'viewer' ? 'an editor' : 'a viewer'}`}
                    disabled={busy}
                    onPress={() =>
                      onUpdateGrant(grant, grant.permission === 'viewer' ? 'editor' : 'viewer')
                    }
                  >
                    <Text className={busy ? 'text-tertiaryLabel' : 'text-link'}>
                      {grant.permission === 'viewer' ? 'Make editor' : 'Make viewer'}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Remove access for ${name}`}
                    disabled={busy}
                    onPress={() => onRemoveGrant(grant)}
                  >
                    <Text className={busy ? 'text-tertiaryLabel' : 'text-systemRed'}>Remove</Text>
                  </Pressable>
                </View>
              )}
            </GroupedList.Row>
          );
        })}
        {pending.map((invite) => {
          const invitationGrant = access?.grants.find(
            (grant) => grant.id === `invite:${invite.id}`,
          );
          return (
            <GroupedList.Row key={invite.id}>
              <Text className="text-[15px] font-medium text-label">{invite.email}</Text>
              <Text className="text-[12px] text-secondaryLabel">
                Pending invitation
                {invitationGrant
                  ? ` · ${invitationGrant.permission === 'editor' ? 'Editor' : 'Viewer'}`
                  : ''}
              </Text>
              {access?.can_manage_access !== false && (
                <View className="mt-2 flex-row gap-4">
                  {invitationGrant && access?.can_manage_access && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Make ${invite.email} ${invitationGrant.permission === 'viewer' ? 'an editor' : 'a viewer'}`}
                      disabled={busy}
                      onPress={() =>
                        onUpdateGrant(
                          invitationGrant,
                          invitationGrant.permission === 'viewer' ? 'editor' : 'viewer',
                        )
                      }
                    >
                      <Text className={busy ? 'text-tertiaryLabel' : 'text-link'}>
                        {invitationGrant.permission === 'viewer' ? 'Make editor' : 'Make viewer'}
                      </Text>
                    </Pressable>
                  )}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Resend invitation to ${invite.email}`}
                    disabled={busy}
                    onPress={() => onResendInvitation(invite)}
                  >
                    <Text className={busy ? 'text-tertiaryLabel' : 'text-link'}>Resend</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Revoke invitation for ${invite.email}`}
                    disabled={busy}
                    onPress={() => onRevokeInvitation(invite)}
                  >
                    <Text className={busy ? 'text-tertiaryLabel' : 'text-systemRed'}>Revoke</Text>
                  </Pressable>
                </View>
              )}
            </GroupedList.Row>
          );
        })}
      </GroupedList>
    </View>
  );
}
