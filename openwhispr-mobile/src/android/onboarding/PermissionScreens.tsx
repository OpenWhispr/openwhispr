import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Image, Modal, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { Text } from '@/components/ui/Text';
import { AppFont } from '@/lib/fonts';
import {
  AndroidDictation,
  dictationEvents,
  type BubbleStatus,
} from '../../../modules/android-dictation/src';
import {
  AccentText,
  BubbleIcon,
  CircleButton,
  GlassButton,
  LinkButton,
  PillButton,
  PulseRings,
  Screen,
  colors,
  s,
} from './kit';
import { useOnboardingT } from './strings';
import { appIcon } from './AppsScreen';

const EMPTY: BubbleStatus = {
  overlay: false,
  accessibility: false,
  enabled: false,
  batteryExempt: false,
  microphone: false,
};

export function readStatus(): BubbleStatus {
  try {
    return AndroidDictation?.getStatus() ?? EMPTY;
  } catch {
    return EMPTY;
  }
}

// Status refreshes when the user comes back from Settings or the service reports a change.
export function useDictationStatus(onReturn?: (status: BubbleStatus) => void): BubbleStatus {
  const [status, setStatus] = useState(readStatus);
  const callback = useRef(onReturn);
  callback.current = onReturn;
  useEffect(() => {
    const refresh = () => {
      const next = readStatus();
      setStatus(next);
      return next;
    };
    const app = AppState.addEventListener('change', (state) => {
      if (state === 'active') callback.current?.(refresh());
    });
    const service = dictationEvents?.addListener('onStatusChange', refresh);
    return () => {
      app.remove();
      service?.remove();
    };
  }, []);
  return status;
}

function Toggle({ on }: { on: boolean }) {
  return (
    <View style={[p.toggle, on ? p.toggleOn : p.toggleOff]}>
      <View style={[p.knob, on ? { alignSelf: 'flex-end' } : null]} />
    </View>
  );
}

function SettingCard({ header, label, on }: { header?: string; label: string; on: boolean }) {
  return (
    <View style={p.settingCard}>
      {header ? (
        <View style={p.settingHeader}>
          <Text style={{ fontSize: 16, color: colors.ink, fontFamily: AppFont.medium }}>
            {header}
          </Text>
        </View>
      ) : null}
      <View style={p.settingRow}>
        <Text style={{ flex: 1, fontSize: 16, color: colors.ink }}>{label}</Text>
        <Toggle on={on} />
      </View>
    </View>
  );
}

