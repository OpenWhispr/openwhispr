import { useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  Pressable,
  View,
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Image } from 'expo-image';
import { SvgXml } from 'react-native-svg';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { glassEdge, gloss, glossPressed, home } from '../home/kit';
import { inset, knob, raised, raisedPressed, theme } from '../theme';
import { APP_LOGOS, type AppLogo } from './appLogos';
import { useTranslation } from 'react-i18next';
import { exampleResult, exampleSet, parseExample } from './examples';
import type { ExampleSet } from './examplesI18n';
import { useStyleT, type StyleKey } from './strings';
import type { DictationTone, ToneKind } from './toneStyle';

/** Tone & Style's colours (Figma "Styles · Variant B"). */
export const ink = {
  canvas: theme.canvas,
  segmentTrack: theme.track,
  preview: theme.surface2,
  theirBubble: theme.track,
  yourBubble: '#E3EBFC',
  dropped: 'rgba(102,99,110,0.45)',
  added: '#3466E2',
  track: theme.track,
  progressIdle: theme.trackStrong,
  dotIdle: theme.dotIdle,
  pickedRing: 'rgba(52,102,226,0.9)',
};

const LOGO_DISC = '#F4F4F2';

/**
 * One app mark on a ring the colour of the surface behind it, so overlapping marks look cut out
 * of each other. A white-background logo keeps a contrasting disc: light grey on white, white on
 * grey.
 */
export function AppMark({
  logo,
  size,
  behind,
  overlap = 0,
}: {
  logo: AppLogo;
  size: number;
  behind: string;
  overlap?: number;
}) {
  const onWhite = behind.toUpperCase() === '#FFFFFF';
  const xml = onWhite ? APP_LOGOS[logo] : APP_LOGOS[logo].replaceAll(LOGO_DISC, '#FFFFFF');
  return (
    <View
      style={{
        width: size + 4,
        height: size + 4,
        borderRadius: 999,
        backgroundColor: behind,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: -overlap,
      }}
    >
      <SvgXml xml={xml} width={size} height={size} />
    </View>
  );
}

export function AppMarks({
  logos,
  size,
  behind,
  overlap,
}: {
  logos: readonly AppLogo[];
  size: number;
  behind: string;
  overlap: number;
}) {
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: 'row', paddingRight: overlap }}
    >
      {logos.map((logo) => (
        <AppMark key={logo} logo={logo} size={size} behind={behind} overlap={overlap} />
      ))}
    </View>
  );
}

const TONE_NAME: Record<DictationTone, StyleKey> = {
  formal: 'toneFormal',
  casual: 'toneCasual',
  very_casual: 'toneVeryCasual',
  excited: 'toneExcited',
};
const TONE_DESCRIPTION: Record<DictationTone, StyleKey> = {
  formal: 'describeFormal',
  casual: 'describeCasual',
  very_casual: 'describeVeryCasual',
  excited: 'describeExcited',
};
export const KIND_SHORT: Record<ToneKind, StyleKey> = {
  personal: 'kindPersonal',
  work: 'kindWork',
  email: 'kindEmail',
  other: 'kindOther',
};
export const KIND_ROW: Record<ToneKind, StyleKey> = {
  personal: 'rowPersonal',
  work: 'rowWork',
  email: 'rowEmail',
  other: 'rowOther',
};

/** The tone examples in the app's language. */
export function useExamples(): ExampleSet {
  const { i18n } = useTranslation();
  return exampleSet(i18n.language);
}

export function useToneText() {
  const t = useStyleT();
  return {
    name: (tone: DictationTone) => t(TONE_NAME[tone]),
    description: (tone: DictationTone) => t(TONE_DESCRIPTION[tone]),
  };
}

/** A spoken line with the tone's edit shown: dropped words struck out, added words blue. */
export function DiffText({ example, width }: { example: string; width?: number }) {
  const parts = useMemo(() => parseExample(example), [example]);
  return (
    <Text style={{ fontSize: 15, lineHeight: 22, color: home.text, width }}>
      {parts.map((part, index) =>
        part.change === 'drop' ? (
          <Text
            key={index}
            style={{ color: ink.dropped, textDecorationLine: 'line-through', fontWeight: '400' }}
          >
            {part.text}
          </Text>
        ) : part.change === 'add' ? (
          <Text key={index} style={{ color: ink.added, fontWeight: '500' }}>
            {part.text}
          </Text>
        ) : (
          <Text key={index} style={{ fontWeight: '400' }}>
            {part.text}
          </Text>
        ),
      )}
    </Text>
  );
}

