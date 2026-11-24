import { useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { useScrollToTop } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { useConfigStore } from '@/store/useConfigStore';
import { SegmentedControl } from '@/components/ui/SegmentedControl.android';
import { useTheme } from './ThemeProvider';
import { Toggle, showToast } from './settings/kit';
import { KIND_APPS } from './style/examples';
import {
  AppMarks,
  GlassCard,
  InAppPreview,
  KIND_ROW,
  KIND_SHORT,
  ToneSlider,
  useToneText,
} from './style/kit';
import { useStyleT } from './style/strings';
import {
  TONE_KINDS,
  TONE_OPTIONS,
  saveToneStyle,
  useToneStyle,
  type DictationTone,
  type ToneKind,
} from './style/toneStyle';

/**
 * The Style tab (Figma "Styles · Variant B", section 1): Tone & Style's switch, the kind of app,
 * one example drawn as it lands in that kind of app, and the tone slider. Picks save at once.
 * Off, everything stays visible but faded; the first switch-on runs the setup.
 */
export default function StyleScreen() {
  const t = useStyleT();
  const k = useTheme().tokens;
  const tone = useToneText();
  const style = useToneStyle();
  const ready = useConfigStore((s) => Boolean(s.config));
  const [kind, setKind] = useState<ToneKind>('personal');
  const [saving, setSaving] = useState(false);
  const scroll = useRef<ScrollView>(null);
  useScrollToTop(scroll);

  const save = async (change: Parameters<typeof saveToneStyle>[0], confirm: boolean) => {
    setSaving(true);
    try {
      await saveToneStyle(change);
      if (confirm) showToast(t('saved'), 'success', undefined, { aboveTabBar: true });
    } catch {
      showToast(t('saveFailed'), 'error', undefined, { aboveTabBar: true });
    } finally {
      setSaving(false);
    }
  };
  const setEnabled = (enabled: boolean) => {
    if (enabled && !style.setUp) {
      router.push('/android-tone-setup');
      return;
    }
    void save({ enabled }, false);
  };
  const pick = (next: DictationTone) => {
    if (next === style.tones[kind]) return;
    void save({ tones: { ...style.tones, [kind]: next } }, true);
  };

  const picked = style.tones[kind];
  const faded = !style.enabled;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: k.canvas }} edges={['top', 'left', 'right']}>
      <ScrollView
        ref={scroll}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 16,
          paddingBottom: 96,
          gap: 16,
          width: '100%',
          maxWidth: 680,
          alignSelf: 'center',
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text
              accessibilityRole="header"
              style={{ fontSize: 30, lineHeight: 38, fontWeight: '700', color: k.ink }}
            >
              {t('tabTitle')}
            </Text>
            <Text style={{ fontSize: 14, lineHeight: 18, color: k.secondary }}>
              {style.enabled ? t('subtitleOn') : t('subtitleOff')}
            </Text>
          </View>
          <Toggle
            value={style.enabled}
            onValueChange={setEnabled}
            disabled={!ready || saving}
            label={t('switchLabel')}
          />
        </View>
        <View style={{ gap: 16, opacity: faded ? 0.5 : 1 }}>
          <KindPicker value={kind} onChange={setKind} />
          <GlassCard radius={20} style={{ padding: 8 }}>
            <InAppPreview kind={kind} tone={picked} />
          </GlassCard>
          <GlassCard style={{ paddingTop: 14, paddingBottom: 12, paddingHorizontal: 16, gap: 12 }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <Text style={{ fontSize: 18, lineHeight: 23, fontWeight: '700', color: k.ink }}>
                {tone.name(picked)}
              </Text>
              <Text
                style={{
                  flexShrink: 1,
                  fontSize: 13,
                  lineHeight: 17,
                  color: k.secondary,
                  textAlign: 'right',
                }}
              >
                {tone.description(picked)}
              </Text>
            </View>
            <ToneSlider
              options={TONE_OPTIONS[kind]}
              value={picked}
              onChange={pick}
              disabled={!style.enabled || saving || !ready}
              label={t('toneSlider', { kind: t(KIND_ROW[kind]) })}
            />
          </GlassCard>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Four kinds of app on the shared tabs (inset track, raised picked tab), each with its app marks
 * cut out of the surface behind them.
 */
function KindPicker({ value, onChange }: { value: ToneKind; onChange: (kind: ToneKind) => void }) {
  const t = useStyleT();
  const k = useTheme().tokens;
  return (
    <SegmentedControl
      value={value}
      onChange={onChange}
      options={TONE_KINDS.map((kind) => ({
        value: kind,
        label: t(KIND_SHORT[kind]),
        accessibilityLabel: t(KIND_ROW[kind]),
        icon: (selected: boolean) => (
          <AppMarks
            logos={KIND_APPS[kind]}
            size={20}
            behind={selected ? k.raisedFill : k.track}
            overlap={6}
          />
        ),
      }))}
    />
  );
}