export function OverlayScreen({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const t = useOnboardingT();
  const status = useDictationStatus((next) => {
    if (next.overlay) onNext();
  });
  return (
    <Screen
      onBack={onBack}
      right={<PillButton label={t('skip')} onPress={onNext} />}
      footer={
        <GlassButton
          label={t(status.overlay ? 'continue' : 'openSettings')}
          onPress={() => (status.overlay ? onNext() : AndroidDictation?.openSettings('overlay'))}
        />
      }
    >
      <AccentText center text={t('overlayTitle')} />
      <Text style={[s.body, { textAlign: 'center' }]}>{t('overlayBody')}</Text>
      <View style={p.overlayArt} importantForAccessibility="no-hide-descendants">
        <View style={[p.overlayBubble, s.center]}>
          <PulseRings size={72} />
          <BubbleIcon size={60} />
        </View>
        <View style={p.overlayCard}>
          <SettingCard header="OpenWhispr" label={t('overlaySetting')} on />
        </View>
        <Svg
          width="100%"
          height="100%"
          viewBox="0 0 361 300"
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        >
          <Path
            d="M 214 62 C 322 62 360 150 348 206 C 342 234 330 246 312 248"
            stroke={colors.accent}
            strokeWidth={2}
            fill="none"
            strokeLinecap="round"
          />
          <Path
            d="M 324 238 L 312 248 L 326 258"
            stroke={colors.accent}
            strokeWidth={2}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      </View>
    </Screen>
  );
}

export function AccessibilityScreen({
  onBack,
  onNext,
}: {
  onBack: () => void;
  onNext: () => void;
}) {
  const t = useOnboardingT();
  const [notice, setNotice] = useState(false);
  const [opened, setOpened] = useState(false);
  const status = useDictationStatus((next) => {
    if (next.accessibility) onNext();
  });
  const insets = useSafeAreaInsets();
  const steps = [
    {
      title: t('accessibilityStep1'),
      art: (
        <View style={p.settingCard}>
          <View style={p.settingRow}>
            <Text style={{ flex: 1, fontSize: 16, color: colors.ink }}>
              {t('accessibilityStep1Row')}
            </Text>
            <Text style={{ fontSize: 18, color: colors.tertiary }}>›</Text>
          </View>
        </View>
      ),
    },
    {
      title: t('accessibilityStep2'),
      art: <SettingCard header="‹  OpenWhispr" label={t('accessibilityStep2On')} on />,
    },
    {
      title: t('accessibilityStep3'),
      art: <SettingCard label={t('accessibilityShortcut')} on={false} />,
    },
  ];
  return (
    <Screen
      onBack={onBack}
      right={<PillButton label={t('skip')} onPress={onNext} />}
      footer={
        <>
          {opened && !status.accessibility ? (
            <Text style={[s.caption, { textAlign: 'center', marginBottom: 8 }]}>
              {t('waitingForSetting')}
            </Text>
          ) : null}
          <GlassButton
            label={t('continue')}
            onPress={() => (status.accessibility ? onNext() : setNotice(true))}
          />
        </>
      }
    >
      <AccentText center text={t('accessibilityTitle')} />
      <Text style={[s.body, { textAlign: 'center' }]}>{t('accessibilityBody')}</Text>
      <View style={{ gap: 14 }}>
        {steps.map((step, index) => (
          <View key={step.title} style={{ gap: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={p.number}>
                <Text style={{ color: colors.accent, fontSize: 13, fontFamily: AppFont.semibold }}>
                  {index + 1}
                </Text>
              </View>
              <Text style={{ fontSize: 17, color: colors.ink, fontFamily: AppFont.medium }}>
                {step.title}
              </Text>
            </View>
            <View style={{ paddingHorizontal: 16 }} importantForAccessibility="no-hide-descendants">
              {step.art}
            </View>
          </View>
        ))}
      </View>
      <Modal
        visible={notice}
        transparent
        animationType="slide"
        onRequestClose={() => setNotice(false)}
      >
        <View style={p.scrim}>
          <View style={[p.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
              <AccentText
                text={t('disclosureTitle')}
                style={{ flex: 1, fontSize: 24, lineHeight: 30 }}
              />
              <CircleButton icon="close" label={t('notNow')} onPress={() => setNotice(false)} />
            </View>
            <Text style={s.body}>{t('disclosureBody')}</Text>
            <View style={p.disclosure}>
              <Text style={{ fontSize: 19, color: colors.ink, fontFamily: AppFont.semibold }}>
                {t('disclosureWhat')}
              </Text>
              {(['disclosure1', 'disclosure2', 'disclosure3'] as const).map((key) => (
                <Text key={key} style={s.body}>
                  • {t(key)}
                </Text>
              ))}
            </View>
            <GlassButton
              label={t('agreeAndOpen')}
              onPress={() => {
                setNotice(false);
                setOpened(true);
                AndroidDictation?.openSettings('accessibility');
              }}
            />
            <LinkButton label={t('notNow')} onPress={() => setNotice(false)} />
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

export function BatteryScreen({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const t = useOnboardingT();
  const [opened, setOpened] = useState(false);
  const status = useDictationStatus(() => {
    if (opened) onNext();
  });
  const go = useCallback(() => {
    if (status.batteryExempt) return onNext();
    setOpened(true);
    AndroidDictation?.openSettings('battery');
  }, [onNext, status.batteryExempt]);
  return (
    <Screen
      onBack={onBack}
      footer={
        <>
          <GlassButton label={t('continue')} onPress={go} />
          <LinkButton label={t('skip')} onPress={onNext} />
        </>
      }
    >
      <AccentText center text={t('batteryTitle')} />
      <Text style={[s.body, { textAlign: 'center' }]}>{t('batteryBody')}</Text>
      <View style={p.keyboardArt} importantForAccessibility="no-hide-descendants">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={p.fakeField}>
            <Text style={{ color: colors.tertiary, fontSize: 15 }}>{t('messagePlaceholder')}</Text>
          </View>
          <View>
            <BubbleIcon size={44} />
            <View style={p.dot} />
          </View>
        </View>
        <View style={p.keys}>
          {[10, 9, 7].map((count, row) => (
            <View key={row} style={{ flexDirection: 'row', gap: 5, justifyContent: 'center' }}>
              {Array.from({ length: count }, (_, index) => (
                <View key={index} style={[p.key, row === 2 && index % 6 === 0 && { width: 36 }]} />
              ))}
            </View>
          ))}
        </View>
      </View>
      <View style={p.warning}>
        <Text style={{ color: colors.amberInk, fontSize: 15, lineHeight: 21 }}>
          {t('batteryWarning')}
        </Text>
      </View>
    </Screen>
  );
}

export function NotificationsScreen({
  onBack,
  onAllow,
  onSkip,
}: {
  onBack: () => void;
  onAllow: () => void;
  onSkip: () => void;
}) {
  const t = useOnboardingT();
  return (
    <Screen
      onBack={onBack}
      footer={
        <>
          <GlassButton label={t('allowNotifications')} onPress={onAllow} />
          <LinkButton label={t('skip')} onPress={onSkip} />
        </>
      }
    >
      <AccentText center text={t('notificationsTitle')} />
      <Text style={[s.body, { textAlign: 'center' }]}>{t('notificationsBody')}</Text>
      <View style={{ height: 170, marginTop: 8 }} importantForAccessibility="no-hide-descendants">
        <View style={[p.notification, p.notificationBack]}>
          <Image source={appIcon('whatsapp')} style={p.notificationIcon} />
          <View style={{ flex: 1 }}>
            <Text style={p.notificationMeta}>WhatsApp · {t('notificationAgo')}</Text>
            <Text style={p.notificationTitle}>{t('notificationFriend')}</Text>
            <Text style={p.notificationBody}>{t('notificationFriendMessage')}</Text>
          </View>
        </View>
        <View style={[p.notification, p.notificationFront]}>
          <BubbleIcon size={40} />
          <View style={{ flex: 1 }}>
            <Text style={p.notificationMeta}>
              {t('notificationApp')} · {t('notificationNow')}
            </Text>
            <Text style={p.notificationTitle}>{t('notificationTitle')}</Text>
            <Text style={p.notificationBody}>{t('notificationBody')}</Text>
          </View>
        </View>
      </View>
    </Screen>
  );
}

const p = StyleSheet.create({
  toggle: { width: 46, height: 26, borderRadius: 13, padding: 3, justifyContent: 'center' },
  toggleOn: { backgroundColor: colors.brandMid },
  toggleOff: { backgroundColor: '#D9D7D2' },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#FFFFFF' },
  settingCard: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    overflow: 'hidden',
    shadowColor: '#000000',
    shadowOpacity: 0.07,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },
  settingHeader: { backgroundColor: colors.surface2, paddingHorizontal: 16, paddingVertical: 12 },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    minHeight: 52,
    gap: 12,
  },
  overlayArt: { width: '100%', aspectRatio: 361 / 300, marginTop: 8 },
  overlayBubble: {
    position: 'absolute',
    left: '50%',
    top: 18,
    width: 88,
    height: 88,
    marginLeft: -44,
  },
  overlayCard: { position: 'absolute', left: 24, right: 40, top: '58%' },
  number: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.canvas,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 20,
    gap: 16,
  },
  disclosure: { backgroundColor: '#D9E0EE', borderRadius: 18, padding: 18, gap: 6 },
  keyboardArt: {
    backgroundColor: colors.surface,
    borderRadius: 24,
    padding: 14,
    gap: 12,
    marginTop: 8,
  },
  fakeField: {
    flex: 1,
    backgroundColor: colors.fill,
    borderRadius: 20,
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  dot: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#F28C1B',
    borderWidth: 2,
    borderColor: '#FFFFFF',
  },
  keys: { backgroundColor: colors.fill, borderRadius: 14, padding: 8, gap: 6 },
  key: { width: 24, height: 30, borderRadius: 5, backgroundColor: '#FFFFFF' },
  warning: {
    backgroundColor: colors.amberBg,
    borderColor: colors.amberLine,
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
  },
  notification: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: 22,
    padding: 14,
  },
  notificationBack: { left: 24, right: 24, top: 0, opacity: 0.5, backgroundColor: colors.surface2 },
  notificationFront: {
    left: 0,
    right: 0,
    top: 46,
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  notificationIcon: { width: 40, height: 40, borderRadius: 10 },
  notificationMeta: { fontSize: 13, color: colors.tertiary },
  notificationTitle: { fontSize: 17, color: colors.ink, fontFamily: AppFont.semibold },
  notificationBody: { fontSize: 14, color: colors.secondary },
});
