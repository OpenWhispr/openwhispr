import { useEffect, useState } from 'react';
import { View, Alert } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/Text';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { SettingsSwitch } from '@/components/ui/SettingsSwitch';
import { setPrivateMode } from '@/lib/workflowModeSwitch';
import {
  ANDROID_MODELS,
  modelReady,
  downloadAndroidModel,
  cancelAndroidDownload,
  removeAndroidModel,
  useModelDownloads,
  modelSupported,
  type AndroidModelId,
} from './models';
import { Button, Card, Page, Row, styles } from './ui';
import type { AndroidSpeechModelId } from './speechSelection';
import type { UserConfig } from '@/types';
import { speechModelSupportsLanguages } from './speechCapabilities';
import { getPreferredTranscriptionLanguages } from '@/lib/transcriptionLanguage';
export function ModelsContent({ onNavigate }: { onNavigate?: () => void } = {}) {
  const { t } = useTranslation();
  const config = useConfigStore((s) => s.config);
  const privateMode = useProcessingModeStore((s) => s.activeMode === 'private');
  const [requestedPrivateMode, setRequestedPrivateMode] = useState<boolean | null>(null);
  const [ready, setReady] = useState<Partial<Record<AndroidModelId, boolean>>>({});
  const [removing, setRemoving] = useState(false);
  const [expandedModel, setExpandedModel] = useState<AndroidModelId | null>(null);
  const [saving, setSaving] = useState(false);
  const progress = useModelDownloads((state) => state.progress);
  const activeDownloads = Object.keys(progress).sort().join(',');
  const save = async (updates: Partial<UserConfig>) => {
    setSaving(true);
    try {
      await useConfigStore.getState().updateConfig(updates);
      const error = useConfigStore.getState().error;
      if (error) throw new Error(error);
    } catch (error) {
      Alert.alert(t('errorTitle'), (error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const togglePrivateMode = async (enabled: boolean) => {
    if (requestedPrivateMode !== null) return;
    setRequestedPrivateMode(enabled);
    try {
      await setPrivateMode(enabled);
    } catch (error) {
      Alert.alert(t('errorTitle'), (error as Error).message);
    } finally {
      setRequestedPrivateMode(null);
    }
  };
  const refresh = async () => {
    const rows = await Promise.all(
      (Object.keys(ANDROID_MODELS) as AndroidModelId[]).map(async (id) => [
        id,
        await modelReady(id),
      ]),
    );
    setReady(Object.fromEntries(rows));
  };
  useEffect(() => {
    refresh().catch(() => undefined);
  }, [activeDownloads]);
  const download = async (id: AndroidModelId) => {
    try {
      await downloadAndroidModel(id);
      await refresh();
    } catch (error) {
      Alert.alert(t('errorTitle'), (error as Error).message);
    }
  };
  const remove = async (id: AndroidModelId) => {
    setRemoving(true);
    try {
      await removeAndroidModel(id);
      await refresh();
    } catch (error) {
      Alert.alert(t('errorTitle'), (error as Error).message);
    } finally {
      setRemoving(false);
    }
  };
  return (
    <>
      <Text style={styles.body}>{t('modelIntro')}</Text>
      <Row
        title={t('deviceCheck')}
        detail={t('deviceCheckSummary')}
        onPress={() => {
          onNavigate?.();
          router.push('/(account)/device-check');
        }}
      />
      <Card>
        <View style={styles.row}>
          <Text style={[styles.heading, { flex: 1 }]}>{t('privateMode')}</Text>
          <SettingsSwitch
            accessibilityLabel={t('privateMode')}
            value={requestedPrivateMode ?? privateMode}
            disabled={requestedPrivateMode !== null}
            onValueChange={(enabled) => {
              void togglePrivateMode(enabled);
            }}
          />
        </View>
        <Text style={styles.body}>{t('privateModeDescription')}</Text>
      </Card>
      <Card>
        <View style={styles.row}>
          <Text style={[styles.heading, { flex: 1 }]}>{t('cleanup')}</Text>
          <SettingsSwitch
            accessibilityLabel={t('cleanup')}
            value={config?.cleanupEnabled !== false}
            disabled={saving}
            onValueChange={(cleanupEnabled) => {
              void save({ cleanupEnabled });
            }}
          />
        </View>
      </Card>
      <Row
        title={t('workflow')}
        onPress={() => {
          onNavigate?.();
          router.push({ pathname: '/(account)/ai-workflow', params: { scope: 'dictation' } });
        }}
      />
      {(['speech', 'text'] as const).map((kind) => (
        <View key={kind} style={{ gap: 12 }}>
          <Text style={styles.heading}>{t(kind === 'speech' ? 'speechModels' : 'textModels')}</Text>
          {(
            Object.entries(ANDROID_MODELS) as [
              AndroidModelId,
              (typeof ANDROID_MODELS)[AndroidModelId],
            ][]
          )
            .filter(([, model]) => model.kind === kind)
            .map(([id, model]) => {
              const languageSupported =
                kind !== 'speech' ||
                speechModelSupportsLanguages(
                  id as AndroidSpeechModelId,
                  getPreferredTranscriptionLanguages(),
                );
              const chosen =
                kind === 'speech'
                  ? (config?.androidSpeechModel ?? 'parakeet-v3') === id
                  : (config?.androidTextModel ?? 'qwen-balanced') === id;
              return (
                <Card key={id}>
                  <Row
                    title={model.title}
                    detail={`${Math.round(model.bytes / 1000000)} MB${chosen ? ` · ${t('selected')}` : ''}${ready[id] ? ` · ${t('downloaded')}` : ''}`}
                    onPress={() => setExpandedModel(expandedModel === id ? null : id)}
                  />
                  {(expandedModel === id || progress[id] !== undefined) && (
                    <>
                      <Text style={styles.caption}>
                        {t(
                          id === 'qwen-small'
                            ? 'modelLight'
                            : id === 'parakeet-v3'
                              ? 'modelParakeet'
                              : id.startsWith('moonshine-')
                                ? 'modelMoonshine'
                                : 'modelBalanced',
                        )}
                      </Text>
                      {!languageSupported && (
                        <Text style={styles.body}>
                          {t(id === 'parakeet-v3' ? 'unsupportedLanguage' : 'moonshineEnglishOnly')}
                        </Text>
                      )}
                      {!modelSupported(id) ? (
                        <Text style={styles.body}>{t('moonshineAndroidVersion')}</Text>
                      ) : progress[id] !== undefined ? (
                        <>
                          <Text>{Math.round(progress[id]! * 100)}%</Text>
                          <Button
                            secondary
                            label={t('cancel')}
                            onPress={() => {
                              cancelAndroidDownload(id).catch(() => undefined);
                            }}
                          />
                        </>
                      ) : ready[id] ? (
                        <>
                          <Button
                            secondary
                            disabled={chosen || removing || saving || !languageSupported}
                            label={t(chosen ? 'selected' : 'choose')}
                            onPress={() => {
                              void save(
                                kind === 'speech'
                                  ? { androidSpeechModel: id as AndroidSpeechModelId }
                                  : { androidTextModel: id as 'qwen-small' | 'qwen-balanced' },
                              );
                            }}
                          />
                          <Button
                            secondary
                            disabled={removing}
                            label={t('removeModel')}
                            onPress={() => {
                              Alert.alert(model.title, t('removeModelConfirm'), [
                                { text: t('cancel'), style: 'cancel' },
                                {
                                  text: t('removeModel'),
                                  style: 'destructive',
                                  onPress: () => {
                                    void remove(id);
                                  },
                                },
                              ]);
                            }}
                          />
                        </>
                      ) : (
                        <Button
                          disabled={removing}
                          label={t('download')}
                          onPress={() => {
                            void download(id);
                          }}
                        />
                      )}
                    </>
                  )}
                </Card>
              );
            })}
        </View>
      ))}
    </>
  );
}
export default function ModelsScreen() {
  const { t } = useTranslation();
  return (
    <Page title={t('models')} back>
      <ModelsContent />
      <Card>
        <Text style={styles.heading}>{t('workflow')}</Text>
        {(['dictation', 'upload', 'cleanup', 'notes', 'agent'] as const).map((scope) => (
          <Row
            key={scope}
            title={t(
              scope === 'dictation'
                ? 'dictate'
                : scope === 'notes'
                  ? 'formatting'
                  : scope === 'agent'
                    ? 'assistant'
                    : scope,
            )}
            onPress={() => router.push({ pathname: '/(account)/ai-workflow', params: { scope } })}
          />
        ))}
      </Card>
    </Page>
  );
}
