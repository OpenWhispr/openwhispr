import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { GroupedList } from '@/components/notes/GroupedList';
import { SectionHeader } from '@/components/notes/SectionHeader';
import { SpeakerAvatar } from '@/components/notes/SpeakerAvatar';
import { useNotesStore } from '@/store/useNotesStore';
import { confirmDestructive } from '@/lib/alerts';
import { safeHaptics } from '@/lib/utils';
import { iosColor } from '@/config/colors';
import { SpaceGrotesk } from '@/lib/fonts';

const formatDate = (value: string | null): string => {
  if (!value) return 'On this device';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'On this device';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

function FieldRow({
  label,
  value,
  placeholder,
  keyboardType,
  autoCapitalize,
  onChangeText,
  onBlur,
  testID,
}: {
  label: string;
  value: string;
  placeholder?: string;
  keyboardType?: 'default' | 'email-address';
  autoCapitalize?: 'none' | 'words';
  onChangeText: (next: string) => void;
  onBlur: () => void;
  testID?: string;
}) {
  return (
    <View className="min-h-[50px] flex-row items-center px-4">
      <Text className="w-[84px] text-[16px] text-secondaryLabel">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onBlur={onBlur}
        onSubmitEditing={onBlur}
        placeholder={placeholder}
        placeholderTextColor={iosColor('tertiaryLabel')}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        returnKeyType="done"
        testID={testID}
        className="flex-1 py-3 text-[17px] text-label"
        style={{ fontFamily: SpaceGrotesk.regular }}
      />
    </View>
  );
}

export default function VoiceProfileDetailScreen() {
  const params = useLocalSearchParams<{ profileId?: string }>();
  const router = useRouter();
  const profileId = params.profileId ? Number(params.profileId) : null;

  const profiles = useNotesStore((state) => state.voiceProfiles);
  const loadVoiceProfiles = useNotesStore((state) => state.loadVoiceProfiles);
  const updateVoiceProfile = useNotesStore((state) => state.updateVoiceProfile);
  const deleteVoiceProfile = useNotesStore((state) => state.deleteVoiceProfile);

  const profile = profiles.find((item) => item.id === profileId) ?? null;

  const [name, setName] = useState(profile?.displayName ?? '');
  const [email, setEmail] = useState(profile?.email ?? '');
  const syncedId = useRef<number | null>(null);
  const sawProfile = useRef(false);

  useEffect(() => {
    loadVoiceProfiles();
  }, [loadVoiceProfiles]);

  useEffect(() => {
    if (profile && syncedId.current !== profile.id) {
      syncedId.current = profile.id;
      setName(profile.displayName);
      setEmail(profile.email ?? '');
    }
  }, [profile]);

  // Leave once the profile is gone — deleted here, or a stale id once profiles load.
  useEffect(() => {
    if (profile) {
      sawProfile.current = true;
      return;
    }
    if (sawProfile.current || profiles.length > 0) {
      router.back();
    }
  }, [profile, profiles.length, router]);

  const commitName = useCallback(() => {
    if (!profile) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setName(profile.displayName);
      return;
    }
    if (trimmed !== profile.displayName) {
      updateVoiceProfile(profile.id, { displayName: trimmed });
    }
  }, [name, profile, updateVoiceProfile]);

  const commitEmail = useCallback(() => {
    if (!profile) return;
    const trimmed = email.trim();
    const next = trimmed.length > 0 ? trimmed : null;
    if (next !== (profile.email ?? null)) {
      updateVoiceProfile(profile.id, { email: next });
    }
  }, [email, profile, updateVoiceProfile]);

  const reenroll = useCallback(() => {
    if (!profile) return;
    router.push(`/(tabs)/(notes)/voice-enrollment?profileId=${profile.id}`);
  }, [profile, router]);

  const remove = useCallback(() => {
    if (!profile) return;
    confirmDestructive(
      'Delete Voice Profile',
      `${profile.displayName} will be removed from this device. Historical locked speaker labels stay readable.`,
      () => {
        deleteVoiceProfile(profile.id);
        safeHaptics('warning');
      },
    );
  }, [profile, deleteVoiceProfile]);

  if (!profile) {
    return <View className="flex-1 bg-systemBackground" />;
  }

  const isOwner = profile.isOwner === 1;

  return (
    <View className="flex-1 bg-systemBackground">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      >
        <View className="items-center gap-2.5 pb-1 pt-2">
          <SpeakerAvatar name={profile.displayName} isOwner={isOwner} size={76} />
          <View className="flex-row items-center gap-2">
            <Text className="text-[22px] font-bold text-label">{profile.displayName}</Text>
            {isOwner ? (
              <View className="rounded-md bg-tertiarySystemFill px-2 py-0.5">
                <Text className="text-[12px] font-semibold text-secondaryLabel">Owner</Text>
              </View>
            ) : null}
          </View>
        </View>

        <SectionHeader label="Name" />
        <GroupedList dividerInset={16}>
          <FieldRow
            label="Name"
            value={name}
            autoCapitalize="words"
            onChangeText={setName}
            onBlur={commitName}
            testID="voice-profile-name-input"
          />
          <FieldRow
            label="Email"
            value={email}
            placeholder="Optional"
            keyboardType="email-address"
            autoCapitalize="none"
            onChangeText={setEmail}
            onBlur={commitEmail}
            testID="voice-profile-email-input"
          />
        </GroupedList>
        <Text className="mt-2 px-4 text-[13px] leading-5 text-secondaryLabel">
          Adding an email lets meeting notes link this speaker to calendar invites later.
        </Text>

        <SectionHeader label="Voiceprint" />
        <GroupedList dividerInset={16}>
          <View className="min-h-[46px] flex-row items-center justify-between px-4 py-3">
            <Text className="text-[16px] text-secondaryLabel">Samples</Text>
            <Text className="text-[16px] font-medium text-label">{profile.sampleCount}</Text>
          </View>
          <View className="min-h-[46px] flex-row items-center justify-between px-4 py-3">
            <Text className="text-[16px] text-secondaryLabel">Enrolled</Text>
            <Text className="text-[16px] font-medium text-label">
              {formatDate(profile.createdAt)}
            </Text>
          </View>
          <GroupedList.Row
            onPress={reenroll}
            accessibilityRole="button"
            accessibilityLabel="Re-enroll Voice"
            testID="voice-profile-reenroll"
            contentInsetLeft={16}
          >
            <Text className="text-[17px] font-medium text-brand">Re-enroll Voice</Text>
          </GroupedList.Row>
        </GroupedList>
        <Text className="mt-2 px-4 text-[13px] leading-5 text-secondaryLabel">
          Re-recording replaces this speaker's voiceprint. Past transcripts keep their existing
          labels.
        </Text>

        <View className="mt-6">
          <GroupedList dividerInset={16}>
            <GroupedList.Row
              onPress={remove}
              accessibilityRole="button"
              accessibilityLabel="Delete Profile"
              testID="voice-profile-delete"
              contentInsetLeft={16}
            >
              <Text className="text-center text-[17px] font-medium text-systemRed">
                Delete Profile
              </Text>
            </GroupedList.Row>
          </GroupedList>
        </View>
      </ScrollView>
    </View>
  );
}
