import { useCallback, useEffect, useMemo } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { VoiceEnrollmentRecorder } from '@/components/notes/VoiceEnrollmentRecorder';
import { useNotesStore } from '@/store/useNotesStore';
import { SpeakerProfileOwnerAlreadyExistsError } from '@/data/local/notesRepository';
import {
  VOICE_ENROLLMENT_DIARIZER_MODEL_REQUIRED,
  VoiceEnrollmentError,
} from '@/services/diarization/VoiceprintService';
import type {
  EnrollVoiceProfileInput,
  ReenrollVoiceProfileInput,
} from '@/services/diarization/VoiceprintService';

type SubmitInput = EnrollVoiceProfileInput | ReenrollVoiceProfileInput;

export default function VoiceEnrollmentScreen() {
  const params = useLocalSearchParams<{ owner?: string; profileId?: string }>();
  const router = useRouter();
  const profileId = params.profileId ? Number(params.profileId) : null;
  const profiles = useNotesStore((state) => state.voiceProfiles);
  const loadVoiceProfiles = useNotesStore((state) => state.loadVoiceProfiles);
  const enrollVoiceProfile = useNotesStore((state) => state.enrollVoiceProfile);
  const reenrollVoiceProfile = useNotesStore((state) => state.reenrollVoiceProfile);
  const downloadDiarizerModel = useNotesStore((state) => state.downloadDiarizerModel);

  useEffect(() => {
    loadVoiceProfiles();
  }, [loadVoiceProfiles]);

  const existingProfile = useMemo(
    () =>
      profileId == null ? null : (profiles.find((profile) => profile.id === profileId) ?? null),
    [profileId, profiles],
  );
  const isOwner = existingProfile ? existingProfile.isOwner === 1 : params.owner !== '0';

  const handleSubmit = useCallback(
    async (input: SubmitInput) => {
      try {
        if (existingProfile) {
          await reenrollVoiceProfile({ ...input, profileId: existingProfile.id });
        } else {
          await enrollVoiceProfile(input as EnrollVoiceProfileInput);
        }
        if (router.canGoBack()) router.back();
        else router.replace('/(tabs)/(notes)/voice-profiles');
      } catch (error) {
        if (error instanceof SpeakerProfileOwnerAlreadyExistsError) {
          Alert.alert(
            'Me is already enrolled',
            'Open Voice Profiles and choose Re-enroll Me to update the owner voice profile.',
          );
          return;
        }
        if (
          error instanceof VoiceEnrollmentError &&
          error.code === VOICE_ENROLLMENT_DIARIZER_MODEL_REQUIRED
        ) {
          Alert.alert(
            'Download diarization model',
            'Voice enrollment needs the on-device diarization model. Download it now, then record another take.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Download',
                onPress: () => {
                  downloadDiarizerModel().catch((downloadError) => {
                    Alert.alert(
                      'Download failed',
                      downloadError instanceof Error
                        ? downloadError.message
                        : 'Could not download the model.',
                    );
                  });
                },
              },
            ],
          );
          throw error;
        }
        throw error;
      }
    },
    [downloadDiarizerModel, enrollVoiceProfile, existingProfile, reenrollVoiceProfile, router],
  );

  return (
    <View className="flex-1 bg-systemBackground">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      >
        <Text className="mb-5 text-2xl font-bold text-label">
          {existingProfile ? 'Re-enroll Voice' : 'Enroll Voice'}
        </Text>
        <VoiceEnrollmentRecorder
          isOwner={isOwner}
          profileId={existingProfile?.id}
          defaultDisplayName={existingProfile?.displayName ?? (isOwner ? 'Me' : '')}
          onSubmit={handleSubmit}
          onCancel={() => {
            if (router.canGoBack()) router.back();
          }}
        />
      </ScrollView>
    </View>
  );
}