function PersonalPreview({ example, set }: { example: string; set: ExampleSet }) {
  return (
    <>
      <View
        style={{
          alignSelf: 'flex-start',
          backgroundColor: ink.theirBubble,
          paddingHorizontal: 13,
          paddingVertical: 9,
          borderTopLeftRadius: 18,
          borderTopRightRadius: 18,
          borderBottomRightRadius: 18,
          borderBottomLeftRadius: 6,
        }}
      >
        <Text style={{ fontSize: 15, lineHeight: 20, color: home.text }}>{set.question}</Text>
      </View>
      <View
        style={{
          alignSelf: 'flex-end',
          maxWidth: '88%',
          backgroundColor: ink.yourBubble,
          paddingHorizontal: 13,
          paddingVertical: 10,
          borderTopLeftRadius: 18,
          borderTopRightRadius: 18,
          borderBottomLeftRadius: 18,
          borderBottomRightRadius: 6,
        }}
      >
        <DiffText example={example} />
      </View>
    </>
  );
}

const ALEX = require('../../../assets/android/style/alex-morgan.jpg');

function WorkPreview({ example }: { example: string; set: ExampleSet }) {
  return (
    <>
      <Text style={{ fontSize: 12, lineHeight: 16, fontWeight: '500', color: home.secondary }}>
        # launch-team
      </Text>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Image source={ALEX} style={{ width: 30, height: 30, borderRadius: 8 }} />
        <View style={{ flex: 1, gap: 3 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
            <Text style={{ fontSize: 14, lineHeight: 18, fontWeight: '700', color: home.text }}>
              Alex Morgan
            </Text>
            <Text style={{ fontSize: 12, lineHeight: 16, color: home.secondary }}>6:20 PM</Text>
          </View>
          <DiffText example={example} />
        </View>
      </View>
    </>
  );
}

function EmailPreview({ example, set }: { example: string; set: ExampleSet }) {
  return (
    <>
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ fontSize: 13, lineHeight: 18, color: home.secondary }}>{set.to}</Text>
          <View
            style={{
              backgroundColor: '#FFFFFF',
              borderWidth: 1,
              borderColor: 'rgba(0,0,0,0.1)',
              borderRadius: 999,
              paddingHorizontal: 10,
              paddingVertical: 3,
            }}
          >
            <Text style={{ fontSize: 13, lineHeight: 17, fontWeight: '500', color: home.text }}>
              Sarah Chen
            </Text>
          </View>
        </View>
        <Text style={{ fontSize: 14, lineHeight: 18, fontWeight: '500', color: home.text }}>
          {set.subject}
        </Text>
      </View>
      <View style={{ height: 1, backgroundColor: 'rgba(0,0,0,0.06)' }} />
      <DiffText example={example} />
    </>
  );
}

function OtherPreview({ example, set }: { example: string; set: ExampleSet }) {
  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <SvgXml xml={APP_LOGOS.notion} width={18} height={18} />
        <Text style={{ fontSize: 13, lineHeight: 17, fontWeight: '500', color: home.secondary }}>
          {set.notes}
        </Text>
      </View>
      <DiffText example={example} />
    </>
  );
}

/** The example drawn as it lands in that kind of app, on the grey preview panel. */
export function InAppPreview({ kind, tone }: { kind: ToneKind; tone: DictationTone }) {
  const t = useStyleT();
  const set = useExamples();
  const example = set.examples[kind][tone] ?? '';
  const Preview =
    kind === 'personal'
      ? PersonalPreview
      : kind === 'work'
        ? WorkPreview
        : kind === 'email'
          ? EmailPreview
          : OtherPreview;
  return (
    <View
      accessible
      accessibilityLabel={t('exampleLabel', {
        kind: t(KIND_ROW[kind]),
        text: exampleResult(example),
      })}
      style={{ backgroundColor: ink.preview, borderRadius: 14, padding: 12, gap: 8 }}
    >
      <Preview example={example} set={set} />
    </View>
  );
}

/** The house glass card the Style tab draws its parts on. */
export function GlassCard({
  children,
  radius = 16,
  style,
}: {
  children: React.ReactNode;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[glassEdge, { borderRadius: radius }, style]}>{children}</View>;
}

const KNOB = 28;
const INSET = 14;

/**
 * A three-stop tone slider: drag the knob or tap a stop. TalkBack treats it as adjustable.
 */
