import { useCallback, useEffect } from 'react';
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { VoiceProfileList } from '@/components/notes/VoiceProfileList';
import { useSuperwallGate } from '@/hooks/useSuperwallGate';
import { useNotesStore } from '@/store/useNotesStore';
import { confirmDestructive } from '@/lib/alerts';
import { SUPERWALL_PLACEMENTS } from '@/lib/superwall';
import { safeHaptics } from '@/lib/utils';
import type { SpeakerProfile } from '@/data/types';

const notesPath = (path: string): string => `/(tabs)/(notes)/${path}`;

export default function VoiceProfilesScreen() {
  const profiles = useNotesStore((state) => state.voiceProfiles);
  const loadVoiceProfiles = useNotesStore((state) => state.loadVoiceProfiles);
  const deleteVoiceProfile = useNotesStore((state) => state.deleteVoiceProfile);
  const deleteAllVoiceProfiles = useNotesStore((state) => state.deleteAllVoiceProfiles);
  const { register: registerSuperwallGate } = useSuperwallGate();

  useEffect(() => {
    loadVoiceProfiles();
  }, [loadVoiceProfiles]);

  const openOwnerEnrollment = useCallback(() => {
    router.push(notesPath('voice-enrollment?owner=1'));
  }, []);

  const openSpeakerEnrollment = useCallback(() => {
    registerSuperwallGate({
      placement: SUPERWALL_PLACEMENTS.voiceProfileAdditionalSpeaker,
      params: { existingProfileCount: profiles.length },
      requiresAccount: false,
      feature: () => {
        router.push(notesPath('voice-enrollment?owner=0'));
      },
    }).catch(() => {});
  }, [profiles.length, registerSuperwallGate]);

  const openProfile = useCallback((profile: SpeakerProfile) => {
    router.push(notesPath(`voice-profile?profileId=${profile.id}`));
  }, []);

  const deleteProfile = useCallback(
    (profile: SpeakerProfile) => {
      confirmDestructive(
        'Delete Voice Profile',
        `${profile.displayName} will be removed from this device. Historical locked speaker labels stay readable.`,
        () => {
          deleteVoiceProfile(profile.id);
          safeHaptics('warning');
        },
      );
    },
    [deleteVoiceProfile],
  );

  const deleteAll = useCallback(() => {
    confirmDestructive(
      'Delete All Voice Profiles',
      'All voice profiles will be removed from this device. Locked historical labels stay readable.',
      () => {
        deleteAllVoiceProfiles();
        safeHaptics('warning');
      },
    );
  }, [deleteAllVoiceProfiles]);

  return (
    <View className="flex-1 bg-systemBackground">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      >
        <VoiceProfileList
          profiles={profiles}
          onEnrollOwner={openOwnerEnrollment}
          onEnrollSpeaker={openSpeakerEnrollment}
          onOpenProfile={openProfile}
          onDelete={deleteProfile}
          onDeleteAll={profiles.length > 0 ? deleteAll : undefined}
        />
      </ScrollView>
    </View>
  );
}
