import React, { useEffect } from 'react';
import { Pressable, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { gloss, glossPressed, glassEdge, home } from '../home/kit';
import { useReduceMotion } from '../settings/kit';
import { useDictionaryT } from './strings';

const RING = 'rgba(21,85,212,0.28)';
const HERO_HEIGHT = 220;

/** A dashed ring that turns very slowly (desktop's `DictionaryEmptyIllustration` rings). */
function Ring({ size, seconds, reverse }: { size: number; seconds: number; reverse?: boolean }) {
  const reduceMotion = useReduceMotion();
  const turn = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) return;
    turn.value = withRepeat(
      withTiming(1, { duration: seconds * 1000, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(turn);
  }, [reduceMotion, seconds, turn]);
  const style = useAnimatedStyle(() => ({
    transform: [{ rotate: `${(reverse ? -360 : 360) * turn.value}deg` }],
  }));
  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 1.5,
          borderStyle: 'dashed',
          borderColor: RING,
        },
        style,
      ]}
    />
  );
}

/** A white chip that floats 4 px up and down. */
function Floating({
  children,
  delay,
  style,
}: {
  children: React.ReactNode;
  delay: number;
  style: object;
}) {
  const reduceMotion = useReduceMotion();
  const lift = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) return;
    const timer = setTimeout(() => {
      lift.value = withRepeat(
        withTiming(-4, { duration: 2400, easing: Easing.inOut(Easing.sin) }),
        -1,
        true,
      );
    }, delay);
    return () => {
      clearTimeout(timer);
      cancelAnimation(lift);
    };
  }, [reduceMotion, delay, lift]);
  const animated = useAnimatedStyle(() => ({ transform: [{ translateY: lift.value }] }));
  return (
    <Animated.View
      style={[
        glassEdge,
        { position: 'absolute', boxShadow: home.tipShadow, borderRadius: 18 },
        style,
        animated,
      ]}
    >
      {children}
    </Animated.View>
  );
}

function FixChip({ wrong, right }: { wrong: string; right: string }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 14,
        paddingVertical: 9,
      }}
    >
      <Text
        style={{
          fontSize: 14,
          lineHeight: 18,
          color: home.tertiary,
          textDecorationLine: 'line-through',
        }}
      >
        {wrong}
      </Text>
      <Text style={{ fontSize: 14, lineHeight: 18, fontWeight: '500', color: home.accent }}>
        {right}
      </Text>
    </View>
  );
}

function SnippetChip({ trigger, text }: { trigger: string; text: string }) {
  return (
    <View style={{ paddingHorizontal: 14, paddingVertical: 9, gap: 2 }}>
      <Text style={{ fontSize: 13, lineHeight: 17, color: home.secondary }}>“{trigger}”</Text>
      <Text
        numberOfLines={1}
        style={{ fontSize: 13, lineHeight: 17, fontWeight: '500', color: home.accent }}
      >
        ↳ {text}
      </Text>
    </View>
  );
}

/**
 * C6a and C6b: desktop's empty state refit for the phone. Dashed rings around the brand orb,
 * two example chips, desktop's copy and one brand-glass button.
 */
export function DictionaryEmpty({
  variant,
  onAdd,
}: {
  variant: 'words' | 'snippets';
  onAdd: () => void;
}) {
  const t = useDictionaryT();
  const words = variant === 'words';
  return (
    <View style={{ alignItems: 'center', paddingTop: 12, paddingHorizontal: 8 }}>
      <View
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        style={{
          height: HERO_HEIGHT,
          alignSelf: 'stretch',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ring size={220} seconds={120} />
        <Ring size={140} seconds={90} reverse />
        <View
          style={[
            {
              width: 64,
              height: 64,
              borderRadius: 32,
              alignItems: 'center',
              justifyContent: 'center',
            },
            gloss,
          ]}
        >
          {words ? (
            <SystemIcon name="book" mdName="BookOpen" size={24} color="#FFFFFF" />
          ) : (
            <Text style={{ color: '#FFFFFF', fontSize: 20, lineHeight: 24, fontWeight: '500' }}>
              Aa
            </Text>
          )}
        </View>
        {words ? (
          <>
            <Floating delay={0} style={{ top: 10, left: 4 }}>
              <FixChip wrong="open whisper" right="OpenWhispr" />
            </Floating>
            <Floating delay={1200} style={{ bottom: 12, right: 4 }}>
              <FixChip wrong="Cameren" right="Cameron" />
            </Floating>
          </>
        ) : (
          <>
            <Floating delay={0} style={{ top: 8, left: 4, maxWidth: 250 }}>
              <SnippetChip trigger={t('exampleSignoffTrigger')} text={t('exampleSignoffText')} />
            </Floating>
            <Floating delay={1200} style={{ bottom: 10, right: 4, maxWidth: 220 }}>
              <SnippetChip trigger={t('exampleLinkedinTrigger')} text={t('exampleLinkedinText')} />
            </Floating>
          </>
        )}
      </View>
      <Text
        accessibilityRole="header"
        style={{
          marginTop: 28,
          fontSize: 22,
          lineHeight: 30,
          fontWeight: '500',
          color: home.text,
          textAlign: 'center',
        }}
      >
        {words ? (
          t('emptyTitle')
        ) : (
          <>
            {t('snippetsEmptyTitle')}{' '}
            <Text style={{ color: home.accent }}>{t('snippetsEmptyAccent')}</Text>
          </>
        )}
      </Text>
      <Text
        textBreakStrategy="balanced"
        style={{
          marginTop: 12,
          fontSize: 16,
          lineHeight: 23,
          color: home.secondary,
          textAlign: 'center',
          paddingHorizontal: 12,
        }}
      >
        {words ? t('emptyBody') : t('snippetsEmptyBody')}
      </Text>
      <Pressable
        cssInterop={false}
        accessibilityRole="button"
        onPress={onAdd}
        style={({ pressed }) => [
          {
            marginTop: 24,
            height: 52,
            paddingHorizontal: 24,
            borderRadius: 999,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          },
          gloss,
          pressed && glossPressed,
        ]}
      >
        <SystemIcon name="plus" mdName="Plus" size={20} color="#FFFFFF" />
        <Text style={{ color: '#FFFFFF', fontSize: 17, lineHeight: 24, fontWeight: '500' }}>
          {words ? t('addFirstWord') : t('newSnippet')}
        </Text>
      </Pressable>
    </View>
  );
}
