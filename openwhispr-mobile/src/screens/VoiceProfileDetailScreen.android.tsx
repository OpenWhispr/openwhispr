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
import { AppFont } from '@/lib/fonts';
import {
  supportsVoiceEnrollment,
  VOICE_ENROLLMENT_UNAVAILABLE,
} from '@/lib/voiceEnrollmentCapability';
import { theme } from '@/android/theme';

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
      <Text className="w-[84px] text-[16px]" style={{ color: theme.secondary }}>
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onBlur={onBlur}
        onSubmitEditing={onBlur}
        placeholder={placeholder}
        placeholderTextColor={theme.tertiary}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        returnKeyType="done"
        testID={testID}
        className="flex-1 py-3 text-[17px]"
        style={{ fontFamily: AppFont.regular, color: theme.ink }}
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

  const retrain = useCallback(() => {
    if (!profile || !supportsVoiceEnrollment()) return;
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
    return <View className="flex-1" style={{ backgroundColor: theme.canvas }} />;
  }

  const isOwner = profile.isOwner === 1;

  return (
    <View className="flex-1" style={{ backgroundColor: theme.canvas }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      >
        <View className="items-center gap-2.5 pb-1 pt-2">
          <SpeakerAvatar name={profile.displayName} isOwner={isOwner} size={76} />
          <View className="flex-row items-center gap-2">
            <Text
              accessibilityRole="header"
              className="text-[22px] font-bold"
              style={{ color: theme.ink }}
            >
              {profile.displayName}
            </Text>
            {isOwner ? (
              <View className="rounded-md px-2 py-0.5" style={{ backgroundColor: theme.track }}>
                <Text className="text-[12px] font-semibold" style={{ color: theme.secondary }}>
                  You
                </Text>
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
        <Text className="mt-2 px-4 text-[13px] leading-5" style={{ color: theme.secondary }}>
          Adding an email lets meeting notes link this speaker to calendar invites later.
        </Text>

        <SectionHeader label="Voice sample" />
        <GroupedList dividerInset={16}>
          <View className="min-h-[46px] flex-row items-center justify-between px-4 py-3">
            <Text className="text-[16px]" style={{ color: theme.secondary }}>
              Samples
            </Text>
            <Text className="text-[16px] font-medium" style={{ color: theme.ink }}>
              {profile.sampleCount}
            </Text>
          </View>
          <View className="min-h-[46px] flex-row items-center justify-between px-4 py-3">
            <Text className="text-[16px]" style={{ color: theme.secondary }}>
              Added
            </Text>
            <Text className="text-[16px] font-medium" style={{ color: theme.ink }}>
              {formatDate(profile.createdAt)}
            </Text>
          </View>
          {supportsVoiceEnrollment() ? (
            <GroupedList.Row
              onPress={retrain}
              accessibilityRole="button"
              accessibilityLabel="Retrain Voice"
              testID="voice-profile-reenroll"
              contentInsetLeft={16}
            >
              <Text className="text-[17px] font-medium" style={{ color: theme.accent }}>
                Retrain Voice
              </Text>
            </GroupedList.Row>
          ) : null}
        </GroupedList>
        <Text className="mt-2 px-4 text-[13px] leading-5" style={{ color: theme.secondary }}>
          {supportsVoiceEnrollment()
            ? 'Retraining replaces this voice sample. Past transcripts keep their existing labels.'
            : VOICE_ENROLLMENT_UNAVAILABLE}
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
              <Text className="text-center text-[17px] font-medium" style={{ color: theme.error }}>
                Delete Profile
              </Text>
            </GroupedList.Row>
          </GroupedList>
        </View>
      </ScrollView>
    </View>
  );
}
