import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, ScrollView, TextInput, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { Text } from '@/components/ui/Text';
import { home } from '../home/kit';
import { BottomSheet, ListRow, cardStyle, settings, useReduceMotion } from '../settings/kit';
import { KEY_CHECK_COLORS, KeyCheckMark } from '../settings/KeyCheckMark';
import type { KeyCheckResult, KeyCheckState } from '../settings/keyCheck';
import type { V1T } from './strings';

export type Option = { id: string; title: string; subtitle?: string; disabled?: boolean };

/** 9.2 / 9.3: a bottom sheet of choices, the chosen one tinted. Twelve models scroll. */
export function OptionSheet({
  visible,
  onClose,
  title,
  body,
  options,
  selected,
  onChoose,
  footer,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  body?: string;
  options: Option[];
  selected?: string;
  onChoose: (id: string) => void;
  footer?: React.ReactNode;
}) {
  return (
    <BottomSheet visible={visible} onClose={onClose} title={title} body={body}>
      {/* The scroll area reaches the sheet's edges and pads inside, so the card's shadow
          (8 px down, 24 px blur) is never cut at the sides or the bottom. */}
      <ScrollView
        style={{ maxHeight: 480, marginHorizontal: -16, marginTop: -8, marginBottom: -16 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32 }}
      >
        <View style={cardStyle}>
          {options.map((option, index) => (
            <View key={option.id}>
              {index > 0 && (
                <View style={{ height: 1, marginLeft: 16, backgroundColor: home.divider }} />
              )}
              <ListRow
                title={option.title}
                subtitle={option.subtitle}
                selected={option.id === selected}
                dimmed={option.disabled}
                trailing={option.id === selected ? undefined : null}
                onPress={option.disabled ? undefined : () => onChoose(option.id)}
              />
            </View>
          ))}
        </View>
      </ScrollView>
      {footer}
    </BottomSheet>
  );
}

/** 9.4 / 9.9: a text field in its own card, its label inside above the value. */
export function FieldCard({
  label,
  value,
  onChangeText,
  placeholder,
  secure,
  mark,
  failed,
  accessibilityLabel,
  keyboardType,
  autoFocus,
  locked,
}: {
  label: string;
  value: string;
  onChangeText?: (value: string) => void;
  placeholder?: string;
  secure?: boolean;
  mark?: React.ReactNode;
  failed?: boolean;
  accessibilityLabel?: string;
  keyboardType?: 'default' | 'url';
  autoFocus?: boolean;
  /** Shown as text, not editable (a key that passed its check). */
  locked?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View
      style={[
        cardStyle,
        {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingVertical: 10,
          gap: 10,
          borderWidth: 1.5,
          borderColor: failed
            ? KEY_CHECK_COLORS.failed
            : focused
              ? home.accent
              : home.borderDefault,
        },
      ]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[settings.subtitle, { fontSize: 12, lineHeight: 16 }]}>{label}</Text>
        {locked ? (
          <Text
            style={[settings.title, { fontWeight: '400', paddingVertical: 4 }]}
            numberOfLines={1}
          >
            {value}
          </Text>
        ) : (
          <TextInput
            value={value}
            onChangeText={onChangeText}
            placeholder={placeholder}
            placeholderTextColor={home.tertiary}
            secureTextEntry={secure}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            autoFocus={autoFocus}
            importantForAutofill="no"
            keyboardType={keyboardType === 'url' ? 'url' : 'default'}
            accessibilityLabel={accessibilityLabel ?? label}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            style={[settings.title, { fontWeight: '400', padding: 0, paddingVertical: 4 }]}
          />
        )}
      </View>
      {mark}
    </View>
  );
}

/** The check's mark, read out as it changes. */
export function CheckMark({ t, state }: { t: V1T; state: KeyCheckState; animate?: boolean }) {
  if (state === 'idle') return null;
  return (
    <View
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={t('keyCheckState', {
        state: t(
          state === 'checking'
            ? 'keyChecking'
            : state === 'connected'
              ? 'keyAccepted'
              : 'keyNotAccepted',
        ),
      })}
    >
      <KeyCheckMark state={state} />
    </View>
  );
}

/** Plain words for why a check didn't pass; the mark says the rest. */
export function reasonText(
  t: V1T,
  provider: string,
  result: KeyCheckResult & { message?: string; invalidAddress?: boolean },
) {
  if (result.invalidAddress) return t('serverInvalid');
  if (result.state === 'unverified') return t('keyNoAnswer', { provider });
  if (result.reason === 'managementKey') return t('keyManagement');
  if (result.reason === 'status' && result.message) return result.message;
  if (result.reason === 'status') return t('keyStatus', { provider, status: result.status });
  return t('keyRefused', { provider });
}

const AnimatedPath = Animated.createAnimatedComponent(Path);
// The tick on a 24 unit grid: down to (10.2, 15.6), then up to (17, 8.8).
const TICK = 'M7 12.4l3.2 3.2L17 8.8';
const TICK_LENGTH = 14.2;

/**
 * "It works": a green circle pops in (spring) and a white tick draws across it, once, when the
 * check comes back. Under Remove animations it shows finished at once.
 */
export function ConnectedMark({ t, size = 24 }: { t: V1T; size?: number }) {
  const reduceMotion = useReduceMotion();
  // Native-driven: the circle's pop. JS-driven: the tick's stroke (a separate view).
  const pop = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  const draw = useRef(new Animated.Value(reduceMotion ? 0 : TICK_LENGTH)).current;
  useEffect(() => {
    if (reduceMotion) {
      pop.setValue(1);
      draw.setValue(0);
      return;
    }
    Animated.spring(pop, { toValue: 1, speed: 16, bounciness: 9, useNativeDriver: true }).start();
    Animated.timing(draw, {
      toValue: 0,
      duration: 260,
      delay: 140,
      easing: Easing.bezier(0.65, 0, 0.35, 1),
      useNativeDriver: false,
    }).start();
  }, [reduceMotion, pop, draw]);
  return (
    <Animated.View
      accessible
      accessibilityLabel={t('works')}
      style={{
        width: size,
        height: size,
        opacity: pop.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0, 1, 1] }),
        transform: [{ scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }],
      }}
    >
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Circle cx={12} cy={12} r={11} fill={KEY_CHECK_COLORS.connected} />
        <AnimatedPath
          d={TICK}
          stroke="#FFFFFF"
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          strokeDasharray={TICK_LENGTH}
          strokeDashoffset={draw}
          // Hidden until the stroke starts, so its round end never shows as a dot first.
          strokeOpacity={draw.interpolate({
            inputRange: [0, TICK_LENGTH * 0.97, TICK_LENGTH],
            outputRange: [1, 1, 0],
          })}
        />
      </Svg>
    </Animated.View>
  );
}

/**
 * "Check connection" row value. Working is the green circled tick alone; checking, failed and
 * couldn't check say so in a word beside their mark.
 */
export function ConnectionValue({ t, state }: { t: V1T; state: KeyCheckState }) {
  if (state === 'connected') return <ConnectedMark t={t} />;
  const word =
    state === 'checking'
      ? t('checking')
      : state === 'failed'
        ? t('failed')
        : state === 'unverified'
          ? t('couldntCheck')
          : '';
  const color =
    state === 'failed'
      ? KEY_CHECK_COLORS.failed
      : state === 'unverified'
        ? KEY_CHECK_COLORS.unverified
        : home.tertiary;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Text style={[settings.rowValue, { color }]}>{word}</Text>
      {state !== 'idle' && <KeyCheckMark state={state} />}
    </View>
  );
}
