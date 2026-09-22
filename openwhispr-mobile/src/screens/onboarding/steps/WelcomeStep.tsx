import { useEffect } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { AnimatedKeyboardPreview } from '@/components/onboarding/AnimatedKeyboardPreview';
import { useOnboardingStore } from '@/store/useOnboardingStore';

const WELCOME_VIDEO = require('../../../../assets/onboarding/videos/welcome-setup.mp4');
const WELCOME_VIDEO_ASPECT_RATIO = 720 / 630;
const WELCOME_VIDEO_START_DELAY_MS = 500;

type ExpoVideoModule = {
  VideoView: React.ComponentType<{
    player: unknown;
    nativeControls?: boolean;
    contentFit?: 'contain' | 'cover' | 'fill';
    allowsPictureInPicture?: boolean;
    style?: StyleProp<ViewStyle>;
  }>;
  useVideoPlayer: (
    source: unknown,
    setup: (player: { loop: boolean; muted: boolean; play: () => void; pause: () => void }) => void,
  ) => { play: () => void; pause: () => void };
};

let expoVideoModule: ExpoVideoModule | null | undefined;

function getExpoVideoModule(): ExpoVideoModule | null {
  if (expoVideoModule !== undefined) return expoVideoModule;

  try {
    expoVideoModule = require('expo-video') as ExpoVideoModule;
  } catch (error) {
    if (__DEV__) {
      console.warn(
        '[WelcomeStep] expo-video native module is unavailable. Rebuild the native app to enable the onboarding video.',
        (error as Error)?.message ?? error,
      );
    }
    expoVideoModule = null;
  }

  return expoVideoModule;
}

export function WelcomeStep() {
  const goNext = useOnboardingStore((s) => s.goNext);

  return (
    <OnboardingShell
      title="Let's set up OpenWhispr"
      titleAccent="set up"
      subtitle="Dictate naturally anywhere on iPhone. Emails, messages, notes and AI chats."
      ctaLabel="Set up"
      onCta={goNext}
    >
      <View className="flex-1 items-center justify-center">
        <WelcomeIntroVideo />
      </View>
    </OnboardingShell>
  );
}

function WelcomeIntroVideo() {
  const expoVideo = getExpoVideoModule();
  if (!expoVideo) {
    return (
      <View className="w-full items-center justify-center overflow-hidden rounded-lg">
        <AnimatedKeyboardPreview />
      </View>
    );
  }

  return <WelcomeIntroVideoPlayer expoVideo={expoVideo} />;
}

function WelcomeIntroVideoPlayer({ expoVideo }: { expoVideo: ExpoVideoModule }) {
  const { VideoView, useVideoPlayer } = expoVideo;
  const player = useVideoPlayer(WELCOME_VIDEO, (videoPlayer) => {
    videoPlayer.loop = true;
    videoPlayer.muted = true;
  });

  useEffect(() => {
    const startTimer = setTimeout(() => {
      try {
        player.play();
      } catch {
        // expo-video may dispose the native shared object before the timer fires.
      }
    }, WELCOME_VIDEO_START_DELAY_MS);

    return () => {
      clearTimeout(startTimer);
      try {
        player.pause();
      } catch {
        // expo-video may dispose the native shared object before React cleanup runs.
      }
    };
  }, [player]);

  return (
    <View className="w-full overflow-hidden rounded-lg" style={styles.videoFrame}>
      <VideoView
        player={player}
        nativeControls={false}
        contentFit="cover"
        allowsPictureInPicture={false}
        style={styles.video}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  videoFrame: {
    aspectRatio: WELCOME_VIDEO_ASPECT_RATIO,
    shadowColor: '#000000',
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  video: {
    flex: 1,
  },
});
