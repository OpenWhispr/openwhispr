import { noteShareMenuActions } from './noteShareMenuActions';
import { useEffect, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
  useColorScheme,
} from 'react-native';
import { MenuView, type MenuAction } from '@react-native-menu/menu';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { GlassIconButton } from '@/components/ui/GlassIconButton';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import { useNoteSharing } from '@/hooks/useNoteSharing';
import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { useSuperwallGate } from '@/hooks/useSuperwallGate';
import { SUPERWALL_PLACEMENTS } from '@/lib/superwall';
import { confirmDestructive } from '@/lib/alerts';
import { isValidEmail } from '@/lib/utils';
import { useConfigStore } from '@/store/useConfigStore';
import { useNotesStore } from '@/store/useNotesStore';
import { useUsageStore } from '@/store/useUsageStore';
import { requestSync } from '@/sync/syncEngine';
import { useSyncStore } from '@/sync/useSyncStore';
import { emailDomain, isPersonalEmailDomain } from '@/lib/notes/noteShareDomains';
import { isShareVisibilityAllowed } from '@/lib/notes/noteSharePolicy';
import { isScopeGrant } from '@/lib/notes/noteShareAccess';
import type { ShareVisibility } from '@/data/remote/noteSharingTypes';
import { GroupedList } from './GroupedList';
import { NoteShareAccessList } from './NoteShareAccessList';
import { NoteShareInviteField } from './NoteShareInviteField';
import { ShareActionRow, ShareActionStrip } from './NoteShareActions';
import { RowIcon } from './NoteSharePrincipal';
import { ShareTextButton } from './ShareTextButton';

export interface NoteShareSheetProps {
  noteId: number;
  onClose: () => void;
  onFlushDraft: () => void;
  onExport: (format: 'md' | 'txt') => void;
}

const VISIBILITY_REACH: Record<ShareVisibility, number> = {
  private: 0,
  invited: 1,
  domain: 2,
  link: 3,
};

const VISIBILITY_ICON: Record<ShareVisibility, [sfName: string, mdName: LucideIconName]> = {
  private: ['lock', 'Lock'],
  link: ['globe', 'Globe'],
  domain: ['building.2', 'Building2'],
  invited: ['person.2', 'Users'],
};

const VISIBILITY_CHOICES = ['link', 'domain', 'invited'] as const;
const VISIBILITY_ACTION_PREFIX = 'visibility:';
const REPLACE_LINK_ID = 'replace-link';
const DISABLE_SHARING_ID = 'disable-sharing';

function describeAccess(
  visibility: ShareVisibility | undefined,
  domains: string[],
  isTeamNote: boolean,
  copy: ReturnType<typeof useAndroidCopy>['copy'],
): string {
  switch (visibility) {
    case 'link':
      return copy('noteSharing.linkDetail', 'Anyone with the link can view');
    case 'domain':
      return copy(
        'noteSharing.domainDetail',
        `Anyone at ${domains.join(', ')} with the link can view`,
        { domains: domains.join(', ') },
      );
    case 'invited':
      return copy('noteSharing.invitedDetail', 'Only people you add can open it');
    default:
      return isTeamNote
        ? copy('noteSharing.teamPrivateDetail', 'Not shared outside this space')
        : copy('noteSharing.privateDetail', 'Not shared with anyone');
  }
}

/** Announces each new message to VoiceOver. */
function useAnnouncement(text: string | null): void {
  useEffect(() => {
    if (text) AccessibilityInfo.announceForAccessibility(text);
  }, [text]);
}

/** Explanatory text as the first row of a card. */
function MessageRow({
  children,
  tone = 'secondary',
}: {
  children: ReactNode;
  tone?: 'secondary' | 'error';
}) {
  return (
    <GroupedList.Row>
      <Text
        accessibilityRole={tone === 'error' ? 'alert' : undefined}
        className={
          tone === 'error' ? 'text-[15px] text-systemRed' : 'text-[15px] text-secondaryLabel'
        }
      >
        {children}
      </Text>
    </GroupedList.Row>
  );
}

