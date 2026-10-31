import { useRef, useState } from 'react';
import { router } from 'expo-router';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { useConfigStore } from '@/store/useConfigStore';
import type { KeyboardTone, UserConfig } from '@/types';
import { Page, Card, Button, Row, styles, palette } from './ui';

const TONES = ['default', 'formal', 'casual', 'very_casual', 'excited'] as const;
const CONTEXTS = ['personal', 'work', 'email', 'notes'] as const;

export default function StyleScreen() {
  const { t } = useTranslation();
  const config = useConfigStore((s) => s.config);
  const context = config?.androidStyleContext ?? 'personal';
  const selectedTone = config?.androidStyleTones?.[context] ?? config?.keyboardTone ?? 'default';
  const [choosing, setChoosing] = useState(false);
  const [saving, setSaving] = useState(false);
  const savePending = useRef(false);
  const save = async (updates: Partial<UserConfig>): Promise<boolean> => {
    if (savePending.current) return false;
    savePending.current = true;
    setSaving(true);
    try {
      await useConfigStore.getState().updateConfig(updates);
      // This shared store reports persistence failures in state, not by rejecting.
      const state = useConfigStore.getState();
      if (state.error) throw new Error(state.error);
      return true;
    } catch (error) {
      Alert.alert(t('errorTitle'), (error as Error).message);
      return false;
    } finally {
      savePending.current = false;
      setSaving(false);
    }
  };
  const saveTone = async (tone: KeyboardTone) => {
    const current = useConfigStore.getState().config;
    if (await save({ androidStyleTones: { ...current?.androidStyleTones, [context]: tone } })) {
      setChoosing(false);
    }
  };
  return (
    <Page title={t('style')}>
      <Text accessibilityRole="header" style={styles.title}>
        {t('styleTitle')}
      </Text>
      <Text style={styles.body}>{t('styleBody')}</Text>
      <SegmentedControl
        value={context}
        disabled={saving || !config}
        scrollable
        options={CONTEXTS.map((value) => ({ value, label: t(value) }))}
        onChange={(value) => {
          void save({ androidStyleContext: value });
        }}
      />
      <Card>
        <Row
          title={t(selectedTone)}
          detail={t('tone')}
          disabled={saving || !config}
          onPress={() => setChoosing(true)}
        />
        {saving && !choosing ? (
          <ActivityIndicator accessibilityLabel={t('savingPreference')} color={palette.blue} />
        ) : null}
        <View style={{ backgroundColor: palette.soft, padding: 20, borderRadius: 14, gap: 14 }}>
          <Text style={[styles.caption, { color: palette.blue }]}>{t('examplePreview')}</Text>
          <Text style={{ fontSize: 18, lineHeight: 28, color: palette.ink }}>
            {t(`tonePreview_${selectedTone}`)}
          </Text>
        </View>
      </Card>
      {config?.cleanupEnabled === false && (
        <Text style={styles.body}>{t('styleNeedsCleanup')}</Text>
      )}
      <Row
        title={t('prompt')}
        icon="SlidersHorizontal"
        onPress={() => router.push('/(account)/cleanup-prompt')}
      />
      <Modal
        visible={choosing}
        transparent
        animationType="slide"
        onRequestClose={() => {
          if (!saving) setChoosing(false);
        }}
      >
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: '#00000055' }}>
          <Pressable
            cssInterop={false}
            accessibilityLabel={t('close')}
            accessibilityRole="button"
            disabled={saving}
            onPress={() => setChoosing(false)}
            style={{ flex: 1 }}
          />
          <SafeAreaView
            edges={['bottom']}
            style={{
              backgroundColor: palette.background,
              borderTopLeftRadius: 28,
              borderTopRightRadius: 28,
              maxHeight: '85%',
            }}
          >
            <ScrollView contentContainerStyle={styles.content}>
              <Text accessibilityRole="header" style={styles.heading}>
                {t('tone')}
              </Text>
              {saving ? (
                <ActivityIndicator
                  accessibilityLabel={t('savingPreference')}
                  color={palette.blue}
                />
              ) : null}
              <Card style={{ paddingVertical: 4, gap: 0 }}>
                {TONES.map((tone) => (
                  <Pressable
                    cssInterop={false}
                    key={tone}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selectedTone === tone, disabled: saving }}
                    disabled={saving}
                    onPress={() => {
                      void saveTone(tone);
                    }}
                    style={({ pressed }) => [
                      styles.row,
                      { minHeight: 56, opacity: pressed ? 0.6 : 1 },
                    ]}
                  >
                    <Text style={{ fontSize: 17, color: palette.ink }}>{t(tone)}</Text>
                    {selectedTone === tone && (
                      <SystemIcon name="checkmark" mdName="Check" color={palette.blue} size={20} />
                    )}
                  </Pressable>
                ))}
              </Card>
              <Button
                secondary
                disabled={saving}
                label={t('cancel')}
                onPress={() => setChoosing(false)}
              />
            </ScrollView>
          </SafeAreaView>
        </View>
      </Modal>
    </Page>
  );
}
