import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useConfigStore } from '@/store/useConfigStore';
import { glassEdge, home } from '../home/kit';
import { showToast } from '../settings/kit';
import { useStyleT } from './strings';
import { TONE_STYLE_NUDGE_MIN_WORDS, saveToneStyle, useToneStyle } from './toneStyle';

/**
 * Home's nudge (Figma "Styles · Variant B", section 3): shown once 70 words have been dictated,
 * until Tone & Style is set up or Not now. Start Now opens the setup; it never opens by itself.
 */
export function ToneStyleNudge({ words }: { words: number | undefined }) {
  const t = useStyleT();
  const style = useToneStyle();
  const ready = useConfigStore((s) => Boolean(s.config));
  if (!ready || style.setUp || style.nudgeDismissed || (words ?? 0) < TONE_STYLE_NUDGE_MIN_WORDS)
    return null;
  const dismiss = () => {
    saveToneStyle({ nudgeDismissed: true }).catch(() =>
      showToast(t('saveFailed'), 'error', undefined, { aboveTabBar: true }),
    );
  };
  return (
    <View style={[glassEdge, { borderRadius: 20, padding: 16, gap: 14 }]}>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            backgroundColor: home.tint,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <SystemIcon name="sparkles" mdName="Sparkles" size={18} color={home.accent} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontSize: 17, lineHeight: 22, fontWeight: '500', color: home.text }}>
            {t('nudgeTitle')}
          </Text>
          <Text style={{ fontSize: 15, lineHeight: 20, color: home.secondary }}>
            {t('nudgeBody')}
          </Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: 8, paddingLeft: 48 }}>
        <FlatPill label={t('notNow')} color={home.secondary} onPress={dismiss} />
        <FlatPill
          label={t('startNow')}
          color={home.accent}
          onPress={() => router.push('/android-tone-setup')}
        />
      </View>
    </View>
  );
}

/** A flat outline pill, since it sits inside a card. */
function FlatPill({
  label,
  color,
  onPress,
}: {
  label: string;
  color: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        paddingHorizontal: 18,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: 'rgba(0,0,0,0.12)',
        backgroundColor: pressed ? '#F1F1F0' : '#FFFFFF',
        alignItems: 'center',
        justifyContent: 'center',
      })}
    >
      <Text style={{ fontSize: 15, lineHeight: 20, fontWeight: '500', color }}>{label}</Text>
    </Pressable>
  );
}
