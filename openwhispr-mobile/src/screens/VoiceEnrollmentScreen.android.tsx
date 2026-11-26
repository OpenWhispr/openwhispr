import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { PillAction } from '@/android/settings/kit';
import { VoiceEnrollmentRecorder } from '@/components/notes/VoiceEnrollmentRecorder';
import { useNotesStore } from '@/android/store/useNotesStore';
import { notesRepository } from '@/android/shared/data';
import type { SpeakerProfile } from '@/data/types';
import { SpeakerProfileOwnerAlreadyExistsError } from '@/android/data/notesRepository';
import {
  VOICE_ENROLLMENT_PROFILE_NOT_FOUND,
  VoiceEnrollmentError,
  type EnrollVoiceProfileInput,
  type ReenrollVoiceProfileInput,
} from '@/android/shared/services/diarization/VoiceprintService';
import { VOICE_ALREADY_TAUGHT_ALERT } from '@/android/shared/lib/voiceEnrollmentMessages';
import {
  supportsVoiceEnrollment,
  VOICE_ENROLLMENT_UNAVAILABLE,
} from '@/android/shared/lib/voiceEnrollmentCapability';
import { useTheme } from '@/android/ThemeProvider';

type SubmitInput = EnrollVoiceProfileInput | ReenrollVoiceProfileInput;

export default function VoiceEnrollmentScreen() {
  const router = useRouter();
  const { tokens: t } = useTheme();
  if (supportsVoiceEnrollment()) return <SupportedVoiceEnrollmentScreen />;
  return (
    <View
      className="flex-1 gap-4 p-4"
      style={{ backgroundColor: t.canvas }}
      testID="voice-enrollment-unavailable"
    >
      <Text className="text-[15px] leading-5" style={{ color: t.secondary }}>
        {VOICE_ENROLLMENT_UNAVAILABLE}
      </Text>
      <PillAction
        label="Back"
        onPress={() =>
          router.canGoBack() ? router.back() : router.replace('/(tabs)/(notes)/voice-profiles')
        }
      />
    </View>
  );
}

function SupportedVoiceEnrollmentScreen() {
  const { tokens: t } = useTheme();
  const params = useLocalSearchParams<{ owner?: string; profileId?: string; noteId?: string }>();
  const router = useRouter();
  const profiles = useNotesStore((state) => state.voiceProfiles);
  // Teaching your voice when you already have a profile retrains that one, instead of a
  // full read that ends in "already taught". Read once, from the database since the store
  // may not have loaded profiles yet, so saving a new one mid-screen doesn't turn this into
  // a retrain.
  const [ownerProfileIdAtOpen] = useState(() =>
    params.owner !== '0' && !params.profileId
      ? (notesRepository.getSpeakerProfiles().find((profile) => profile.isOwner === 1)?.id ?? null)
      : null,
  );
  const profileId = params.profileId ? Number(params.profileId) : ownerProfileIdAtOpen;
  const noteId = params.noteId ? Number(params.noteId) : null;
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const loadVoiceProfiles = useNotesStore((state) => state.loadVoiceProfiles);
  const enrollVoiceProfile = useNotesStore((state) => state.enrollVoiceProfile);
  const reenrollVoiceProfile = useNotesStore((state) => state.reenrollVoiceProfile);
  const relabelMeetingSpeakers = useNotesStore((state) => state.relabelMeetingSpeakers);
  const isDiarizerModelReady = useNotesStore((state) => state.isDiarizerModelReady);
  const downloadDiarizerModel = useNotesStore((state) => state.downloadDiarizerModel);
  const isDiarizerModelDownloading = useNotesStore((state) => state.isDiarizerModelDownloading);

  useEffect(() => {
    loadVoiceProfiles();
    setProfilesLoaded(true);
  }, [loadVoiceProfiles]);

  const existingProfile = useMemo(
    () =>
      profileId == null ? null : (profiles.find((profile) => profile.id === profileId) ?? null),
    [profileId, profiles],
  );
  const isOwner = existingProfile ? existingProfile.isOwner === 1 : params.owner !== '0';
  const title = existingProfile
    ? isOwner
      ? 'Retrain Your Voice'
      : `Retrain ${existingProfile.displayName}'s Voice`
    : isOwner
      ? 'Teach OpenWhispr Your Voice'
      : "Add Someone's Voice";

  // A second tap on Done would go back past the screen that opened this one.
  const leftRef = useRef(false);
  const leave = useCallback(() => {
    if (leftRef.current) return;
    leftRef.current = true;
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/(notes)/voice-profiles');
  }, [router]);

  const handleSubmit = useCallback(
    async (input: SubmitInput) => {
      let profile: SpeakerProfile;
      try {
        profile = existingProfile
          ? await reenrollVoiceProfile({ ...input, profileId: existingProfile.id })
          : await enrollVoiceProfile(input as EnrollVoiceProfileInput);
      } catch (error) {
        if (error instanceof SpeakerProfileOwnerAlreadyExistsError) {
          Alert.alert(...VOICE_ALREADY_TAUGHT_ALERT);
          leave();
        } else if (
          error instanceof VoiceEnrollmentError &&
          error.code === VOICE_ENROLLMENT_PROFILE_NOT_FOUND
        ) {
          // Deleted while you read, e.g. by a sync: reloading shows that it's gone instead
          // of offering Try Again for a profile no read can save.
          loadVoiceProfiles();
        }
        throw error;
      }
      // Started from a meeting note: label that meeting with the new voice as well.
      if (noteId != null) relabelMeetingSpeakers(noteId, profile.id);
    },
    [
      enrollVoiceProfile,
      existingProfile,
      leave,
      loadVoiceProfiles,
      noteId,
      reenrollVoiceProfile,
      relabelMeetingSpeakers,
    ],
  );

  if (profileId != null && !existingProfile) {
    // Profiles load in the first effect; after that a missing one was deleted.
    if (!profilesLoaded) return <View className="flex-1" style={{ backgroundColor: t.canvas }} />;
    return (
      <View
        className="flex-1 gap-4 p-4"
        style={{ backgroundColor: t.canvas }}
        testID="voice-enrollment-missing"
      >
        <Text className="text-[15px] leading-5" style={{ color: t.secondary }}>
          This voice profile no longer exists.
        </Text>
        <PillAction label="Back" onPress={leave} />
      </View>
    );
  }

  return (
    <View className="flex-1" style={{ backgroundColor: t.canvas }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      >
        <Text
          accessibilityRole="header"
          className="mb-5 text-2xl font-bold"
          style={{ color: t.ink }}
        >
          {title}
        </Text>
        <VoiceEnrollmentRecorder
          isOwner={isOwner}
          profileId={existingProfile?.id}
          defaultDisplayName={existingProfile?.displayName}
          isModelReady={isDiarizerModelReady}
          isModelDownloading={isDiarizerModelDownloading}
          downloadModel={downloadDiarizerModel}
          onSubmit={handleSubmit}
          onDone={leave}
          onCancel={leave}
        />
      </ScrollView>
    </View>
  );
}
