import { View } from 'react-native';
import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Text } from '@/components/ui/Text';
import { useConfigStore } from '@/android/store/useConfigStore';
import { Glyph, type GlyphName } from '../onboarding/PracticeBubble';
import { GLASS_GRADIENT } from '../onboarding/kit';
import { Group, ListRow, SettingsPage, Toggle, useSettings } from './kit';
import { settingsLookFor, useSettingsLook } from './look';
import { makeStyles } from '../ThemeProvider';
import { useSettingsT, type SettingsKey } from './strings';
import { setBubbleAssistant, useBubbleAssistant } from './bubbleAppearance';
import { currentTranslateTarget } from './translateLanguages';

// The listening bubble's three logo bars at rest (BubbleFace): 5 wide, 10 apart, 9 / 20 / 9 on a
// 52 dp bubble, scaled to this 44 dp one.
const UNIT = 44 / 52;
const BARS = [9, 20, 9].map((height) => height * UNIT);
const BAR_WIDTH = 5 * UNIT;

/** A grey 36 tile holding one of the menu's own glyphs, for list rows. */
export function GlyphTile({ name }: { name: GlyphName }) {
  const styles = useStyles();
  const settings = useSettings();
  return (
    <View style={styles.listTile}>
      <Glyph name={name} size={16} color={settings.text} />
    </View>
  );
}

const MENU: { glyph: GlyphName; title: SettingsKey; body: SettingsKey }[] = [
  { glyph: 'sparkle', title: 'assistant', body: 'assistantRowBody' },
  { glyph: 'globe', title: 'translate', body: 'intoLanguage' },
  { glyph: 'pencil', title: 'editSelection', body: 'changeSelected' },
];

/** The hold menu beside the assistant bubble (glass, voice bars, star badge), as the bubble draws them. */
function MenuPreview({ language }: { language: string }) {
  const t = useSettingsT();
  const styles = useStyles();
  const settings = useSettings();
  return (
    <View accessible accessibilityLabel={t('assistantPreview')} style={styles.preview}>
      <View style={styles.bubble}>
        <LinearGradient
          colors={GLASS_GRADIENT}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.glass}
        >
          <View style={styles.bars}>
            {BARS.map((height, index) => (
              <View key={index} style={[styles.bar, { height }]} />
            ))}
          </View>
        </LinearGradient>
        <View style={styles.badge}>
          {/* The bubble's own badge colour (`BubbleColors.dot`), the same in both schemes. */}
          <Glyph name="sparkle" size={9} color="#1555D4" />
        </View>
      </View>
      <View style={styles.menu}>
        {MENU.map((row) => (
          <View key={row.title} style={styles.menuRow}>
            <View style={styles.menuTile}>
              <Glyph name={row.glyph} size={12} color={settings.text} />
            </View>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={styles.menuTitle}>
                {t(row.title)}
              </Text>
              <Text numberOfLines={1} style={styles.menuBody}>
                {t(row.body, { language })}
              </Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * Settings › Bubble › Assistant. On, holding the bubble opens its menu (Assistant, Translate, Edit
 * selection); off, a hold is hold to talk and the page shows only the graphic and the switch. The
 * assistant's model is a task on Processing; its look follows Size & look.
 */
export default function BubbleAssistantScreen() {
  const t = useSettingsT();
  const styles = useStyles();
  const settings = useSettings();
  const { edgeCard: cardStyle } = useSettingsLook();
  const on = useBubbleAssistant((s) => s.on);
  const target = currentTranslateTarget(useConfigStore((s) => s.config?.androidTranslationTarget));
  return (
    <SettingsPage title={t('assistant')}>
      <MenuPreview language={target.label} />
      <View style={cardStyle}>
        <View style={styles.switchRow}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={settings.rowTitle}>{t('assistant')}</Text>
            <Text style={settings.subtitle}>{t('assistantSwitchBody')}</Text>
          </View>
          <Toggle label={t('assistant')} value={on} onValueChange={setBubbleAssistant} />
        </View>
      </View>
      {on && (
        <Group title={t('inTheMenu')}>
          <ListRow
            leading={<GlyphTile name="sparkle" />}
            title={t('assistant')}
            subtitle={t('assistantRowBody')}
          />
          <ListRow
            leading={<GlyphTile name="globe" />}
            title={t('translate')}
            subtitle={t('intoLanguage', { language: target.label })}
            onPress={() => router.push('/android-translate-into')}
          />
          <ListRow
            leading={<GlyphTile name="pencil" />}
            title={t('editSelection')}
            subtitle={t('editSelectionBody')}
          />
        </Group>
      )}
    </SettingsPage>
  );
}

const useStyles = makeStyles((theme) => {
  const k = theme.tokens;
  const { look } = settingsLookFor(theme);
  return {
    listTile: {
      width: 36,
      height: 36,
      borderRadius: 10,
      backgroundColor: look.idleFill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    preview: {
      height: 160,
      borderRadius: 20,
      backgroundColor: look.selFill,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 20,
    },
    bubble: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
    glass: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
    },
    bars: { flexDirection: 'row', alignItems: 'center', gap: 10 * UNIT - BAR_WIDTH },
    bar: { width: BAR_WIDTH, borderRadius: BAR_WIDTH / 2, backgroundColor: k.onGlass },
    badge: {
      position: 'absolute',
      top: 0,
      right: 0,
      width: 15,
      height: 15,
      borderRadius: 8,
      // The bubble's own white badge, the same in both schemes.
      backgroundColor: '#FFFFFF',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: '0px 1px 2px rgba(0,0,0,0.12)',
    },
    menu: {
      width: 184,
      padding: 5,
      gap: 2,
      borderRadius: 16,
      ...theme.flat,
    },
    menuRow: {
      height: 36,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingLeft: 6,
      paddingRight: 8,
    },
    menuTile: {
      width: 22,
      height: 22,
      borderRadius: 7,
      backgroundColor: k.tile,
      alignItems: 'center',
      justifyContent: 'center',
    },
    menuTitle: { fontSize: 12, lineHeight: 15, fontWeight: '500', color: k.ink },
    menuBody: { fontSize: 10, lineHeight: 13, color: k.secondary },
    switchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 12,
      paddingLeft: 16,
      paddingRight: 12,
      minHeight: 64,
    },
  };
});
