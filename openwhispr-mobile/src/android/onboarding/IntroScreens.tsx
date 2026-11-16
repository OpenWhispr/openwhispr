import { useEffect, useState } from 'react';
import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { Text } from '@/components/ui/Text';
import { AppFont } from '@/lib/fonts';
import { SystemIcon } from '@/components/ui/SystemIcon';
import {
  AccentText,
  BubbleIcon,
  Card,
  GlassButton,
  Screen,
  WhiteButton,
  colors,
  plain,
  s,
} from './kit';
import { useOnboardingT } from './strings';

const APP_ICON = require('./assets/app-icon.png');
const HOW_VIDEO = require('./assets/how-it-works-stage.mp4');
const LIGHT_ACCENT = '#B9CEFF';

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

export function SplashScreen({ onStart }: { onStart: () => void }) {
  const t = useOnboardingT();
  return (
    <BrandBackground>
      <StatusBar style="light" />
      <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
        <View style={[s.center, { flex: 1 }]}>
          <View style={[s.center, { width: 280, height: 280 }]}>
            {[280, 210, 150].map((size) => (
              <View
                key={size}
                pointerEvents="none"
                style={[
                  local.ring,
                  { width: size, height: size, borderRadius: size / 2 },
                  size === 150 && { backgroundColor: 'rgba(255,255,255,0.06)' },
                ]}
              />
            ))}
            <Image
              source={APP_ICON}
              style={{ width: 112, height: 112 }}
              accessibilityIgnoresInvertColors
              accessible={false}
            />
          </View>
        </View>
        <View style={{ paddingHorizontal: 24, gap: 12, paddingBottom: 32 }}>
          <AccentText
            center
            text={t('splashTitle')}
            accent={LIGHT_ACCENT}
            style={{ color: '#FFFFFF', fontSize: 36, lineHeight: 42 }}
          />
          <Text style={[s.body, { color: 'rgba(255,255,255,0.85)', textAlign: 'center' }]}>
            {t('splashBody')}
          </Text>
        </View>
        <View style={s.footer}>
          <WhiteButton label={t('getStarted')} onPress={onStart} />
        </View>
      </SafeAreaView>
    </BrandBackground>
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
          colors={['#7DA2F2', colors.brandMid, colors.brandDeep]}
          locations={[0, 0.6, 1]}
          start={{ x: 0.8, y: 0 }}
          end={{ x: 0.2, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <AccentText
          text={t('pitch')}
          accent={LIGHT_ACCENT}
          style={{ color: '#FFFFFF', fontSize: 36, lineHeight: 42 }}
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
  const rows = [
    { icon: 'Keyboard' as const, title: t('howStep1'), body: t('howStep1Body') },
    { icon: 'Mic' as const, title: t('howStep2'), body: t('howStep2Body') },
    { icon: 'Check' as const, title: t('howStep3'), body: t('howStep3Body') },
  ];
  return (
    <Screen onBack={onBack} footer={<GlassButton label={t('giveItATry')} onPress={onNext} />}>
      <AccentText text={t('howTitle')} />
      <Text style={s.body}>{t('howBody')}</Text>
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
      <Card style={{ paddingVertical: 4 }}>
        {rows.map((row, index) => (
          <View
            key={row.title}
            style={[local.row, index > 0 && { borderTopWidth: 1, borderColor: colors.divider }]}
          >
            <SystemIcon
              name="circle"
              mdName={row.icon}
              size={20}
              color={row.icon === 'Check' ? colors.accent : colors.ink}
            />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 17, color: colors.ink, fontFamily: AppFont.medium }}>
                {row.title}
              </Text>
              <Text style={s.caption}>{row.body}</Text>
            </View>
          </View>
        ))}
      </Card>
    </Screen>
  );
}

const local = StyleSheet.create({
  glow: {
    position: 'absolute',
    width: 420,
    height: 420,
    borderRadius: 210,
    backgroundColor: '#FFFFFF',
    opacity: 0.16,
  },
  ring: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
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
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14 },
});
