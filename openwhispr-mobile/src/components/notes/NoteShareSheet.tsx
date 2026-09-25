import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Modal, ScrollView, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { GlassIconButton } from '@/components/ui/GlassIconButton';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useNoteSharing } from '@/hooks/useNoteSharing';
import { useSuperwallGate } from '@/hooks/useSuperwallGate';
import { SUPERWALL_PLACEMENTS } from '@/lib/superwall';
import { useConfigStore } from '@/store/useConfigStore';
import { useNotesStore } from '@/store/useNotesStore';
import { useUsageStore } from '@/store/useUsageStore';
import { requestSync } from '@/sync/syncEngine';
import { useSyncStore } from '@/sync/useSyncStore';
import { emailDomain, isPersonalEmailDomain } from '@/lib/notes/noteShareDomains';
import { isShareVisibilityAllowed } from '@/lib/notes/noteSharePolicy';
import type { ShareVisibility } from '@/data/remote/noteSharingTypes';
import { GroupedList } from './GroupedList';
import { NoteShareAccessList } from './NoteShareAccessList';
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

const VISIBILITY_LABEL: Record<ShareVisibility, string> = {
  private: 'Only you',
  link: 'Anyone with the link',
  domain: 'Your organization',
  invited: 'Invited people',
};

export function NoteShareSheet({ noteId, onClose, onFlushDraft, onExport }: NoteShareSheetProps) {
  const sharing = useNoteSharing(noteId, onFlushDraft);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const cloudBackupEnabled = useConfigStore((state) => state.config?.cloudBackupEnabled ?? true);
  const setNotePrivacy = useNotesStore((state) => state.setNotePrivacy);
  const spaces = useNotesStore((state) => state.spaces);
  const usage = useUsageStore((state) => state.usage);
  const subscriptionRequired = useSyncStore((state) => state.subscriptionRequired);
  const { register: registerSuperwallGate } = useSuperwallGate();
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
  const canManage = sharing.state?.access.can_manage_access !== false;
  const visibility = sharing.state?.share.visibility;
  const shared = Boolean(visibility && visibility !== 'private');
  const canDisablePrevious = Boolean(privateNote && note?.remoteId && shared && canManage);
  // Uploading a personal note is what needs Pro; a note already in the cloud stays manageable.
  const upgradeRequired =
    (usage ? !usage.isSubscribed : subscriptionRequired) && !isTeamNote && !note?.remoteId;
  const allowed = (target: ShareVisibility): boolean =>
    isShareVisibilityAllowed(sharing.sharingMode, target);
  const offered = (target: ShareVisibility): boolean => visibility === target || allowed(target);
  const scrollContentStyle = { paddingHorizontal: 24, paddingBottom: insets.bottom + 24, gap: 18 };
  // Waiting for the upload can be abandoned; a sharing change in flight must finish to keep its link.
  const closable = !sharing.busy || sharing.cancellable;
  const close = (): void => {
    if (closable) onClose();
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

  const modeButton = (target: ShareVisibility, label: string): ReactNode => (
    <ShareTextButton
      label={label}
      selected={visibility === target}
      disabled={sharing.busy}
      onPress={() => changeVisibility(target)}
    />
  );

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
      'The previous link will stop working, including links already sent in invitation emails. Share the new link with anyone who still needs access.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Replace link', style: 'destructive', onPress: () => sharing.replaceLink() },
      ],
    );
  };

  const invite = async (): Promise<void> => {
    if (!email.trim() || sharing.busy) return;
    if (await sharing.inviteEmail(email)) setEmail('');
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

  const sectionLabel = (label: string): ReactNode => (
    <Text className="px-1 text-[13px] uppercase tracking-wider text-secondaryLabel">{label}</Text>
  );

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <View className="flex-1 bg-systemBackground">
        <View className="flex-row items-center justify-between px-6 pb-4 pt-8">
          <Text className="text-[22px] font-bold text-label">Share note</Text>
          {closable && (
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
              <ShareTextButton
                label="Sign in"
                accessibilityLabel="Sign in to share"
                onPress={() => {
                  onClose();
                  router.push('/auth');
                }}
              />
            </View>
          ) : privateNote ? (
            <View className="gap-3">
              <Text className="text-secondaryLabel">
                {!cloudBackupEnabled && !isTeamNote
                  ? 'Cloud backup is off. Turn it on in Settings before sharing this note.'
                  : 'Enable cloud sync for this note before sharing.'}
              </Text>
              {note?.remoteId && !sharing.loading && (
                <Text className="text-[13px] text-secondaryLabel">
                  {shared
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
                  <ShareTextButton label="Retry" onPress={() => sharing.refresh()} />
                </View>
              )}
              {canDisablePrevious && (
                <ShareTextButton
                  label="Disable previous link"
                  destructive
                  disabled={sharing.busy || sharing.loading}
                  onPress={() => changeVisibility('private')}
                />
              )}
              {!cloudBackupEnabled && !isTeamNote ? (
                <ShareTextButton
                  label="Open privacy settings"
                  disabled={sharing.busy}
                  onPress={() => {
                    onClose();
                    router.push('/(account)/privacy');
                  }}
                />
              ) : (
                <ShareTextButton
                  label="Enable cloud sync"
                  accessibilityLabel="Enable cloud sync for this note"
                  disabled={sharing.busy}
                  onPress={enableCloudSync}
                />
              )}
            </View>
          ) : !cloudBackupEnabled && !isTeamNote && !note?.remoteId ? (
            <View className="gap-3">
              <Text className="text-secondaryLabel">
                Cloud backup is off. Turn it on in Settings to share personal notes.
              </Text>
              <ShareTextButton
                label="Open privacy settings"
                onPress={() => {
                  onClose();
                  router.push('/(account)/privacy');
                }}
              />
            </View>
          ) : upgradeRequired ? (
            <View className="gap-3">
              <Text className="text-secondaryLabel">
                Sharing uploads this note to your cloud account, which requires Pro.
              </Text>
              <ShareTextButton label="Upgrade to Pro" onPress={upgrade} />
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
              <ShareTextButton label="Retry" onPress={() => sharing.refresh()} />
            </View>
          ) : (
            <>
              {sectionLabel('General access')}
              <GroupedList dividerInset={16}>
                <GroupedList.Row>
                  <Text className="text-[15px] font-medium text-label">
                    {shared || !isTeamNote
                      ? VISIBILITY_LABEL[visibility ?? 'private']
                      : 'Everyone in this team space'}
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
                  {sharing.sharingMode === 'domain_only' && (
                    <Text className="text-[13px] text-secondaryLabel">
                      Your organization only allows sharing within your company domain.
                    </Text>
                  )}
                  {sharing.sharingMode === 'disabled' && (
                    <Text className="text-[13px] text-secondaryLabel">
                      Your organization does not allow sharing notes outside it.
                    </Text>
                  )}
                  {!shared && allowed('link') && (
                    <View>
                      <Text className="text-[13px] text-secondaryLabel">
                        Anyone with the link can view this note.
                      </Text>
                      <ShareTextButton
                        label="Create link"
                        disabled={sharing.busy}
                        onPress={() => changeVisibility('link')}
                      />
                    </View>
                  )}
                  <View className="flex-row flex-wrap gap-x-6">
                    {shared && offered('link') && modeButton('link', 'Anyone with link')}
                    {offered('invited') && modeButton('invited', 'Invited only')}
                    {domainEligible &&
                      offered('domain') &&
                      modeButton('domain', `Organization (${businessDomain})`)}
                  </View>
                </View>
              )}
              {visibility && shared && canManage && allowed(visibility) && (
                <View className="gap-2">
                  {sectionLabel('Link')}
                  {sharing.hasLink ? (
                    <View className="flex-row flex-wrap gap-x-6">
                      <ShareTextButton
                        label="Share link"
                        disabled={sharing.busy}
                        onPress={() => sharing.shareLink()}
                      />
                      <ShareTextButton
                        label="Copy link"
                        disabled={sharing.busy}
                        onPress={() => sharing.copyLink()}
                      />
                      <ShareTextButton
                        label="Open in browser"
                        disabled={sharing.busy}
                        onPress={() => sharing.openLink()}
                      />
                    </View>
                  ) : (
                    <Text className="text-[13px] text-secondaryLabel">
                      The full link is unavailable on this device.
                    </Text>
                  )}
                  <ShareTextButton
                    label="Replace link"
                    disabled={sharing.busy}
                    onPress={replaceLink}
                  />
                </View>
              )}
              {canManage && allowed('invited') && (sharing.state || !note?.remoteId) && (
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
                    <ShareTextButton
                      label="Invite"
                      accessibilityLabel="Invite email"
                      disabled={sharing.busy || !email.trim()}
                      onPress={invite}
                    />
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
                  canInvite={allowed('invited')}
                  busy={sharing.busy}
                  onAddPrincipal={(principal) => sharing.addPrincipal(principal)}
                  onUpdateGrant={(grant, permission) => sharing.updateGrant(grant, permission)}
                  onRemoveGrant={(grant) => sharing.removeGrant(grant)}
                  onRevokeInvitation={(invitation) => sharing.revokeInvitation(invitation)}
                  onResendInvitation={(invitation) => sharing.resendInvitation(invitation)}
                />
              )}
              {shared && canManage && (
                <ShareTextButton
                  label="Disable external sharing"
                  destructive
                  disabled={sharing.busy}
                  onPress={() => changeVisibility('private')}
                />
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
