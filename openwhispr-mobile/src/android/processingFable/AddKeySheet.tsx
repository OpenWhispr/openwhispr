import { useEffect, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { home, type } from '../home/kit';
import { BottomSheet, TextAction, settings, showToast } from '../settings/kit';
import { useKeyCheck, type KeyCheckResult, type KeyProviderId } from '../settings/keyCheck';
import { KEY_PROVIDERS, maskKey, type SheetTask } from '../settings/ownKey';
import { isLiveProvider } from '../providers/liveMeeting';
import {
  SOURCE_GROUPS,
  addSource,
  normalizeServer,
  sourceName,
  sourceTasks,
  useServerCheck,
  type ServerCheck,
  type Source,
} from './places';
import { useFableT, type FableKey, type FableT } from './strings';
import { GlassButton, ProviderMark, Tile } from './look';
import {
  ChipRow,
  Field,
  RadioRow,
  Reason,
  SectionLabel,
  SheetCard,
  SlideIn,
  TaskChip,
  taskChip,
} from './ui';

/** What each provider can run, as its row and the line under the field say it. */
const CAPABILITY: Record<Source, { row: FableKey; line?: FableKey }> = {
  openai: { row: 'capOpenai', line: 'lineOpenai' },
  groq: { row: 'capGroq', line: 'lineGroq' },
  deepgram: { row: 'capSpeech', line: 'lineSpeech' },
  assemblyai: { row: 'capSpeech', line: 'lineSpeech' },
  openrouter: { row: 'capText', line: 'lineText' },
  custom: { row: 'capCustom' },
};

function keyReason(t: FableT, provider: string, result: KeyCheckResult): string {
  if (result.state === 'unverified') return t('keyNoAnswer', { provider });
  if (result.reason === 'managementKey') return t('keyManagement');
  if (result.reason === 'status') return t('keyStatus', { provider, status: result.status });
  return t('keyRefused', { provider });
}

/** What a key runs, as Processing's chips; read out as the sentence they replace. */
function Capability({ t, tasks, line }: { t: FableT; tasks: SheetTask[]; line: string }) {
  return (
    <View accessible accessibilityLabel={line}>
      <ChipRow>
        {tasks.map((task) => (
          <TaskChip key={task} {...taskChip(t, task, 'key')} />
        ))}
      </ChipRow>
    </View>
  );
}

/** The button names the result: "Use for all 5 tasks", "Use for 3 tasks". */
function buttonLabel(t: FableT, count: number) {
  return count === 5 ? t('useForAll', { count }) : t('useForTasks', { count });
}

/** "OpenAI key added. It runs all 5 tasks." */
function addedMessage(t: FableT, source: Source, count: number): string {
  const provider = sourceName(source);
  if (source === 'custom') return count ? t('serverAddedRuns', { count }) : t('serverAdded');
  if (!count) return t('keyAdded', { provider });
  return count === 5 ? t('keyAddedAll', { provider }) : t('keyAddedRuns', { provider, count });
}

/** The grouped provider list that slides into the sheet (6C2): a card per group. */
function ProviderList({
  t,
  current,
  onChoose,
}: {
  t: FableT;
  current: Source;
  onChoose: (source: Source) => void;
}) {
  return (
    <>
      {SOURCE_GROUPS.map((group) => (
        <View key={group.title} style={{ gap: 8 }}>
          <SectionLabel>{t(group.title)}</SectionLabel>
          <SheetCard>
            {group.ids.map((id) => (
              <RadioRow
                key={id}
                leading={
                  <Tile
                    kind={id !== 'custom' ? 'logo' : id === current ? 'sel' : 'idle'}
                    source={id}
                  />
                }
                title={sourceName(id)}
                tag={isLiveProvider(id) ? { label: t('live') } : undefined}
                subtitle={t(CAPABILITY[id].row)}
                selected={id === current}
                onPress={() => onChoose(id)}
              />
            ))}
          </SheetCard>
        </View>
      ))}
    </>
  );
}

/**
 * "Add a key" (K1–K5, 6C): a Provider field preset to OpenAI that slides in the grouped list,
 * the key checked half a second after it's pasted, and a button that names what it'll do. A
 * custom server swaps in its address, checked against the server's model list. One key a visit.
 */
export function AddKeySheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useFableT();
  const [page, setPage] = useState<'main' | 'providers'>('main');
  const [source, setSource] = useState<Source>('openai');
  const [draft, setDraft] = useState('');
  const [address, setAddress] = useState('');
  const [serverKey, setServerKey] = useState('');
  const [locked, setLocked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const custom = source === 'custom';
  const check = useKeyCheck(
    (custom ? 'openai' : source) as KeyProviderId,
    custom || locked ? '' : draft,
  );
  const server = useServerCheck(custom ? address : '', serverKey);
  const name = sourceName(source);

  useEffect(() => {
    if (!visible) return;
    setPage('main');
    setSource('openai');
    setDraft('');
    setAddress('');
    setServerKey('');
    setLocked(null);
  }, [visible]);

  // A key that passed the check locks in (K2); Change opens it again.
  useEffect(() => {
    if (check.state === 'connected' && !custom) setLocked(draft.trim());
  }, [check.state, custom, draft]);

  const choose = (next: Source) => {
    setSource(next);
    setDraft('');
    setLocked(null);
    setPage('main');
  };

  const found = server.result?.state === 'connected' ? server.result : null;
  const serverTasks = found
    ? [
        ...(found.speech?.length ? (['dictation', 'upload'] as const) : []),
        ...(found.text?.length ? (['cleanup', 'notes', 'agent'] as const) : []),
      ]
    : [];
  const count = custom ? serverTasks.length : sourceTasks(source).length;
  const accepted = custom ? !!found : !!locked;

  const save = async (useForAll: boolean) => {
    if (busy || !accepted) return;
    setBusy(true);
    try {
      const { tasks, undo } = await addSource(
        source,
        custom ? serverKey : locked!,
        useForAll,
        custom && found
          ? {
              endpoint: found.endpoint ?? normalizeServer(address),
              speech: found.speech ?? [],
              text: found.text ?? [],
            }
          : undefined,
      );
      onClose();
      showToast(addedMessage(t, source, tasks.length), 'success', {
        label: t('undo'),
        onPress: () => void undo().catch(() => undefined),
        onClose: () => undefined,
      });
    } catch {
      showToast(t('keySaveFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (page === 'providers')
    return (
      <BottomSheet
        visible={visible}
        onClose={onClose}
        title={t('chooseProvider')}
        onBack={() => setPage('main')}
      >
        <SlideIn pageKey="providers">
          <ProviderList t={t} current={source} onChoose={choose} />
        </SlideIn>
      </BottomSheet>
    );

  const keyFailed = !custom && !locked && check.state === 'failed';
  const keyUnverified = !custom && !locked && check.state === 'unverified';
  const serverResult = server.result as ServerCheck | null;
  const serverRefusedKey =
    custom && serverResult?.state === 'failed' && serverResult.reason === 'rejected';
  const addressFailed = custom && serverResult?.state === 'failed' && !serverRefusedKey;
  const keyUrl = KEY_PROVIDERS.find((item) => item.id === source)?.keyUrl;

  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('addAKey')}>
      <SlideIn pageKey="main" back>
        <Field
          label={t('provider')}
          value={name}
          chevron
          leading={<ProviderMark source={source} size={18} />}
          onPress={() => setPage('providers')}
        />

        {custom ? (
          <>
            <View style={{ gap: 8 }}>
              <Field
                label={t('serverAddress')}
                action={found ? { label: t('change'), onPress: () => setAddress('') } : undefined}
                value={address}
                onChangeText={setAddress}
                placeholder="https://"
                keyboardType="url"
                locked={!!found}
                mark={serverRefusedKey ? 'idle' : server.state}
                failed={addressFailed}
              />
              {addressFailed ? (
                <Reason
                  failed
                  text={t(serverResult?.invalidAddress ? 'serverInvalid' : 'serverUnreachable')}
                />
              ) : (
                !found && (
                  <Text style={[settings.subtitle, { paddingHorizontal: 2 }]}>
                    {t('serverExample')}
                  </Text>
                )
              )}
            </View>
            <View style={{ gap: 8 }}>
              <Field
                label={t('serverKey')}
                value={found && serverKey ? maskKey(serverKey) : serverKey}
                onChangeText={setServerKey}
                placeholder={t('pasteTheKey')}
                secure
                locked={!!found && !!serverKey}
                failed={serverRefusedKey}
              />
              {serverRefusedKey && (
                <Reason failed text={t(serverKey.trim() ? 'serverRefusedKey' : 'serverNeedsKey')} />
              )}
            </View>
            {found && (
              <View style={{ gap: 8 }}>
                {serverTasks.length > 0 && (
                  <ChipRow>
                    {serverTasks.map((task) => (
                      <TaskChip key={task} {...taskChip(t, task, 'key')} />
                    ))}
                  </ChipRow>
                )}
                <Text style={[type.subhead, { fontSize: 14, color: home.secondary }]}>
                  {t(
                    found.speech?.length && found.text?.length
                      ? 'foundBoth'
                      : found.speech?.length
                        ? 'foundSpeech'
                        : found.text?.length
                          ? 'foundText'
                          : 'foundNone',
                  )}
                </Text>
              </View>
            )}
          </>
        ) : (
          <>
            {CAPABILITY[source].line && (
              <Capability t={t} tasks={sourceTasks(source)} line={t(CAPABILITY[source].line!)} />
            )}
            <View style={{ gap: 8 }}>
              <Field
                label={t('apiKey')}
                action={
                  locked
                    ? {
                        label: t('change'),
                        onPress: () => {
                          setLocked(null);
                          setDraft('');
                        },
                      }
                    : undefined
                }
                value={locked ? maskKey(locked) : draft}
                onChangeText={setDraft}
                placeholder={t('pasteProviderKey', { provider: name })}
                secure
                locked={!!locked}
                mark={locked ? 'connected' : check.state}
                failed={keyFailed}
              />
              {(keyFailed || keyUnverified) && check.result && (
                <View
                  style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}
                >
                  <Reason failed={keyFailed} text={keyReason(t, name, check.result)} />
                  {keyUnverified && (
                    <Pressable
                      cssInterop={false}
                      accessibilityRole="button"
                      onPress={check.retry}
                      hitSlop={8}
                    >
                      <Text style={[type.subhead, { color: home.accent, fontWeight: '500' }]}>
                        {t('tryAgain')}
                      </Text>
                    </Pressable>
                  )}
                </View>
              )}
              {!locked && !keyFailed && !keyUnverified && keyUrl && (
                <Pressable
                  cssInterop={false}
                  accessibilityRole="link"
                  onPress={() => void Linking.openURL(keyUrl)}
                  style={{ alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' }}
                >
                  <Text style={[type.subhead, { color: home.accent }]}>
                    {t('getKeyAt', { site: new URL(keyUrl).host })}
                  </Text>
                </Pressable>
              )}
            </View>
          </>
        )}

        <View style={{ paddingTop: 4, paddingBottom: 8, gap: 4 }}>
          {custom && !found ? (
            <GlassButton
              label={t('checkServer')}
              disabled={!normalizeServer(address) || server.state === 'checking'}
              onPress={server.run}
            />
          ) : (
            <GlassButton
              label={buttonLabel(t, count)}
              disabled={!accepted || !count || busy}
              onPress={() => void save(true)}
            />
          )}
          {accepted && (
            <TextAction
              label={t(custom ? 'saveServerOnly' : 'saveKeyOnly')}
              onPress={() => void save(false)}
            />
          )}
        </View>
      </SlideIn>
    </BottomSheet>
  );
}
