import { useCallback, useEffect, useState } from 'react';
import { View, ScrollView, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/Text';
import { OpenWhisprMark } from '@/components/ui/OpenWhisprMark';
import AuthScreen from '@/screens/AuthScreen';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { Button, styles, palette, Card } from './ui';
import { LanguageSheet } from './LanguageSheet';
import { ModelsContent } from './ModelsScreen';
import { PermissionsContent } from './PermissionsScreen';
import { Practice } from './Practice';

export { PlanContent as ProContent } from './PlanContent';
import { PlanContent as ProContent } from './PlanContent';
// Steps 4–6 used to practise Translate, Write and Edit. The beta bubble dictates only, so they
// are skipped; step numbers stay the same so a saved step still opens the right page.
const PRACTICE_STEP = 3;
const SKIPPED_STEPS = [4, 5, 6];
const SHOWN_STEPS = 10 - SKIPPED_STEPS.length;
function normalizeStep(step: number): number {
  return SKIPPED_STEPS.includes(step) ? PRACTICE_STEP : step;
}
function nextStep(step: number): number {
  return step === PRACTICE_STEP ? Math.max(...SKIPPED_STEPS) + 1 : step + 1;
}
function previousStep(step: number): number {
  return normalizeStep(step - 1);
}
function shownStep(step: number): number {
  return step > PRACTICE_STEP ? step + 1 - SKIPPED_STEPS.length : step + 1;
}
export function Onboarding({ onFinish }: { onFinish: () => void }) {
  const { t } = useTranslation();
  const [step, setStep] = useState(() =>
    normalizeStep(Number(localStorage.getItem('android-onboarding-step') || 0)),
  );
  const [language, setLanguage] = useState(false);
  const [models, setModels] = useState(false);
  const [passed, setPassed] = useState(false);
  const user = useAuthStore((s) => s.user);
  const config = useConfigStore((s) => s.config);
  const advance = useCallback(() => {
    const next = nextStep(step);
    localStorage.setItem('android-onboarding-step', String(next));
    setPassed(false);
    setStep(next);
  }, [step]);
  useEffect(() => {
    if (step === 1 && user && !user.isAnonymous) advance();
  }, [user, step, advance]);
  const local = async () => {
    await useAuthStore.getState().continueAsGuest();
    await useConfigStore.getState().updateConfig({
      defaultMode: 'private',
      cleanupEnabled: true,
      cloudBackupEnabled: false,
      inference: {
        dictation: { mode: 'local' },
        cleanup: { mode: 'local' },
        notes: { mode: 'local' },
        agent: { mode: 'local' },
      },
    });
    advance();
  };
  if (step === 1)
    return (
      <AuthScreen
        onClose={() => setStep(0)}
        onGuestContinue={() => {
          void local();
        }}
      />
    );
  const practice = step === PRACTICE_STEP;
  return (
    <SafeAreaView style={styles.page}>
      <View style={[styles.row, { padding: 24 }]}>
        <OpenWhisprMark size={28} color={palette.blue} />
        <Text style={{ fontWeight: '600' }}>OpenWhispr</Text>
        <Text style={styles.caption}>
          {shownStep(step)} / {SHOWN_STEPS}
        </Text>
      </View>
      <View style={{ height: 3, marginHorizontal: 24, backgroundColor: palette.line }}>
        <View
          style={{
            height: 3,
            backgroundColor: palette.blue,
            width: `${(shownStep(step) / SHOWN_STEPS) * 100}%`,
          }}
        />
      </View>
      <ScrollView
        contentContainerStyle={[styles.content, { flexGrow: 1, paddingTop: 32 }]}
        keyboardShouldPersistTaps="handled"
      >
        {step === 0 && (
          <>
            <View style={{ marginVertical: 30 }}>
              <OpenWhisprMark size={90} color={palette.blue} />
            </View>
            <Text style={styles.title}>{t('title')}</Text>
            <Text style={styles.body}>{t('intro')}</Text>
            <Card style={{ marginTop: 24 }}>
              <Text style={styles.heading}>{t('private')}</Text>
              <Text style={styles.body}>{t('privateBody')}</Text>
            </Card>
          </>
        )}
        {step === 2 && (
          <>
            <Text style={styles.title}>{t('setupTitle')}</Text>
            <Text style={styles.body}>{t('setupBody')}</Text>
            <Button
              secondary
              label={`${t('language')} · ${config?.preferredLanguage ?? t('auto')}`}
              onPress={() => setLanguage(true)}
            />
            <Card>
              <Text style={styles.body}>{t('downloadNeeded')}</Text>
              <Button label={t('openModels')} onPress={() => setModels(true)} />
            </Card>
          </>
        )}
        {practice && (
          <>
            <Text style={styles.heading}>{t('practiceTitle')}</Text>
            <Text style={styles.caption}>{t('practiceBody')}</Text>
            <Practice visible={!models && !language} onSuccess={() => setPassed(true)} />
            <Button secondary label={t('openModels')} onPress={() => setModels(true)} />
          </>
        )}
        {step === 7 && (
          <>
            <Text style={styles.title}>{t('acrossTitle')}</Text>
            <PermissionsContent />
          </>
        )}
        {step === 8 && <ProContent />}
        {step >= 9 && (
          <>
            <OpenWhisprMark size={80} color={palette.blue} />
            <Text style={styles.title}>{t('ready')}</Text>
            <Text style={styles.body}>{t('readyBody')}</Text>
            <Card>
              <Text style={styles.heading}>Messages · Gmail · Slack</Text>
              <Text style={styles.body}>{t('acrossBody')}</Text>
            </Card>
          </>
        )}
      </ScrollView>
      <View style={{ padding: 24, gap: 10 }}>
        <Button
          label={t(
            step === 0
              ? 'getStarted'
              : step === 7
                ? 'next'
                : step === 8
                  ? 'continueFree'
                  : step >= 9
                    ? 'startWriting'
                    : 'next',
          )}
          disabled={practice && !passed}
          onPress={step >= 9 ? onFinish : advance}
        />
        {step > 1 && (
          <Button
            secondary
            label={t('back')}
            onPress={() => {
              const previous = previousStep(step);
              localStorage.setItem('android-onboarding-step', String(previous));
              setStep(previous);
              setPassed(false);
            }}
          />
        )}
      </View>
      <LanguageSheet
        visible={language}
        selected={config?.preferredLanguage ?? 'auto'}
        onClose={() => setLanguage(false)}
        onSelect={(code) => {
          useConfigStore
            .getState()
            .updateConfig({ preferredLanguage: code, languages: code === 'auto' ? [] : [code] });
        }}
      />
      <Modal visible={models} animationType="slide" onRequestClose={() => setModels(false)}>
        <SafeAreaView style={styles.page}>
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={styles.heading}>{t('models')}</Text>
            <ModelsContent onNavigate={() => setModels(false)} />
          </ScrollView>
          <View style={{ padding: 24 }}>
            <Button label={t('done')} onPress={() => setModels(false)} />
          </View>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}
