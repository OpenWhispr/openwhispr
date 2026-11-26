import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { GroupedList } from './GroupedList';
import { SectionHeader } from './SectionHeader';
import { SpeakerAvatar } from '@/android/shared/components/notes/SpeakerAvatar';
import { SwipeableCard, type RestoreRow } from '@/components/ui/SwipeableCard';
import type { SpeakerProfile } from '@/data/types';
import { useTheme } from '@/android/ThemeProvider';

interface VoiceProfileListProps {
  profiles: SpeakerProfile[];
  onEnrollOwner?: () => void;
  onEnrollSpeaker?: () => void;
  unavailableMessage?: string;
  onOpenProfile: (profile: SpeakerProfile) => void;
  /** `restore` slides a swiped row back; call it if the user cancels the delete. */
  onDelete: (profile: SpeakerProfile, restore: RestoreRow) => void;
  onDeleteAll?: () => void;
}

const formatAddedAt = (value: string | null): string => {
  if (!value) return 'Added on this device';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Added on this device';
  return `Added ${date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })}`;
};

const formatMeta = (profile: SpeakerProfile): string => {
  const samples = `${profile.sampleCount} ${profile.sampleCount === 1 ? 'sample' : 'samples'}`;
  return `${samples} · ${formatAddedAt(profile.createdAt)}`;
};

export function VoiceProfileList({
  profiles,
  onEnrollOwner,
  onEnrollSpeaker,
  onOpenProfile,
  onDelete,
  onDeleteAll,
  unavailableMessage,
}: VoiceProfileListProps) {
  const { tokens: theme, glass } = useTheme();
  if (profiles.length === 0) {
    return (
      <GroupedList>
        <GroupedList.Row contentInsetLeft={16}>
          <View className="items-center gap-3 py-8">
            <SystemIcon
              name="waveform.circle"
              mdName="AudioLines"
              size={36}
              color={theme.disabled}
            />
            <View className="items-center gap-1">
              <Text className="text-[17px] font-semibold" style={{ color: theme.ink }}>
                {unavailableMessage ? 'Voice profiles' : 'Label speakers automatically'}
              </Text>
              <Text className="text-center text-[15px] leading-5" style={{ color: theme.tertiary }}>
                {unavailableMessage ??
                  'Record a short voice sample and OpenWhispr will recognize you in future meeting transcripts instead of showing "Speaker 1". Works with on-device transcription. Voice samples stay on this device and can be deleted anytime.'}
              </Text>
            </View>
            {onEnrollOwner ? (
              <Pressable
                onPress={onEnrollOwner}
                accessibilityRole="button"
                accessibilityLabel="Teach Your Voice"
                testID="voice-profile-enroll-owner-empty"
                className="mt-1 h-10 items-center justify-center rounded-full px-4"
                style={({ pressed }) => [glass, { opacity: pressed ? 0.85 : 1 }]}
              >
                <Text className="text-[15px] font-semibold" style={{ color: theme.onGlass }}>
                  Teach Your Voice
                </Text>
              </Pressable>
            ) : null}
          </View>
        </GroupedList.Row>
      </GroupedList>
    );
  }

  const hasOwner = profiles.some((profile) => profile.isOwner === 1);

  return (
    <View>
      <SectionHeader label="Speakers" />
      <GroupedList dividerInset={64}>
        {profiles.map((profile) => (
          <SwipeableCard key={profile.id} onDelete={(restore) => onDelete(profile, restore)} inset>
            <GroupedList.Row
              onPress={() => onOpenProfile(profile)}
              accessibilityRole="button"
              accessibilityLabel={`${profile.displayName}, ${formatMeta(profile)}`}
              testID={`voice-profile-row-${profile.id}`}
              contentInsetLeft={64}
              leadingIconSlot={
                <SpeakerAvatar name={profile.displayName} isOwner={profile.isOwner === 1} />
              }
            >
              <View className="flex-row items-center gap-2">
                <View className="min-w-0 flex-1">
                  <View className="flex-row flex-wrap items-center gap-2">
                    <Text className="text-[17px] font-semibold" style={{ color: theme.ink }}>
                      {profile.displayName}
                    </Text>
                    {profile.isOwner === 1 ? (
                      <View
                        className="rounded-md px-2 py-0.5"
                        style={{ backgroundColor: theme.track }}
                        testID={`voice-profile-owner-badge-${profile.id}`}
                      >
                        <Text
                          className="text-[12px] font-semibold"
                          style={{ color: theme.secondary }}
                        >
                          You
                        </Text>
                      </View>
                    ) : null}
                  </View>
                  <Text
                    className="mt-0.5 text-[13px]"
                    style={{ color: theme.secondary }}
                    numberOfLines={1}
                  >
                    {formatMeta(profile)}
                  </Text>
                </View>
                <SystemIcon
                  name="chevron.right"
                  mdName="ChevronRight"
                  size={14}
                  color={theme.tertiary}
                />
              </View>
            </GroupedList.Row>
          </SwipeableCard>
        ))}
      </GroupedList>

      {onEnrollOwner || onEnrollSpeaker ? (
        <View className="mt-6">
          <GroupedList dividerInset={16}>
            {hasOwner || !onEnrollOwner ? null : (
              <GroupedList.Row
                onPress={onEnrollOwner}
                accessibilityRole="button"
                accessibilityLabel="Teach Your Voice"
                testID="voice-profile-enroll-owner"
                contentInsetLeft={16}
              >
                <Text className="text-[17px] font-medium" style={{ color: theme.accent }}>
                  Teach Your Voice
                </Text>
              </GroupedList.Row>
            )}
            {onEnrollSpeaker ? (
              <GroupedList.Row
                onPress={onEnrollSpeaker}
                accessibilityRole="button"
                accessibilityLabel="Add Someone's Voice"
                testID="voice-profile-enroll-speaker"
                contentInsetLeft={16}
              >
                <View className="flex-row items-center gap-2">
                  <SystemIcon name="plus" mdName="Plus" size={17} color={theme.accent} />
                  <Text className="text-[17px] font-medium" style={{ color: theme.accent }}>
                    Add Someone's Voice
                  </Text>
                </View>
              </GroupedList.Row>
            ) : null}
          </GroupedList>
        </View>
      ) : null}

      <Text className="mt-2 px-4 text-[13px] leading-5" style={{ color: theme.secondary }}>
        {unavailableMessage ??
          'Voice profiles are local to this device. They help label future meeting transcripts and can be deleted at any time.'}
      </Text>

      {onDeleteAll ? (
        <View className="mt-6">
          <GroupedList dividerInset={16}>
            <GroupedList.Row
              onPress={onDeleteAll}
              accessibilityRole="button"
              accessibilityLabel="Delete All Profiles"
              testID="voice-profile-delete-all"
              contentInsetLeft={16}
            >
              <Text className="text-center text-[17px] font-medium" style={{ color: theme.error }}>
                Delete All Profiles
              </Text>
            </GroupedList.Row>
          </GroupedList>
        </View>
      ) : null}
    </View>
  );
}