export function ToneSlider({
  options,
  value,
  onChange,
  disabled,
  label,
}: {
  options: readonly DictationTone[];
  value: DictationTone;
  onChange: (tone: DictationTone) => void;
  disabled?: boolean;
  label: string;
}) {
  const tone = useToneText();
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  const index = Math.max(0, options.indexOf(value));
  const track = Math.max(0, width - INSET * 2);
  const stopX = (i: number) => INSET + (track * i) / (options.length - 1);
  const nearest = (x: number) =>
    Math.min(
      options.length - 1,
      Math.max(0, Math.round(((x - INSET) / (track || 1)) * (options.length - 1))),
    );
  const live = useRef({ index, nearest, onChange, options, disabled });
  live.current = { index, nearest, onChange, options, disabled };
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !live.current.disabled,
        onMoveShouldSetPanResponder: (_, g) => !live.current.disabled && Math.abs(g.dx) > 4,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (event) => setDrag(event.nativeEvent.locationX),
        onPanResponderMove: (event) => setDrag(event.nativeEvent.locationX),
        onPanResponderRelease: (event) => {
          setDrag(null);
          const next = live.current.nearest(event.nativeEvent.locationX);
          if (next !== live.current.index) live.current.onChange(live.current.options[next]);
        },
        onPanResponderTerminate: () => setDrag(null),
      }),
    [],
  );
  const knobX = drag === null ? stopX(index) : Math.min(width - INSET, Math.max(INSET, drag ?? 0));
  const step = (delta: number) => {
    const next = index + delta;
    if (next >= 0 && next < options.length) onChange(options[next]);
  };
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ text: tone.name(value) }}
      accessibilityState={{ disabled: Boolean(disabled) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event: AccessibilityActionEvent) =>
        step(event.nativeEvent.actionName === 'increment' ? 1 : -1)
      }
      onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
      {...pan.panHandlers}
      style={{ paddingTop: 36 }}
    >
      {/* Nothing inside takes the touch, so the slider reads every position against itself. */}
      <View
        pointerEvents="none"
        style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
      >
        <View
          style={{
            position: 'absolute',
            left: INSET,
            right: INSET,
            top: 11,
            height: 6,
            borderRadius: 3,
            ...inset,
          }}
        />
        {width > 0 &&
          options.map((option, i) => (
            <View
              key={option}
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: stopX(i) - 4,
                top: 10,
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: '#FFFFFF',
                borderWidth: 1,
                borderColor: 'rgba(0,0,0,0.12)',
              }}
            />
          ))}
        {width > 0 && (
          <View
            pointerEvents="none"
            style={[
              {
                position: 'absolute',
                left: knobX - KNOB / 2,
                top: 0,
                width: KNOB,
                height: KNOB,
                borderRadius: KNOB / 2,
              },
              knob,
            ]}
          />
        )}
      </View>
      {/* Each stop's name gets a third of the width and wraps there, so long names (Russian)
          never run into each other. */}
      <View pointerEvents="none" style={{ flexDirection: 'row', gap: 8 }}>
        {options.map((option, i) => (
          <Text
            key={option}
            numberOfLines={2}
            style={{
              flex: 1,
              textAlign: i === 0 ? 'left' : i === options.length - 1 ? 'right' : 'center',
              fontSize: 13,
              lineHeight: 17,
              fontWeight: i === index ? '700' : '500',
              color: i === index ? home.text : home.secondary,
            }}
          >
            {tone.name(option)}
          </Text>
        ))}
      </View>
    </View>
  );
}

/** The 36 raised close circle at the top left of every setup step. */
export function CloseButton({ onPress }: { onPress: () => void }) {
  const t = useStyleT();
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={t('close')}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [
        raised,
        {
          width: 36,
          height: 36,
          borderRadius: 18,
          alignItems: 'center',
          justifyContent: 'center',
        },
        pressed && raisedPressed,
      ]}
    >
      <SystemIcon name="xmark" mdName="X" size={16} color={home.text} />
    </Pressable>
  );
}

/** The full-width brand-glass CTA, 52 tall. */
export function GlassCta({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        {
          alignSelf: 'stretch',
          height: 52,
          borderRadius: 999,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.5 : 1,
        },
        gloss,
        pressed && !disabled && glossPressed,
      ]}
    >
      <Text style={{ fontSize: 17, lineHeight: 22, fontWeight: '700', color: '#FFFFFF' }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** The round blue check on the picked tone card. */
export function PickedCheck() {
  return (
    <View
      style={[
        {
          width: 26,
          height: 26,
          borderRadius: 13,
          alignItems: 'center',
          justifyContent: 'center',
        },
        gloss,
      ]}
    >
      <SystemIcon name="checkmark" mdName="Check" size={14} color="#FFFFFF" />
    </View>
  );
}
