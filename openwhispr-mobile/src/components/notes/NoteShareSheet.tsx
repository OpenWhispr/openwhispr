import { useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { GlassIconButton } from '@/components/ui/GlassIconButton';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useNoteSharing } from '@/hooks/useNoteSharing';
import { useConfigStore } from '@/store/useConfigStore';
import { useNotesStore } from '@/store/useNotesStore';
import { emailDomain, isPersonalEmailDomain } from '@/lib/notes/noteShareDomains';
import type { ShareVisibility } from '@/data/remote/noteSharingTypes';
import { GroupedList } from './GroupedList';
import { NoteShareAccessList } from './NoteShareAccessList';

export interface NoteShareSheetProps {
  noteId: number;
  visible: boolean;
  onClose: () => void;
  onFlushDraft: () => void;
  onExport: (format: 'md' | 'txt') => void;
}

// Half of the gap between stacked controls, so neighbouring touch targets never overlap.
const MODE_HIT_SLOP = { top: 4, bottom: 4, left: 6, right: 6 };
const VISIBILITY_REACH: Record<ShareVisibility, number> = {
  private: 0,
  invited: 1,
  domain: 2,
  link: 3,
};

const VISIBILITY_LABEL: Record<ShareVisibility, string> = {
  private: 'Only you',
  link: 'Anyone with the link',
  domain: 'Your organization',
  invited: 'Invited people',
};

