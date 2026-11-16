import { useEffect, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { AccentText, BubbleIcon, GlassButton, PulseRings, Screen, colors } from './kit';
import { useOnboardingT } from './strings';

const app = (name: string) => {
  switch (name) {
    case 'gmail':
      return require('./assets/apps/gmail.png');
    case 'slack':
      return require('./assets/apps/slack.png');
    case 'whatsapp':
      return require('./assets/apps/whatsapp.png');
    case 'outlook':
      return require('./assets/apps/outlook.png');
    case 'chatgpt':
      return require('./assets/apps/chatgpt.png');
    case 'notes':
      return require('./assets/apps/notes.png');
    case 'docs':
      return require('./assets/apps/docs.png');
    case 'calendar':
      return require('./assets/apps/calendar.png');
    case 'mail':
      return require('./assets/apps/mail.png');
    case 'teams':
      return require('./assets/apps/teams.png');
    case 'claude':
      return require('./assets/apps/claude.png');
    case 'x':
      return require('./assets/apps/x.png');
    case 'word':
      return require('./assets/apps/word.png');
    case 'safari':
      return require('./assets/apps/safari.png');
    case 'imessage':
      return require('./assets/apps/imessage.png');
    default:
      throw new Error(`Unknown app icon ${name}`);
  }
};
export const appIcon = app;

// Matches the Figma orbit: angle (deg), distance, size, tilt (deg), opacity, all on a 345pt-wide card.
const ORBIT: [string, number, number, number, number, number][] = [
  ['gmail', -68, 90, 44, 6, 0.92],
  ['slack', 8, 98, 40, -6, 0.85],
  ['whatsapp', 60, 84, 46, 4, 0.95],
  ['outlook', 124, 100, 40, -8, 0.82],
  ['chatgpt', 186, 88, 38, 9, 0.78],
  ['notes', 226, 96, 42, -4, 0.85],
  ['docs', -84, 160, 38, -7, 0.6],
  ['calendar', -30, 152, 36, 10, 0.5],
  ['mail', 16, 146, 42, -9, 0.65],
  ['teams', 80, 156, 38, 7, 0.55],
  ['claude', 124, 150, 34, -11, 0.5],
  ['x', 158, 140, 40, 8, 0.62],
  ['word', 203, 146, 36, -6, 0.5],
  ['safari', -128, 150, 44, 5, 0.7],
];

export function AppsScreen({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const t = useOnboardingT();
  const [width, setWidth] = useState(0);
  const scale = width / 345;
  const centerX = width / 2;
  const centerY = 202 * scale;
  return (
    <Screen onBack={onBack} footer={<GlassButton label={t('continue')} onPress={onNext} />}>
      <AccentText center text={t('appsTitle')} />
      <View
        style={o.card}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
      >
        <LinearGradient
          colors={['#7DA2F2', colors.brandMid, colors.brandDeep]}
          locations={[0, 0.6, 1]}
          start={{ x: 0.8, y: 0 }}
          end={{ x: 0.2, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        {width > 0 ? (
          <>
            {[96, 150].map((radius) => (
              <View
                key={radius}
                style={[
                  o.dashed,
                  {
                    width: radius * 2 * scale,
                    height: radius * 2 * scale,
                    borderRadius: radius * scale,
                    left: centerX - radius * scale,
                    top: centerY - radius * scale,
                  },
                ]}
              />
            ))}
            <View
              style={[
                o.center,
                {
                  left: centerX - 60 * scale,
                  top: centerY - 60 * scale,
                  width: 120 * scale,
                  height: 120 * scale,
                },
              ]}
            >
              <PulseRings size={84 * scale} color="rgba(255,255,255,0.16)" />
              <BubbleIcon size={68 * scale} />
            </View>
            {ORBIT.map(([name, angle, distance, size, tilt, opacity], index) => {
              const radians = (angle * Math.PI) / 180;
              const half = (size * scale) / 2;
              const x = Math.min(
                width - half - 8,
                Math.max(half + 8, centerX + distance * scale * Math.cos(radians)),
              );
              const y = Math.max(half + 8, centerY + distance * scale * Math.sin(radians));
              return (
                <Floating
                  key={name}
                  index={index}
                  style={{
                    position: 'absolute',
                    left: x - half,
                    top: y - half,
                    opacity,
                    transform: [{ rotate: `${tilt}deg` }],
                  }}
                >
                  <Image source={app(name)} style={{ width: size * scale, height: size * scale }} />
                </Floating>
              );
            })}
          </>
        ) : null}
      </View>
    </Screen>
  );
}

function Floating({
  index,
  style,
  children,
}: {
  index: number;
  style: object;
  children: React.ReactNode;
}) {
  const reduced = useReducedMotion();
  const drift = useSharedValue(0);
  useEffect(() => {
    if (reduced) return;
    drift.value = withRepeat(
      withTiming(1, { duration: 2400 + (index % 5) * 380, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, [drift, index, reduced]);
  const animated = useAnimatedStyle(() => ({
    marginTop: (drift.value - 0.5) * (index % 2 ? 6 : -6),
  }));
  return <Animated.View style={[style, animated]}>{children}</Animated.View>;
}

const o = StyleSheet.create({
  card: { width: '100%', aspectRatio: 345 / 400, borderRadius: 32, overflow: 'hidden' },
  dashed: {
    position: 'absolute',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(255,255,255,0.28)',
  },
  center: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
});
