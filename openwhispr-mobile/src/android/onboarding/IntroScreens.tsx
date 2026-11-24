import { useEffect, useState } from 'react';
import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { Text } from '@/components/ui/Text';
import { AccentText, BubbleIcon, GlassButton, Screen, WhiteButton, colors, plain, s } from './kit';
import { useOnboardingT } from './strings';
import { theme } from '../theme';

const APP_ICON = require('./assets/app-icon.png');
const HOW_VIDEO = require('./assets/how-it-works-stage.mp4');
const LIGHT_ACCENT = theme.brandHighlight;

export function BrandBackground({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ flex: 1, backgroundColor: colors.brandMid }}>
      <LinearGradient
        colors={[colors.brandTop, colors.brandMid, colors.brandDeep]}
        locations={[0, 0.55, 1]}
        style={StyleSheet.absoluteFill}
      />
      <View pointerEvents="none" style={[local.glow, { top: -120, right: -140 }]} />
      <View
        pointerEvents="none"
        style={[local.glow, { bottom: -160, left: -180, opacity: 0.12 }]}
      />
      {children}
    </View>
  );
}

const SPLASH_BG = require('./assets/splash-bg.jpg');

// Laid out on the Figma frame (393 x 852): the background art, rings included, is exported
// from it, and the icon and copy sit at the same fractions of the screen.
export function SplashScreen({ onStart }: { onStart: () => void }) {
  const t = useOnboardingT();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const y = (value: number) => (size.height * value) / 852;
  const icon = (size.width * 112) / 393;
  return (
    <View
      style={{ flex: 1, backgroundColor: colors.brandMid }}
      onLayout={(event) => setSize(event.nativeEvent.layout)}
    >
      <StatusBar style="light" />
      {size.height > 0 ? (
        <Image
          source={SPLASH_BG}
          style={{ position: 'absolute', top: 0, left: 0, width: size.width, height: size.height }}
          resizeMode="cover"
          accessible={false}
        />
      ) : null}
      {size.height > 0 ? (
        <>
          <Image
            source={APP_ICON}
            style={[
              local.splashIcon,
              { width: icon, height: icon, top: y(300) - icon / 2, left: (size.width - icon) / 2 },
            ]}
            accessible={false}
          />
          <View style={{ position: 'absolute', top: y(508), left: 16, right: 16, gap: 12 }}>
            <AccentText
              center
              text={t('splashTitle')}
              accent={LIGHT_ACCENT}
              style={{ color: theme.onGlass, fontSize: 36, lineHeight: 42 }}
            />
            <Text
              textBreakStrategy="balanced"
              style={[s.body, { color: 'rgba(255,255,255,0.78)', textAlign: 'center' }]}
            >
              {t('splashBody')}
            </Text>
          </View>
        </>
      ) : null}
      <SafeAreaView
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
        edges={['bottom']}
      >
        <View style={s.footer}>
          <WhiteButton label={t('getStarted')} onPress={onStart} />
        </View>
      </SafeAreaView>
    </View>
  );
}

const BARS = [18, 30, 22, 44, 34, 56, 40, 26, 48, 30, 20, 36, 24, 16];

export function PitchScreen({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const t = useOnboardingT();
  return (
    <Screen
      onBack={onBack}
      scroll={false}
      footer={<GlassButton label={t('next')} onPress={onNext} />}
    >
      <View style={local.pitch}>
        <LinearGradient
          colors={[theme.brandLight, colors.brandMid, colors.brandDeep]}
          locations={[0, 0.6, 1]}
          start={{ x: 0.8, y: 0 }}
          end={{ x: 0.2, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <AccentText
          text={t('pitch')}
          accent={LIGHT_ACCENT}
          style={{ color: theme.onGlass, fontSize: 36, lineHeight: 42 }}
        />
        <View style={{ flex: 1 }} />
        <View style={[s.center, { flexDirection: 'row', justifyContent: 'space-between' }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {BARS.map((height, index) => (
              <View
                key={index}
                style={{
                  width: 6,
                  height,
                  borderRadius: 3,
                  backgroundColor: 'rgba(255,255,255,0.8)',
                }}
              />
            ))}
          </View>
          <BubbleIcon size={54} />
        </View>
      </View>
    </Screen>
  );
}

type ExpoVideo = {
  VideoView: React.ComponentType<{
    player: unknown;
    nativeControls?: boolean;
    contentFit?: 'contain' | 'cover' | 'fill';
    allowsPictureInPicture?: boolean;
    style?: StyleProp<ViewStyle>;
  }>;
  useVideoPlayer: (
    source: unknown,
    setup: (player: { loop: boolean; muted: boolean; play: () => void }) => void,
  ) => { play: () => void; pause: () => void };
};

let expoVideo: ExpoVideo | null | undefined;
function loadExpoVideo(): ExpoVideo | null {
  if (expoVideo !== undefined) return expoVideo;
  try {
    // A development client built before expo-video was added has no native view to load.
    expoVideo = require('expo-video') as ExpoVideo;
  } catch {
    expoVideo = null;
  }
  return expoVideo;
}

function HowVideo({ video }: { video: ExpoVideo }) {
  const player = video.useVideoPlayer(HOW_VIDEO, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 50);
    return () => clearTimeout(timer);
  }, []);
  return (
    <video.VideoView
      player={player}
      nativeControls={false}
      contentFit="cover"
      allowsPictureInPicture={false}
      style={[StyleSheet.absoluteFill, { opacity: visible ? 1 : 0 }]}
    />
  );
}

export function HowItWorksScreen({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const t = useOnboardingT();
  const video = loadExpoVideo();
  return (
    <Screen onBack={onBack} footer={<GlassButton label={t('giveItATry')} onPress={onNext} />}>
      <AccentText text={t('howTitle')} />
      <Text textBreakStrategy="balanced" style={s.body}>
        {t('howBody')}
      </Text>
      <View
        style={local.video}
        accessible
        accessibilityLabel={`${t('howStep1')}. ${t('howStep2')}. ${plain(t('howStep3'))}.`}
      >
        {video ? (
          <HowVideo video={video} />
        ) : (
          <View style={[StyleSheet.absoluteFill, s.center]}>
            <BubbleIcon size={72} />
          </View>
        )}
      </View>
    </Screen>
  );
}

const local = StyleSheet.create({
  glow: {
    position: 'absolute',
    width: 420,
    height: 420,
    borderRadius: 210,
    backgroundColor: theme.onGlass,
    opacity: 0.16,
  },
  splashIcon: {
    position: 'absolute',
    shadowColor: theme.brandDeep,
    shadowOpacity: 0.45,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 16 },
  },
  pitch: {
    flex: 1,
    borderRadius: 32,
    overflow: 'hidden',
    padding: 24,
    marginBottom: 8,
  },
  video: {
    width: '100%',
    aspectRatio: 1082 / 1260,
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
});