function LoadingRow({ label }: { label: string }) {
  return (
    <GroupedList.Row>
      <View className="flex-row items-center gap-2">
        <ActivityIndicator size="small" />
        <Text
          className={
            Platform.OS === 'android'
              ? 'min-w-0 flex-1 text-[15px] text-secondaryLabel'
              : 'text-[15px] text-secondaryLabel'
          }
        >
          {label}
        </Text>
      </View>
    </GroupedList.Row>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="px-1 text-[13px] uppercase tracking-wider text-secondaryLabel">
      {children}
    </Text>
  );
}

/** Supporting text under a card, like a grouped list's section footer. */
function SectionFooter({ children }: { children: ReactNode }) {
  return <Text className="px-4 text-[12px] text-secondaryLabel">{children}</Text>;
}

export function NoteShareSheet({ noteId, onClose, onFlushDraft, onExport }: NoteShareSheetProps) {
  const { copy } = useAndroidCopy();
  const visibilityLabel: Record<ShareVisibility, string> = {
    private: copy('noteSharing.onlyYou', 'Only you'),
    link: copy('noteSharing.anyoneLink', 'Anyone with the link'),
    domain: copy('noteSharing.organization', 'Your organization'),
    invited: copy('noteSharing.invited', 'Invited people'),
  };
  const sharing = useNoteSharing(noteId, onFlushDraft);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const cloudBackupEnabled = useConfigStore((state) => state.config?.cloudBackupEnabled ?? true);
  const setNotePrivacy = useNotesStore((state) => state.setNotePrivacy);
  const spaces = useNotesStore((state) => state.spaces);
  const usage = useUsageStore((state) => state.usage);
  const subscriptionRequired = useSyncStore((state) => state.subscriptionRequired);
  const { register: registerSuperwallGate } = useSuperwallGate();
  const [email, setEmail] = useState('');
  const [privacyFailed, setPrivacyFailed] = useState(false);
  const privacyError = privacyFailed
    ? copy('noteSharing.enableFailed', 'Unable to enable cloud sync. Try again.')
    : null;
  const businessDomain = emailDomain(sharing.user?.email ?? '');
  const domainEligible = Boolean(businessDomain && !isPersonalEmailDomain(businessDomain));
  const note = sharing.note;
  const signedOut = !sharing.user || sharing.user.isAnonymous;
  const privateNote = note?.isPrivate === 1;
  const isTeamNote = spaces.some((space) => space.id === note?.spaceId && space.kind === 'team');
  // With backup off, an uploaded note's existing sharing stays manageable, but nothing that
  // needs a fresh upload (new links, invitations, visibility changes) can succeed.
  const backupOff = !cloudBackupEnabled && !isTeamNote;
  const localOnly = privateNote || (backupOff && !note?.remoteId);
  // A running operation loads the settings itself, including right after the note's first upload.
  const unknown = Boolean(
    note?.remoteId &&
      !sharing.state &&
      !sharing.loading &&
      !sharing.busy &&
      !localOnly &&
      !signedOut,
  );
  const canManage = sharing.state?.access.can_manage_access !== false;
  const visibility = sharing.state?.share.visibility;
  const shared = Boolean(visibility && visibility !== 'private');
  const canDisablePrevious = Boolean(privateNote && note?.remoteId && shared && canManage);
  // Adding someone to a paused share turns it back on, which restores everyone it paused.
  const pausedAccess =
    visibility === 'private' &&
    Boolean(sharing.state?.access.grants.some((grant) => !isScopeGrant(grant)));
  // Uploading a personal note is what needs Pro; a note already in the cloud stays manageable.
  const upgradeRequired =
    (usage ? !usage.isSubscribed : subscriptionRequired) && !isTeamNote && !note?.remoteId;
  // New edits to a note already in the cloud still need Pro to sync before they can be shared.
  const editsNeedPro =
    (usage ? !usage.isSubscribed : subscriptionRequired) && !isTeamNote && Boolean(note?.remoteId);
  const managed = !signedOut && !localOnly && !upgradeRequired && !sharing.loading && !unknown;
  const allowed = (target: ShareVisibility): boolean =>
    isShareVisibilityAllowed(sharing.sharingMode, target);
  const offered = (target: ShareVisibility): boolean => visibility === target || allowed(target);
  const linkManaged = Boolean(visibility && shared && canManage && allowed(visibility));
  const canAddPeople = canManage && !backupOff && allowed('invited');
  const scrollContentStyle = { paddingHorizontal: 24, paddingBottom: insets.bottom + 24, gap: 18 };
  // Hex literal: the native menu can't serialize PlatformColor.
  const menuIconColor = scheme === 'dark' ? 'rgba(255, 255, 255, 0.95)' : 'rgba(0, 0, 0, 0.85)';
  // Waiting for the upload can be abandoned; a sharing change in flight must finish to keep its link.
  const closable = !sharing.busy || sharing.cancellable;
  const close = (): void => {
    if (closable) onClose();
  };
  useAnnouncement(sharing.error);
  useAnnouncement(privacyError);
  useAnnouncement(sharing.message);
  const openPrivacySettings = (): void => {
    onClose();
    router.push('/(account)/privacy');
  };

  const changeVisibility = (target: ShareVisibility): void => {
    if (sharing.busy || !canManage || target === visibility) return;
    if (target === 'private') {
      confirmDestructive(
        copy('noteSharing.disableTitle', 'Disable external sharing?'),
        copy(
          'noteSharing.disableBody',
          'Links stop working, and people you added and invited lose access. Sharing again creates a new link and restores people you added; resend invitations so their emailed links work. Access through a team space or workspace is unaffected.',
        ),
        () => sharing.setVisibility('private'),
        {
          cancelLabel: copy('cancel', 'Cancel'),
          destructiveLabel: copy('noteSharing.disable', 'Disable external sharing'),
        },
      );
      return;
    }
    const apply = (): void => {
      if (target === 'domain') sharing.setVisibility(target, [businessDomain]);
      else sharing.setVisibility(target);
    };
    if (
      !visibility ||
      visibility === 'private' ||
      VISIBILITY_REACH[target] <= VISIBILITY_REACH[visibility]
    ) {
      apply();
      return;
    }
    // The existing token survives the switch, so links already sent reach the wider audience.
    Alert.alert(
      target === 'link'
        ? copy('noteSharing.publicTitle', 'Make this note public?')
        : copy('noteSharing.domainTitle', `Share with ${businessDomain}?`, {
            domain: businessDomain,
          }),
      target === 'link'
        ? copy(
            'noteSharing.publicBody',
            'Anyone with the link will be able to view this note, including anyone you already sent a link to.',
          )
        : copy(
            'noteSharing.domainBody',
            `Anyone signed in with an ${businessDomain} email will be able to view this note with its link.`,
            { domain: businessDomain },
          ),
      [
        { text: copy('cancel', 'Cancel'), style: 'cancel' },
        {
          text:
            target === 'link'
              ? copy('noteSharing.makePublic', 'Make public')
              : copy('noteSharing.share', 'Share'),
          onPress: apply,
        },
      ],
    );
  };

  const enableCloudSync = (): void => {
    Alert.alert(
      copy('noteSharing.enableTitle', 'Enable cloud sync?'),
      copy(
        'noteSharing.enableBody',
        'This note will be uploaded to your account. Sharing will still require a separate action.',
      ),
      [
        { text: copy('cancel', 'Cancel'), style: 'cancel' },
        {
          text: copy('noteSharing.enable', 'Enable cloud sync'),
          onPress: async () => {
            setPrivacyFailed(false);
            try {
              await setNotePrivacy(noteId, false);
            } catch {
              setPrivacyFailed(true);
            }
          },
        },
      ],
    );
  };

  const replaceLink = (): void => {
    confirmDestructive(
      copy('noteSharing.replaceTitle', 'Replace link?'),
      copy(
        'noteSharing.replaceBody',
        'The previous link will stop working, including links already sent in invitation emails. Share the new link with anyone who still needs access.',
      ),
      () => sharing.replaceLink(),
      {
        cancelLabel: copy('cancel', 'Cancel'),
        destructiveLabel: copy('noteSharing.replace', 'Replace link'),
      },
    );
  };

  const resumeSharing = (add: () => void): void => {
    if (!pausedAccess) {
      add();
      return;
    }
    Alert.alert(
      copy('noteSharing.resumeTitle', 'Turn sharing back on?'),
      copy(
        'noteSharing.resumeBody',
        'Adding someone turns external sharing back on, so people you added or invited before get their access back.',
      ),
      [
        { text: copy('cancel', 'Cancel'), style: 'cancel' },
        { text: copy('noteSharing.resume', 'Turn on sharing'), onPress: add },
      ],
    );
  };

  const invite = (): void => {
    const address = email.trim();
    if (!address || sharing.busy) return;
    const send = async (): Promise<void> => {
      if (await sharing.inviteEmail(email)) setEmail('');
    };
    // An invalid address is reported straight away rather than after the confirmation.
    if (isValidEmail(address)) resumeSharing(send);
    else send();
  };

  const upgrade = (): void => {
    registerSuperwallGate({
      placement: SUPERWALL_PLACEMENTS.cloudSyncRequired,
      params: { source: 'note_share_sheet', isSubscribed: usage?.isSubscribed ?? false },
      feature: () => {
        useUsageStore
          .getState()
          .load(true)
          .catch(() => {})
          .finally(() => requestSync('manual'));
      },
    }).catch(() => {});
  };

  const accessMenu: MenuAction[] = [];
  if (canManage && !backupOff) {
    const choices = VISIBILITY_CHOICES.filter((target) =>
      target === 'domain' ? domainEligible && offered('domain') : offered(target),
    );
    if (choices.length > 0) {
      accessMenu.push({
        id: 'visibility',
        title: '',
        displayInline: true,
        subactions: choices.map((target) => ({
          id: `${VISIBILITY_ACTION_PREFIX}${target}`,
          title:
            target === 'invited'
              ? copy('noteSharing.invitedOnly', 'Invited people only')
              : visibilityLabel[target],
          subtitle: target === 'domain' ? businessDomain : undefined,
          image: VISIBILITY_ICON[target][0],
          imageColor: menuIconColor,
          state: visibility === target ? 'on' : 'off',
          attributes: { disabled: sharing.busy },
        })),
      });
    }
  }
  const linkActions: MenuAction[] = [];
  if (linkManaged && !backupOff) {
    linkActions.push({
      id: REPLACE_LINK_ID,
      title: copy('noteSharing.replace', 'Replace link'),
      image: 'arrow.triangle.2.circlepath',
      imageColor: menuIconColor,
      attributes: { disabled: sharing.busy },
    });
  }
  if (shared && canManage) {
    linkActions.push({
      id: DISABLE_SHARING_ID,
      title: copy('noteSharing.disable', 'Disable external sharing'),
      image: 'lock',
      imageColor: '#FF3B30',
      attributes: { destructive: true, disabled: sharing.busy },
    });
  }
  if (linkActions.length > 0) {
    accessMenu.push({ id: 'link', title: '', displayInline: true, subactions: linkActions });
  }

  const pressAccessMenu = (id: string): void => {
    if (id === REPLACE_LINK_ID) replaceLink();
    else if (id === DISABLE_SHARING_ID) changeVisibility('private');
    else if (id.startsWith(VISIBILITY_ACTION_PREFIX))
      changeVisibility(id.slice(VISIBILITY_ACTION_PREFIX.length) as ShareVisibility);
  };

  const accessTitle =
    shared || !isTeamNote
      ? visibilityLabel[visibility ?? 'private']
      : copy('noteSharing.teamEveryone', 'Everyone in this team space');
  const accessDetail = pausedAccess
    ? copy('noteSharing.paused', 'External sharing is off')
    : describeAccess(visibility, sharing.state?.share.domain_allowlist ?? [], isTeamNote, copy);
  const [accessIcon, accessMdIcon] = VISIBILITY_ICON[shared && visibility ? visibility : 'private'];
  const accessRowContent = (
    <View className="flex-row items-center gap-3 px-4 py-3">
      <RowIcon name={accessIcon} mdName={accessMdIcon} tone="brand" />
      <View className="min-w-0 flex-1">
        <Text className="text-[15px] font-medium text-label">{accessTitle}</Text>
        <Text className="text-[12px] text-secondaryLabel">{accessDetail}</Text>
      </View>
      {accessMenu.length > 0 && (
        <SystemIcon
          name="chevron.up.chevron.down"
          mdName="ChevronsUpDown"
          size={13}
          color={sharing.busy ? 'quaternaryLabel' : 'tertiaryLabel'}
        />
      )}
    </View>
  );
  const accessRow =
    accessMenu.length > 0 ? (
      <MenuView
        actions={noteShareMenuActions(accessMenu)}
        onPressAction={({ nativeEvent }) => pressAccessMenu(nativeEvent.event)}
        shouldOpenOnLongPress={false}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy('noteSharing.general', 'General access')}
          accessibilityValue={{ text: `${accessTitle}. ${accessDetail}` }}
          accessibilityHint={copy('noteSharing.generalHint', 'Changes who can open this note')}
          className="active:bg-tertiarySystemFill"
        >
          {accessRowContent}
        </Pressable>
      </MenuView>
    ) : (
      <View
        accessible
        accessibilityLabel={copy(
          'noteSharing.generalLabel',
          `General access: ${accessTitle}. ${accessDetail}`,
          { title: accessTitle, detail: accessDetail },
        )}
      >
        {accessRowContent}
      </View>
    );

  let accessStrip: ReactNode = null;
  if (linkManaged && sharing.hasLink) {
    accessStrip = (
      <ShareActionStrip
        disabled={sharing.busy}
        actions={[
          {
            label: copy('noteSharing.copyLink', 'Copy link'),
            icon: 'doc.on.doc',
            mdIcon: 'Copy',
            onPress: () => sharing.copyLink(),
          },
          {
            label: copy('noteSharing.share', 'Share'),
            accessibilityLabel: copy('noteSharing.shareLink', 'Share link'),
            icon: 'square.and.arrow.up',
            mdIcon: 'Share',
            onPress: () => sharing.shareLink(),
          },
          {
            label: copy('noteSharing.open', 'Open'),
            accessibilityLabel: copy('noteSharing.openBrowser', 'Open in browser'),
            icon: 'safari',
            mdIcon: 'Compass',
            onPress: () => sharing.openLink(),
          },
        ]}
      />
    );
  } else if (linkManaged) {
    accessStrip = (
      <Text className="px-4 py-3 text-[13px] text-secondaryLabel">
        {backupOff
          ? copy('noteSharing.missingLink', 'The full link isn’t saved on this device.')
          : copy(
              'noteSharing.missingLinkReplace',
              'The full link isn’t saved on this device. Replace it to get a new one.',
            )}
      </Text>
    );
  } else if (!shared && canManage && !backupOff && allowed('link')) {
    accessStrip = (
      <ShareActionStrip
        disabled={sharing.busy}
        actions={[
          {
            label: copy('noteSharing.createLink', 'Create link'),
            icon: 'link',
            mdIcon: 'Link',
            onPress: () => changeVisibility('link'),
          },
        ]}
      />
    );
  }

  // In the sharing view, feedback sits next to the controls that trigger it rather than below the list.
  const feedback: ReactNode = (
    <>
      {sharing.error && !unknown && !(privateNote && note?.remoteId) && (
        <View className="gap-1 px-1">
          <Text accessibilityRole="alert" className="text-[13px] text-systemRed">
            {sharing.error}
          </Text>
          <View className="flex-row flex-wrap gap-x-6">
            {managed && editsNeedPro && (
              <ShareTextButton
                label={copy('noteSharing.upgrade', 'Upgrade to Pro')}
                onPress={upgrade}
              />
            )}
            {managed && note?.remoteId && (
              <ShareTextButton
                label={copy('noteSharing.refresh', 'Refresh')}
                accessibilityLabel={copy('noteSharing.refreshLabel', 'Refresh sharing settings')}
                disabled={sharing.busy}
                onPress={() => sharing.refresh()}
              />
            )}
          </View>
        </View>
      )}
      {privacyError && (
        <Text accessibilityRole="alert" className="px-1 text-[13px] text-systemRed">
          {privacyError}
        </Text>
      )}
      {sharing.message && (
        <Text accessibilityRole="alert" className="px-1 text-[13px] text-secondaryLabel">
          {sharing.message}
        </Text>
      )}
    </>
  );

  const inviteField = canAddPeople ? (
    <NoteShareInviteField
      value={email}
      onChangeText={(value) => {
        setEmail(value);
        if (sharing.errorCode === 'invalidEmail') sharing.dismissError();
      }}
      onInvite={invite}
      remoteId={note?.remoteId ?? undefined}
      access={sharing.state?.access}
      invitations={sharing.state?.invitations}
      busy={sharing.busy}
      onAddPrincipal={(principal) => {
        setEmail('');
        resumeSharing(() => sharing.addPrincipal(principal));
      }}
    />
  ) : null;

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <View className="flex-1 bg-systemBackground">
        <View
          className="flex-row items-center justify-between px-6 pb-4 pt-8"
          style={Platform.OS === 'android' ? { paddingTop: insets.top + 20 } : undefined}
        >
          <Text
            accessibilityRole="header"
            className={
              Platform.OS === 'android'
                ? 'min-w-0 flex-1 text-[22px] font-bold text-label'
                : 'text-[22px] font-bold text-label'
            }
          >
            {copy('noteSharing.title', 'Share note')}
          </Text>
          {closable && (
            <GlassIconButton
              onPress={close}
              accessibilityLabel={copy('noteSharing.close', 'Close share sheet')}
            >
              <SystemIcon name="xmark" mdName="X" size={15} color="secondaryLabel" />
            </GlassIconButton>
          )}
        </View>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={scrollContentStyle}
        >
          {sharing.busy && (
            <View className="flex-row items-center gap-2 px-1" accessibilityRole="alert">
              <ActivityIndicator size="small" />
              <Text
                className={
                  Platform.OS === 'android'
                    ? 'min-w-0 flex-1 text-[13px] text-secondaryLabel'
                    : 'text-[13px] text-secondaryLabel'
                }
              >
                {copy('noteSharing.updating', 'Updating sharing…')}
              </Text>
            </View>
          )}
          {signedOut ? (
            <GroupedList dividerInset={16}>
              <MessageRow>
                {copy('noteSharing.signInBody', 'Sign in to share this note online.')}
              </MessageRow>
              <ShareActionRow
                label={copy('signIn', 'Sign in')}
                accessibilityLabel={copy('noteSharing.signInLabel', 'Sign in to share')}
                onPress={() => {
                  onClose();
                  router.push('/auth');
                }}
              />
            </GroupedList>
          ) : localOnly ? (
            <GroupedList dividerInset={16}>
              <MessageRow>
                {backupOff
                  ? copy(
                      'noteSharing.backupOffBody',
                      'Cloud backup is off. Turn it on in Privacy & Data to share personal notes.',
                    )
                  : copy(
                      'noteSharing.enableFirst',
                      'Enable cloud sync for this note before sharing.',
                    )}
              </MessageRow>
              {note?.remoteId && !sharing.loading && (
                <MessageRow>
                  {shared
                    ? copy('noteSharing.oldLink', 'A previous link may still be active.')
                    : copy(
                        'noteSharing.oldCopy',
                        'Removal of a previous cloud copy may still be pending.',
                      )}
                </MessageRow>
              )}
              {sharing.loading && note?.remoteId && (
                <LoadingRow label={copy('noteSharing.checking', 'Checking previous sharing…')} />
              )}
              {sharing.error && note?.remoteId && (
                <MessageRow tone="error">{sharing.error}</MessageRow>
              )}
              {sharing.error && note?.remoteId && (
                <ShareActionRow label={copy('retry', 'Retry')} onPress={() => sharing.refresh()} />
              )}
              {canDisablePrevious && (
                <ShareActionRow
                  label={copy('noteSharing.disablePrevious', 'Disable previous link')}
                  destructive
                  disabled={sharing.busy || sharing.loading}
                  onPress={() => changeVisibility('private')}
                />
              )}
              {backupOff ? (
                <ShareActionRow
                  label={copy('noteSharing.privacySettings', 'Open privacy settings')}
                  disabled={sharing.busy}
                  onPress={openPrivacySettings}
                />
              ) : (
                <ShareActionRow
                  label={copy('noteSharing.enable', 'Enable cloud sync')}
                  accessibilityLabel={copy(
                    'noteSharing.enableLabel',
                    'Enable cloud sync for this note',
                  )}
                  disabled={sharing.busy}
                  onPress={enableCloudSync}
                />
              )}
            </GroupedList>
          ) : upgradeRequired ? (
            <GroupedList dividerInset={16}>
              <MessageRow>
                {copy(
                  'noteSharing.upgradeBody',
                  'Sharing uploads this note to your cloud account, which requires Pro.',
                )}
              </MessageRow>
              <ShareActionRow
                label={copy('noteSharing.upgrade', 'Upgrade to Pro')}
                onPress={upgrade}
              />
            </GroupedList>
          ) : sharing.loading ? (
            <View className="flex-row items-center gap-3 px-1 py-3">
              <ActivityIndicator />
              <Text
                className={
                  Platform.OS === 'android'
                    ? 'min-w-0 flex-1 text-secondaryLabel'
                    : 'text-secondaryLabel'
                }
              >
                {copy('noteSharing.loading', 'Loading sharing settings…')}
              </Text>
            </View>
          ) : unknown ? (
            <GroupedList dividerInset={16}>
              <MessageRow>
                {sharing.error ||
                  copy('noteSharing.unavailable', 'Sharing settings are unavailable.')}
              </MessageRow>
              <ShareActionRow label={copy('retry', 'Retry')} onPress={() => sharing.refresh()} />
            </GroupedList>
          ) : (
            <>
              {backupOff && (
                <GroupedList dividerInset={16}>
                  <MessageRow>
                    {copy(
                      'noteSharing.backupOffManage',
                      'Cloud backup is off. Turn it on in Privacy & Data to change who this note is shared with.',
                    )}
                  </MessageRow>
                  <ShareActionRow
                    label={copy('noteSharing.privacySettings', 'Open privacy settings')}
                    disabled={sharing.busy}
                    onPress={openPrivacySettings}
                  />
                </GroupedList>
              )}
              <View className="gap-2">
                <SectionLabel>{copy('noteSharing.general', 'General access')}</SectionLabel>
                <GroupedList dividerInset={0}>
                  {accessRow}
                  {accessStrip}
                </GroupedList>
                {canManage && !backupOff && sharing.sharingMode === 'domain_only' && (
                  <SectionFooter>
                    {copy(
                      'noteSharing.domainPolicy',
                      'Your organization only allows sharing within your company domain.',
                    )}
                  </SectionFooter>
                )}
                {canManage && !backupOff && sharing.sharingMode === 'disabled' && (
                  <SectionFooter>
                    {copy(
                      'noteSharing.disabledPolicy',
                      'Your organization does not allow sharing notes outside it.',
                    )}
                  </SectionFooter>
                )}
              </View>
              {feedback}
              {sharing.state ? (
                <NoteShareAccessList
                  key={`${sharing.user?.id}:${note?.remoteId}`}
                  access={sharing.state.access}
                  invitations={sharing.state.invitations}
                  paused={visibility === 'private'}
                  canInvite={allowed('invited')}
                  busy={sharing.busy}
                  inviteField={inviteField}
                  onUpdateGrant={(grant, permission) => sharing.updateGrant(grant, permission)}
                  onRemoveGrant={(grant) => sharing.removeGrant(grant)}
                  onRevokeInvitation={(invitation) => sharing.revokeInvitation(invitation)}
                  onResendInvitation={(invitation) => sharing.resendInvitation(invitation)}
                />
              ) : (
                inviteField && (
                  <View className="gap-2">
                    <SectionLabel>{copy('noteSharing.invitePeople', 'Invite people')}</SectionLabel>
                    <GroupedList>{inviteField}</GroupedList>
                  </View>
                )
              )}
            </>
          )}
          {!managed && feedback}
          <View className="gap-2">
            <SectionLabel>{copy('noteSharing.export', 'Export')}</SectionLabel>
            <GroupedList>
              <GroupedList.Row
                onPress={() => onExport('md')}
                accessibilityRole="button"
                accessibilityLabel={copy('noteSharing.exportMarkdown', 'Export Markdown')}
                leadingIconSlot={<RowIcon name="doc.richtext" mdName="FileCode" />}
              >
                <Text className="text-[15px] text-label">Markdown</Text>
              </GroupedList.Row>
              <GroupedList.Row
                onPress={() => onExport('txt')}
                accessibilityRole="button"
                accessibilityLabel={copy('noteSharing.exportText', 'Export Plain Text')}
                leadingIconSlot={<RowIcon name="doc.plaintext" mdName="FileText" />}
              >
                <Text className="text-[15px] text-label">
                  {copy('noteSharing.plainText', 'Plain text')}
                </Text>
              </GroupedList.Row>
            </GroupedList>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}
