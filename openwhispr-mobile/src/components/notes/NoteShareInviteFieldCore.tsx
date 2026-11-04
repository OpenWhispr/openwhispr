import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { TextInput, View, type TextStyle } from 'react-native';
import { Text } from '@/components/ui/Text';
import { searchNoteAccessPrincipals } from '@/data/remote/noteSharingApi';
import type {
  AccessPrincipalSuggestion,
  NoteAccessState,
  NoteShareInvitation,
} from '@/data/remote/noteSharingTypes';
import { iosColor } from '@/config/colors';
import { AppFont } from '@/lib/fonts';
import { isValidEmail } from '@/lib/utils';
import { isGroupPrincipal } from '@/lib/notes/noteShareAccess';
import { GroupedList } from './GroupedList';
import { NOTES_ROW_CONTENT_INSET } from './tokens';
import { PRINCIPAL_LABEL, PrincipalAvatar, RowIcon } from './NoteSharePrincipal';
import type { NoteShareCopy } from './NoteSharePrincipalCore';

const PLACEHOLDER_COLOR = iosColor('tertiaryLabel');
const INPUT_STYLE: TextStyle = { fontFamily: AppFont.regular };

interface NoteShareInviteFieldProps {
  value: string;
  onChangeText: (value: string) => void;
  /** Invites the typed address; the caller validates it and clears the field. */
  onInvite: () => void;
  /** Adding people and groups needs a cloud copy to search against; email invitations don't. */
  remoteId?: string;
  access?: NoteAccessState;
  invitations?: NoteShareInvitation[];
  busy: boolean;
  onAddPrincipal?: (principal: AccessPrincipalSuggestion) => void;
}

/** One field that searches people and groups and invites any typed email address. */
interface InvitePresentation {
  useCopy?: () => { copy: NoteShareCopy };
  useLabels?: () => typeof PRINCIPAL_LABEL;
  inputClassName?: string;
  numberOfLines?: number;
  inviteText?: (query: string, copy: NoteShareCopy) => ReactNode;
}

export function createNoteShareInviteField(options: InvitePresentation = {}) {
  const presentation = {
    useCopy: () => ({ copy: (_key: string, fallback: string) => fallback }),
    useLabels: () => PRINCIPAL_LABEL,
    inputClassName: 'py-1 text-[15px] text-label',
    numberOfLines: 1,
    inviteText: (query: string, _copy: NoteShareCopy): ReactNode => ['Invite ', query],
    ...options,
  };
  const { useCopy, useLabels } = presentation;
  return function NoteShareInviteField({
    value,
    onChangeText,
    onInvite,
    remoteId,
    access,
    invitations = [],
    busy,
    onAddPrincipal,
  }: NoteShareInviteFieldProps) {
    const { copy } = useCopy();
    const labels = useLabels();
    const [suggestions, setSuggestions] = useState<AccessPrincipalSuggestion[]>([]);
    const [searchError, setSearchError] = useState(false);
    const searchable = Boolean(remoteId && access?.can_manage_access && onAddPrincipal);
    const query = value.trim();
    useEffect(() => {
      setSuggestions([]);
      setSearchError(false);
      if (!searchable || !remoteId || query.length < 2) return;
      const controller = new AbortController();
      const timer = setTimeout(() => {
        searchNoteAccessPrincipals(remoteId, query, { signal: controller.signal })
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
    }, [searchable, remoteId, query]);

    const grants = access?.grants ?? [];
    const existingIds = new Set(grants.map((grant) => grant.principal.id).filter(Boolean));
    // Groups have no email, so a missing one must never count as a match.
    const existingEmails = new Set(
      [
        access?.owner.email,
        ...grants.map((grant) => grant.principal.email),
        ...invitations.filter((invite) => !invite.revoked_at).map((invite) => invite.email),
      ]
        .filter((email): email is string => Boolean(email))
        .map((email) => email.toLowerCase()),
    );
    const available = suggestions.filter(
      (principal) =>
        !principal.existing_grant_id &&
        !existingIds.has(principal.id) &&
        !(principal.email && existingEmails.has(principal.email.toLowerCase())) &&
        (!isGroupPrincipal(principal.type) || access?.can_manage_inherited_access),
    );
    const typedEmail = query.toLowerCase();
    const offerInvite =
      isValidEmail(query) &&
      !existingEmails.has(typedEmail) &&
      !available.some((principal) => principal.email?.toLowerCase() === typedEmail);
    const placeholder = searchable
      ? copy('noteAccess.addPeople', 'Add people or emails')
      : copy('noteAccess.inviteEmail', 'Invite by email');

    const rows = [
      <GroupedList.Row
        key="field"
        leadingIconSlot={<RowIcon name="person.badge.plus" mdName="UserPlus" />}
      >
        <TextInput
          accessibilityLabel={placeholder}
          className={presentation.inputClassName}
          style={INPUT_STYLE}
          placeholder={
            searchable
              ? copy('noteAccess.searchPlaceholder', 'Add people or emails')
              : copy('noteAccess.email', 'Invite by email')
          }
          placeholderTextColor={PLACEHOLDER_COLOR}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="emailAddress"
          keyboardType="email-address"
          returnKeyType="send"
          clearButtonMode="while-editing"
          value={value}
          onChangeText={onChangeText}
          onSubmitEditing={onInvite}
        />
        {searchError && (
          <Text className="pt-1 text-[12px] text-systemRed">
            {copy('noteAccess.searchError', 'Search unavailable. Try again.')}
          </Text>
        )}
      </GroupedList.Row>,
    ];
    if (offerInvite) {
      rows.push(
        <GroupedList.Row
          key="invite"
          onPress={onInvite}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={copy('noteAccess.invite', `Invite ${query}`, { email: query })}
          leadingIconSlot={<RowIcon name="envelope" mdName="Mail" />}
        >
          <Text
            numberOfLines={presentation.numberOfLines}
            className={busy ? 'text-[15px] text-tertiaryLabel' : 'text-[15px] text-link'}
          >
            {presentation.inviteText(query, copy)}
          </Text>
          <Text className="text-[12px] text-secondaryLabel">
            {copy('noteAccess.sendsEmail', 'Sends an email invitation')}
          </Text>
        </GroupedList.Row>,
      );
    }
    for (const principal of available) {
      const name = principal.name || principal.email || labels[principal.type];
      rows.push(
        <GroupedList.Row
          key={`${principal.type}:${principal.id ?? principal.email}`}
          onPress={() => onAddPrincipal?.(principal)}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={copy('noteAccess.grantAccess', `Grant access to ${name}`, { name })}
          leadingIconSlot={
            <PrincipalAvatar type={principal.type} name={principal.name} email={principal.email} />
          }
        >
          <Text
            numberOfLines={presentation.numberOfLines}
            className={busy ? 'text-[15px] text-tertiaryLabel' : 'text-[15px] text-label'}
          >
            {name}
          </Text>
          <Text
            numberOfLines={presentation.numberOfLines}
            className="text-[12px] text-secondaryLabel"
          >
            {principal.name && principal.email ? principal.email : labels[principal.type]}
          </Text>
        </GroupedList.Row>,
      );
    }
    return <View>{withDividers(rows)}</View>;
  };
}

/** Rows inside one card slot, separated like the card's own rows. */
function withDividers(rows: ReactElement[]): ReactNode[] {
  return rows.flatMap((row, index) =>
    index === 0
      ? [row]
      : [
          <View
            key={`divider-${row.key}`}
            className="h-px bg-separator"
            style={{ marginLeft: NOTES_ROW_CONTENT_INSET }}
          />,
          row,
        ],
  );
}