export function NoteShareSheet({
  noteId,
  visible,
  onClose,
  onFlushDraft,
  onExport,
}: NoteShareSheetProps) {
  const sharing = useNoteSharing(noteId, visible, onFlushDraft);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const cloudBackupEnabled = useConfigStore((state) => state.config?.cloudBackupEnabled ?? true);
  const setNotePrivacy = useNotesStore((state) => state.setNotePrivacy);
  const spaces = useNotesStore((state) => state.spaces);
  const [email, setEmail] = useState('');
  const [privacyError, setPrivacyError] = useState<string | null>(null);
  const businessDomain = emailDomain(sharing.user?.email ?? '');
  const domainEligible = Boolean(businessDomain && !isPersonalEmailDomain(businessDomain));
  const note = sharing.note;
  const signedOut = !sharing.user || sharing.user.isAnonymous;
  const privateNote = note?.isPrivate === 1;
  const isTeamNote = spaces.some((space) => space.id === note?.spaceId && space.kind === 'team');
  const unknown = Boolean(
    note?.remoteId && !sharing.state && !sharing.loading && !privateNote && !signedOut,
  );
  const canManage = sharing.state?.access?.can_manage_access !== false;
  const visibility = sharing.state?.share.visibility;
  const canDisablePrevious = Boolean(
    privateNote && note?.remoteId && visibility && visibility !== 'private' && canManage,
  );
  const scrollContentStyle = { paddingHorizontal: 24, paddingBottom: insets.bottom + 24, gap: 18 };
  const close = (): void => {
    if (!sharing.busy) onClose();
  };

  const changeVisibility = (target: ShareVisibility): void => {
    if (sharing.busy || !canManage || target === visibility) return;
    if (target === 'private') {
      Alert.alert(
        'Disable external sharing?',
        'Links stop working, and people you added and invited lose access. Sharing again creates a new link and restores people you added; resend invitations so their emailed links work. Access through a team space or workspace is unaffected.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Disable external sharing',
            style: 'destructive',
            onPress: () => sharing.setVisibility('private'),
          },
        ],
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
      target === 'link' ? 'Make this note public?' : `Share with ${businessDomain}?`,
      target === 'link'
        ? 'Anyone with the link will be able to view this note, including anyone you already sent a link to.'
        : `Anyone signed in with an ${businessDomain} email will be able to view this note with its link.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: target === 'link' ? 'Make public' : 'Share', onPress: apply },
      ],
    );
  };

  const modeButton = (target: ShareVisibility, label: string): ReactNode => {
    const selected = visibility === target;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected, disabled: sharing.busy || selected }}
        className="py-1.5"
        hitSlop={MODE_HIT_SLOP}
        onPress={() => changeVisibility(target)}
        disabled={sharing.busy || selected}
      >
        <Text className={selected ? 'font-semibold text-label' : 'text-link'}>{label}</Text>
      </Pressable>
    );
  };

  const enableCloudSync = (): void => {
    Alert.alert(
      'Enable cloud sync?',
      'This note will be uploaded to your account. Sharing will still require a separate action.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Enable cloud sync',
          onPress: async () => {
            setPrivacyError(null);
            try {
              await setNotePrivacy(noteId, false);
            } catch (error) {
              setPrivacyError(
                error instanceof Error ? error.message : 'Unable to enable cloud sync.',
              );
            }
          },
        },
      ],
    );
  };

  const replaceLink = (): void => {
    Alert.alert(
      'Replace link?',
      'The previous link will stop working. Anyone with the old link will need the new one.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Replace link', style: 'destructive', onPress: () => sharing.replaceLink() },
      ],
    );
  };

  const invite = (): void => {
    if (!email.trim() || sharing.busy) return;
    sharing.inviteEmail(email);
  };

  const sectionLabel = (label: string): ReactNode => (
    <Text className="px-1 text-[13px] uppercase tracking-wider text-secondaryLabel">{label}</Text>
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={close}
    >
      <View className="flex-1 bg-systemBackground">
        <View className="flex-row items-center justify-between px-6 pb-4 pt-8">
          <Text className="text-[22px] font-bold text-label">Share note</Text>
          {!sharing.busy && (
            <GlassIconButton onPress={close} accessibilityLabel="Close share sheet">
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
            <View className="flex-row items-center gap-2" accessibilityRole="alert">
              <ActivityIndicator size="small" />
              <Text className="text-[13px] text-secondaryLabel">Updating sharing…</Text>
            </View>
          )}
          {signedOut ? (
            <View className="gap-3">
              <Text className="text-secondaryLabel">Sign in to share this note online.</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Sign in to share"
                onPress={() => {
                  onClose();
                  router.push('/auth');
                }}
              >
                <Text className="text-link">Sign in</Text>
              </Pressable>
            </View>
          ) : privateNote ? (
            <View className="gap-3">
              <Text className="text-secondaryLabel">
                {!cloudBackupEnabled && !isTeamNote
                  ? 'Cloud backup is off. Turn it on in Settings before sharing this note.'
                  : 'Enable cloud sync for this note before sharing.'}
              </Text>
              {note?.remoteId && (
                <Text className="text-[13px] text-secondaryLabel">
                  {visibility && visibility !== 'private'
                    ? 'A previous link may still be active.'
                    : 'Removal of a previous cloud copy may still be pending.'}
                </Text>
              )}
              {sharing.loading && note?.remoteId && (
                <View className="flex-row items-center gap-2">
                  <ActivityIndicator size="small" />
                  <Text className="text-[13px] text-secondaryLabel">
                    Checking previous sharing…
                  </Text>
                </View>
              )}
              {sharing.error && note?.remoteId && (
                <View className="gap-2">
                  <Text accessibilityRole="alert" className="text-systemRed">
                    {sharing.error}
                  </Text>
                  <Pressable accessibilityRole="button" onPress={() => sharing.refresh()}>
                    <Text className="text-link">Retry</Text>
                  </Pressable>
                </View>
              )}
              {canDisablePrevious && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Disable previous link"
                  disabled={sharing.busy || sharing.loading}
                  onPress={() => changeVisibility('private')}
                >
                  <Text
                    className={
                      sharing.busy || sharing.loading ? 'text-tertiaryLabel' : 'text-systemRed'
                    }
                  >
                    Disable previous link
                  </Text>
                </Pressable>
              )}
              {!cloudBackupEnabled && !isTeamNote ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    onClose();
                    router.push('/(account)/privacy');
                  }}
                >
                  <Text className="text-link">Open privacy settings</Text>
                </Pressable>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Enable cloud sync for this note"
                  disabled={sharing.busy}
                  onPress={enableCloudSync}
                >
                  <Text className="text-link">Enable cloud sync</Text>
                </Pressable>
              )}
            </View>
          ) : !cloudBackupEnabled && !isTeamNote && !note?.remoteId ? (
            <View className="gap-3">
              <Text className="text-secondaryLabel">
                Cloud backup is off. Turn it on in Settings to share personal notes.
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  onClose();
                  router.push('/(account)/privacy');
                }}
              >
                <Text className="text-link">Open privacy settings</Text>
              </Pressable>
            </View>
          ) : sharing.loading ? (
            <View className="flex-row items-center gap-3 py-3">
              <ActivityIndicator />
              <Text className="text-secondaryLabel">Loading sharing settings…</Text>
            </View>
          ) : unknown ? (
            <View className="gap-3">
              <Text className="text-secondaryLabel">
                {sharing.error || 'Sharing settings are unavailable.'}
              </Text>
              <Pressable accessibilityRole="button" onPress={() => sharing.refresh()}>
                <Text className="text-link">Retry</Text>
              </Pressable>
            </View>
          ) : (
            <>
              {sectionLabel('General access')}
              <GroupedList dividerInset={16}>
                <GroupedList.Row>
                  <Text className="text-[15px] font-medium text-label">
                    {VISIBILITY_LABEL[visibility ?? 'private']}
                  </Text>
                  {visibility === 'domain' && (
                    <Text className="text-[12px] text-secondaryLabel">
                      {sharing.state?.share.domain_allowlist.join(', ')}
                    </Text>
                  )}
                </GroupedList.Row>
              </GroupedList>
              {canManage && (
                <View className="gap-2">
                  {(!visibility || visibility === 'private') && (
                    <Text className="text-[13px] text-secondaryLabel">
                      Anyone with the link can view this note.
                    </Text>
                  )}
                  {(!visibility || visibility === 'private') && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Create link"
                      className="py-1.5"
                      hitSlop={MODE_HIT_SLOP}
                      disabled={sharing.busy}
                      onPress={() => changeVisibility('link')}
                    >
                      <Text className={sharing.busy ? 'text-tertiaryLabel' : 'text-link'}>
                        Create link
                      </Text>
                    </Pressable>
                  )}
                  {visibility && visibility !== 'private' && (
                    <View className="flex-row flex-wrap gap-4">
                      {modeButton('link', 'Anyone with link')}
                      {modeButton('invited', 'Invited only')}
                      {domainEligible && modeButton('domain', `Organization (${businessDomain})`)}
                    </View>
                  )}
                  {(!visibility || visibility === 'private') && (
                    <View className="flex-row flex-wrap gap-4">
                      {modeButton('invited', 'Invite only')}
                      {domainEligible && modeButton('domain', `Organization (${businessDomain})`)}
                    </View>
                  )}
                </View>
              )}
              {visibility && visibility !== 'private' && canManage && (
                <View className="gap-2">
                  {sectionLabel('Link')}
                  {sharing.hasToken ? (
                    <View className="flex-row flex-wrap gap-4">
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => sharing.shareLink()}
                        disabled={sharing.busy}
                      >
                        <Text className="text-link">Share link</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => sharing.copyLink()}
                        disabled={sharing.busy}
                      >
                        <Text className="text-link">Copy link</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => sharing.openLink()}
                        disabled={sharing.busy}
                      >
                        <Text className="text-link">Open in browser</Text>
                      </Pressable>
                    </View>
                  ) : (
                    <View className="gap-2">
                      <Text className="text-[13px] text-secondaryLabel">
                        The full link is unavailable on this device.
                      </Text>
                    </View>
                  )}
                  <Pressable
                    accessibilityRole="button"
                    onPress={replaceLink}
                    disabled={sharing.busy}
                  >
                    <Text className="text-link">Replace link</Text>
                  </Pressable>
                </View>
              )}
              {canManage && (sharing.state || !note?.remoteId) && (
                <View className="gap-2">
                  {sectionLabel('Invite by email')}
                  <View className="flex-row items-center gap-2">
                    <TextInput
                      accessibilityLabel="Email address"
                      className="min-w-0 flex-1 rounded-lg border border-separator bg-secondarySystemGroupedBackground px-3 py-2 text-label"
                      placeholder="name@example.com"
                      autoCapitalize="none"
                      keyboardType="email-address"
                      value={email}
                      onChangeText={setEmail}
                      onSubmitEditing={invite}
                    />
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Invite email"
                      disabled={sharing.busy || !email.trim()}
                      onPress={invite}
                    >
                      <Text
                        className={
                          sharing.busy || !email.trim() ? 'text-tertiaryLabel' : 'text-link'
                        }
                      >
                        Invite
                      </Text>
                    </Pressable>
                  </View>
                </View>
              )}
              {sharing.state && (
                <NoteShareAccessList
                  key={`${sharing.user?.id}:${note?.remoteId}`}
                  remoteId={note?.remoteId ?? undefined}
                  access={sharing.state.access}
                  invitations={sharing.state.invitations}
                  paused={visibility === 'private'}
                  busy={sharing.busy}
                  onAddPrincipal={(principal) => sharing.addPrincipal(principal)}
                  onUpdateGrant={(grant, permission) => sharing.updateGrant(grant, permission)}
                  onRemoveGrant={(grant) => sharing.removeGrant(grant)}
                  onRevokeInvitation={(invitation) => sharing.revokeInvitation(invitation)}
                  onResendInvitation={(invitation) => sharing.resendInvitation(invitation)}
                />
              )}
              {visibility && visibility !== 'private' && canManage && (
                <Pressable
                  accessibilityRole="button"
                  disabled={sharing.busy}
                  onPress={() => changeVisibility('private')}
                >
                  <Text className="text-systemRed">Disable external sharing</Text>
                </Pressable>
              )}
            </>
          )}
          {sharing.error && !unknown && !(privateNote && note?.remoteId) && (
            <Text accessibilityRole="alert" className="text-systemRed">
              {sharing.error}
            </Text>
          )}
          {privacyError && (
            <Text accessibilityRole="alert" className="text-systemRed">
              {privacyError}
            </Text>
          )}
          {sharing.message && (
            <Text accessibilityRole="alert" className="text-secondaryLabel">
              {sharing.message}
            </Text>
          )}
          <View className="gap-2">
            {sectionLabel('Export')}
            <GroupedList dividerInset={16}>
              <GroupedList.Row
                onPress={() => onExport('md')}
                accessibilityRole="button"
                accessibilityLabel="Export Markdown"
              >
                <Text className="text-[15px] text-label">Export Markdown</Text>
              </GroupedList.Row>
              <GroupedList.Row
                onPress={() => onExport('txt')}
                accessibilityRole="button"
                accessibilityLabel="Export Plain Text"
              >
                <Text className="text-[15px] text-label">Export Plain Text</Text>
              </GroupedList.Row>
            </GroupedList>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}
