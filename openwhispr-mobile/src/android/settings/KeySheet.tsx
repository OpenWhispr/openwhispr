import { useEffect, useRef, useState } from 'react';
import { Animated, Linking, Pressable, ScrollView, TextInput, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { home, type } from '../home/kit';
import {
  BottomSheet,
  PillAction,
  TextAction,
  cardStyle,
  settings,
  showToast,
  useReduceMotion,
} from './kit';
import { KEY_CHECK_COLORS, KeyCheckMark } from './KeyCheckMark';
import { useKeyCheck, type KeyCheckResult, type KeyProviderId } from './keyCheck';
import {
  KEY_PROVIDERS,
  SHEET_TASKS,
  applyKeyToTasks,
  maskKey,
  providerCanRun,
  savedKey,
  startingModel,
  type KeyTask,
  type SheetTask,
} from './ownKey';
import { useSettingsT, type SettingsKey, type SettingsT } from './strings';

const TASK_TITLE: Record<SheetTask, SettingsKey> = {
  dictation: 'dictation',
  upload: 'audioUploads',
  cleanup: 'textCleanup',
  notes: 'noteFormatting',
  meeting: 'meetings',
};

function reasonText(t: SettingsT, provider: string, result: KeyCheckResult): string {
  if (result.state === 'unverified') return t('keyNoAnswer', { provider });
  if (result.reason === 'managementKey') return t('keyManagement');
  if (result.reason === 'status') return t('keyStatus', { provider, status: result.status });
  return t('keyRefused', { provider });
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 36,
        paddingHorizontal: 14,
        borderRadius: 999,
        justifyContent: 'center',
        backgroundColor: selected ? home.accent : home.surface,
        borderWidth: selected ? 0 : 1,
        borderColor: home.borderSubtle,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Text style={[type.subhead, { color: selected ? '#FFFFFF' : home.text, fontWeight: '500' }]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Text that fades in after the mark has finished drawing (the reason under a refused key). */
function FadeIn({ children, delay }: { children: React.ReactNode; delay: number }) {
  const reduceMotion = useReduceMotion();
  const opacity = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  useEffect(() => {
    if (reduceMotion) return;
    Animated.timing(opacity, { toValue: 1, duration: 200, delay, useNativeDriver: true }).start();
  }, [delay, opacity, reduceMotion]);
  return <Animated.View style={{ opacity }}>{children}</Animated.View>;
}

/**
 * "Use your own key": pick a provider and paste the key. It checks itself half a second later,
 * then lists the tasks the key will run, each with the provider's model, and one button applies
 * it. A key already saved for the provider shows locked in, with Change to replace it.
 */
export function KeySheet({
  visible,
  onClose,
  initialProvider = 'openai',
  onlyTask,
}: {
  visible: boolean;
  onClose: () => void;
  initialProvider?: KeyProviderId;
  /** Opened from one task's page: only that task is ticked to start with. */
  onlyTask?: SheetTask;
}) {
  const t = useSettingsT();
  const activeMode = useProcessingModeStore((s) => s.activeMode);
  const [provider, setProvider] = useState<KeyProviderId>(initialProvider);
  const [draft, setDraft] = useState('');
  // A key that passed the check (or was saved before) is locked in and shown masked.
  const [locked, setLocked] = useState<string | null>(null);
  const [lockedSaved, setLockedSaved] = useState(false);
  const [unticked, setUnticked] = useState<SheetTask[]>([]);
  const [busy, setBusy] = useState(false);
  const check = useKeyCheck(provider, locked ? '' : draft);
  const name = KEY_PROVIDERS.find((item) => item.id === provider)!.name;

  useEffect(() => {
    if (!visible) return;
    setProvider(initialProvider);
    setUnticked(onlyTask ? SHEET_TASKS.filter((task) => task !== onlyTask) : []);
  }, [visible, initialProvider, onlyTask]);

  // A provider with a key already saved starts locked in, with nothing to check.
  useEffect(() => {
    if (!visible) return;
    let live = true;
    setDraft('');
    setLocked(null);
    setLockedSaved(false);
    void savedKey(provider)
      .catch(() => null)
      .then((key) => {
        if (!live || !key) return;
        setLocked(key);
        setLockedSaved(true);
      });
    return () => {
      live = false;
    };
  }, [visible, provider]);

  // The tick rests 620 ms after the answer, then the key locks in.
  useEffect(() => {
    if (check.state !== 'connected') return;
    const timer = setTimeout(() => setLocked(draft.trim()), 620);
    return () => clearTimeout(timer);
  }, [check.state, draft]);

  const runnable = SHEET_TASKS.filter((task) => providerCanRun(provider, task));
  // While On this phone is the default, uploads stay on the phone unless dictation moves too,
  // and meetings stay on it whatever the key.
  const blocked = (task: SheetTask) =>
    activeMode === 'private' &&
    ((task === 'upload' && unticked.includes('dictation')) ||
      (task === 'meeting' && unticked.includes('dictation')));
  const ticked = runnable.filter((task) => !unticked.includes(task) && !blocked(task));
  const transcribes = providerCanRun(provider, 'dictation');
  const writesText = providerCanRun(provider, 'cleanup');
  const accepted = !!locked;
  const failed = !accepted && check.state === 'failed';
  const markState = accepted ? 'connected' : check.state;

  const apply = async () => {
    if (!locked || !ticked.length || busy) return;
    setBusy(true);
    try {
      await applyKeyToTasks(provider, locked, ticked);
      showToast(t('keyUsed', { provider: name, count: ticked.length }), 'success');
      onClose();
    } catch {
      showToast(t('keySaveFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (task: SheetTask) =>
    setUnticked((current) =>
      current.includes(task) ? current.filter((item) => item !== task) : [...current, task],
    );

  const borderColor = failed
    ? KEY_CHECK_COLORS.failed
    : check.state === 'connected' && !lockedSaved && locked !== draft.trim()
      ? KEY_CHECK_COLORS.connected
      : home.borderSubtle;

  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('useOwnKey')}>
      <View style={{ gap: 8 }}>
        <Text style={[type.footnote, { color: home.secondary }]}>{t('provider')}</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          // The row scrolls to the sheet's edges.
          style={{ marginHorizontal: -16 }}
          contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
          accessibilityRole="radiogroup"
          accessibilityLabel={t('provider')}
        >
          {KEY_PROVIDERS.map((item) => (
            <Chip
              key={item.id}
              label={item.name}
              selected={item.id === provider}
              onPress={() => setProvider(item.id)}
            />
          ))}
        </ScrollView>
      </View>

      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={[type.footnote, { color: home.secondary }]}>{t('apiKey')}</Text>
          {accepted && (
            <Pressable
              cssInterop={false}
              accessibilityRole="button"
              hitSlop={12}
              onPress={() => {
                setLocked(null);
                setLockedSaved(false);
                setDraft('');
              }}
            >
              <Text style={[type.footnote, { color: home.accent, fontWeight: '500' }]}>
                {t('change')}
              </Text>
            </Pressable>
          )}
        </View>
        <View
          style={{
            minHeight: 48,
            borderRadius: 14,
            borderWidth: 1.5,
            borderColor,
            backgroundColor: home.surface,
            flexDirection: 'row',
            alignItems: 'center',
            paddingLeft: 16,
            paddingRight: 14,
            gap: 10,
          }}
        >
          {accepted ? (
            <Text
              style={[settings.title, { flex: 1, fontWeight: '400' }]}
              numberOfLines={1}
              accessibilityLabel={`${t('apiKey')} ${maskKey(locked!)}`}
            >
              {maskKey(locked!)}
            </Text>
          ) : (
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={t('pasteKey')}
              placeholderTextColor={home.tertiary}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              importantForAutofill="no"
              accessibilityLabel={t('apiKey')}
              style={[settings.title, { flex: 1, fontWeight: '400', paddingVertical: 12 }]}
            />
          )}
          {markState !== 'idle' && (
            <View
              accessible
              accessibilityLiveRegion="polite"
              accessibilityLabel={t('keyCheckState', {
                state: t(
                  markState === 'checking'
                    ? 'keyChecking'
                    : markState === 'connected'
                      ? 'keyAccepted'
                      : 'keyNotAccepted',
                ),
              })}
            >
              <KeyCheckMark state={markState} animate={!lockedSaved} />
            </View>
          )}
        </View>

        {!accepted && check.result && check.state !== 'connected' && (
          <FadeIn delay={check.state === 'failed' ? 400 : 0}>
            <Text
              style={[
                type.subhead,
                {
                  color: check.state === 'failed' ? KEY_CHECK_COLORS.failed : home.secondary,
                },
              ]}
            >
              {reasonText(t, name, check.result)}
            </Text>
            {check.state === 'unverified' && (
              <View style={{ alignSelf: 'flex-start' }}>
                <TextAction label={t('tryAgain')} onPress={check.retry} />
              </View>
            )}
          </FadeIn>
        )}
        {!accepted && check.state !== 'unverified' && (
          <Pressable
            cssInterop={false}
            accessibilityRole="link"
            onPress={() =>
              void Linking.openURL(KEY_PROVIDERS.find((item) => item.id === provider)!.keyUrl)
            }
            style={{ alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' }}
          >
            <Text style={[type.subhead, { color: home.accent }]}>
              {t('getKeyAt', {
                site: new URL(KEY_PROVIDERS.find((item) => item.id === provider)!.keyUrl).host,
              })}
            </Text>
          </Pressable>
        )}
      </View>

      {accepted && (
        <FadeIn delay={0}>
          <View style={{ gap: 8 }}>
            <Text style={[type.footnote, { color: home.secondary }]}>{t('keyWillRun')}</Text>
            <View style={[cardStyle, { overflow: 'hidden' }]}>
              {runnable.map((task, index) => {
                const on = ticked.includes(task);
                const off = blocked(task);
                return (
                  <Pressable
                    key={task}
                    cssInterop={false}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on, disabled: off }}
                    disabled={off}
                    onPress={() => toggle(task)}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      minHeight: 56,
                      paddingHorizontal: 16,
                      paddingVertical: 10,
                      gap: 12,
                      opacity: off ? 0.45 : pressed ? 0.7 : 1,
                      borderTopWidth: index ? 1 : 0,
                      borderTopColor: home.borderSubtle,
                    })}
                  >
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={settings.title}>{t(TASK_TITLE[task])}</Text>
                      <Text style={settings.subtitle}>
                        {off
                          ? t('notWithPhoneDefault')
                          : task === 'meeting'
                            ? t('liveModel', { model: startingModel(provider, task) })
                            : startingModel(provider, task)}
                      </Text>
                    </View>
                    {on && (
                      <SystemIcon name="checkmark" mdName="Check" size={22} color={home.accent} />
                    )}
                  </Pressable>
                );
              })}
              {[
                !transcribes && {
                  title: t('dictationAndUploads'),
                  body: t('cantTranscribe', { provider: name }),
                },
                !writesText && {
                  title: t('textCleanupAndNotes'),
                  body: t('cantWriteText', { provider: name }),
                },
              ].map(
                (row) =>
                  row && (
                    <View
                      key={row.title}
                      style={{
                        minHeight: 56,
                        paddingHorizontal: 16,
                        paddingVertical: 10,
                        gap: 2,
                        opacity: 0.45,
                        borderTopWidth: 1,
                        borderTopColor: home.borderSubtle,
                      }}
                    >
                      <Text style={settings.title}>{row.title}</Text>
                      <Text style={settings.subtitle}>{row.body}</Text>
                    </View>
                  ),
              )}
            </View>
          </View>
        </FadeIn>
      )}

      {(accepted || failed) && (
        // Room for the button's lift, so the sheet never clips it.
        <View style={{ paddingTop: 4, paddingBottom: 12 }}>
          <PillAction
            primary
            label={t('useForTasks', { count: accepted ? ticked.length : runnable.length })}
            disabled={!accepted || !ticked.length || busy}
            onPress={() => void apply()}
          />
        </View>
      )}
    </BottomSheet>
  );
}
