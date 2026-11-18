import { useEffect, useRef, useState } from 'react';
import { Alert, Linking, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { home } from '../home/kit';
import {
  Group,
  ListRow,
  PillAction,
  SettingsPage,
  TextAction,
  settings,
  showToast,
} from '../settings/kit';
import { KEY_CHECK_COLORS, KeyCheckMark } from '../settings/KeyCheckMark';
import { useKeyCheck, type KeyProviderId } from '../settings/keyCheck';
import {
  KEY_PROVIDERS,
  SHEET_TASKS,
  maskKey,
  runTaskOnKey,
  saveKey,
  type SheetTask,
} from '../settings/ownKey';
import { setTask } from '../settings/processingDefault';
import { editDraft, useKeyDraft } from './draft';
import {
  customSelection,
  normalizeServer,
  removeKey,
  saveCustomServer,
  sourceName,
  useCustomServer,
  useSavedSecret,
  useServerCheck,
  type KeySource,
} from './logic';
import { CheckMark, FieldCard, reasonText } from './ui';
import { useV1T } from './strings';

/**
 * 9.4 API key: paste the key, which checks itself half a second later; Get a key leaves for
 * the provider's page (9.5); Remove key asks first (9.6). From Processing the key goes back to
 * its unsaved choice; from anywhere else Done saves it, once for every task on this provider.
 * `task` (from a task page) also moves that task onto the key.
 */
export default function ApiKeyScreenV1() {
  const t = useV1T();
  const params = useLocalSearchParams<{ provider?: string; from?: string; task?: string }>();
  const source = (params.provider ?? 'openai') as KeySource;
  const fromProcessing = params.from === 'processing';
  const task = SHEET_TASKS.find((item) => item === params.task) as SheetTask | undefined;
  const custom = source === 'custom';
  const name = sourceName(source);
  const draft = useKeyDraft();
  const storedServer = useCustomServer((s) => s.endpoint);

  const [typed, setTyped] = useState(fromProcessing ? (custom ? draft.serverKey : draft.key) : '');
  const [server, setServer] = useState(fromProcessing ? draft.server : (storedServer ?? ''));
  const [busy, setBusy] = useState(false);

  const savedSecret = useSavedSecret(source, custom ? storedServer : undefined);
  // A custom server with no key reads as ''; nothing to show then.
  const saved = savedSecret || null;

  const keyCheck = useKeyCheck(custom ? 'openai' : (source as KeyProviderId), custom ? '' : typed);
  const serverCheck = useServerCheck(custom ? server : '', typed || saved || '');
  const check = custom ? serverCheck : keyCheck;
  // The tick locks the key in (620 ms after it lands), as the key sheet does.
  const [locked, setLocked] = useState(false);
  const lockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (lockTimer.current) clearTimeout(lockTimer.current);
    if (custom || check.state !== 'connected') return;
    lockTimer.current = setTimeout(() => setLocked(true), 620);
    return () => {
      if (lockTimer.current) clearTimeout(lockTimer.current);
    };
  }, [check.state, custom]);

  const provider = KEY_PROVIDERS.find((item) => item.id === source);
  // A saved key shows locked in with its tick, until Change.
  const [changing, setChanging] = useState(false);
  const savedShown = !custom && !!saved && !typed && !changing;
  const showing = savedShown ? maskKey(saved) : typed ? (locked ? maskKey(typed) : typed) : '';
  const usable = custom
    ? !!normalizeServer(server) && (check.state === 'connected' || check.state === 'unverified')
    : !typed || check.state === 'connected' || check.state === 'unverified';

  const done = async () => {
    if (!usable || busy) return;
    if (fromProcessing) {
      if (custom) editDraft({ server, serverKey: typed });
      else if (typed) editDraft({ key: typed.trim() });
      router.back();
      return;
    }
    setBusy(true);
    try {
      if (custom) {
        const endpoint = serverCheck.result?.endpoint ?? normalizeServer(server);
        await saveCustomServer(endpoint, typed || saved || '');
        // A task page sent here: that task now runs on the server (its model is picked next).
        if (task && task !== 'meeting') {
          const current = await customSelection(endpoint, serverCheck.result?.models?.[0] ?? '');
          if (current.modelId) await setTask(task, current);
        }
      } else if (typed) {
        await saveKey(source as KeyProviderId, typed);
        if (task) await runTaskOnKey(source as KeyProviderId, task);
      } else if (saved && task) await runTaskOnKey(source as KeyProviderId, task);
      if (typed || custom) showToast(t('savedFor', { provider: name }), 'success');
      router.back();
    } catch (error) {
      showToast((error as Error).message || t('keySaveFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = () =>
    Alert.alert(t('removeKeyTitle', { provider: name }), t('removeKeyBody', { provider: name }), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('remove'),
        style: 'destructive',
        onPress: () =>
          void removeKey(source).then(() => {
            if (fromProcessing) useKeyDraft.setState({ key: '', serverKey: '' });
            showToast(t('keyRemoved', { provider: name }), 'neutral');
            router.back();
          }),
      },
    ]);

  const failed = check.state === 'failed';
  return (
    <SettingsPage title={custom ? t('customServer') : t('apiKey')}>
      <View style={{ gap: 8 }}>
        {custom && (
          <>
            <FieldCard
              label={t('server')}
              value={server}
              onChangeText={setServer}
              placeholder={t('serverPlaceholder')}
              keyboardType="url"
              autoFocus={!server}
              failed={failed}
              mark={<CheckMark t={t} state={check.state} />}
            />
            <Text style={[settings.subtitle, { paddingHorizontal: 4 }]}>{t('serverHint')}</Text>
          </>
        )}
        <FieldCard
          label={custom ? t('apiKey') : t('apiKeyFor', { provider: name })}
          value={showing}
          onChangeText={(value) => {
            setLocked(false);
            setTyped(value);
          }}
          locked={locked || savedShown}
          placeholder={custom && saved ? maskKey(saved) : custom ? t('optional') : t('pasteKey')}
          secure={!locked}
          autoFocus={(!custom && !saved) || changing}
          failed={!custom && failed}
          mark={
            custom ? undefined : savedShown ? (
              <KeyCheckMark state="connected" animate={false} />
            ) : (
              <CheckMark t={t} state={typed ? check.state : 'idle'} />
            )
          }
        />
        {check.result && check.state !== 'connected' && (typed || custom) && (
          <View>
            <Text
              style={[
                settings.subtitle,
                {
                  paddingHorizontal: 4,
                  color: failed ? KEY_CHECK_COLORS.failed : home.secondary,
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
          </View>
        )}
        {!custom && (
          <Text style={[settings.subtitle, { paddingHorizontal: 4 }]}>
            {t('keyHint', { provider: name })}
          </Text>
        )}
        {(locked || savedShown) && (
          <View style={{ alignSelf: 'flex-start' }}>
            <TextAction
              label={t('change')}
              onPress={() => {
                setChanging(true);
                setLocked(false);
                setTyped('');
              }}
            />
          </View>
        )}
      </View>

      {(provider?.keyUrl || saved || (custom && storedServer)) && (
        <Group inset={16}>
          {provider?.keyUrl && (
            <ListRow
              title={t('getKeyFrom', { provider: name })}
              onPress={() => void Linking.openURL(provider.keyUrl)}
            />
          )}
          {(saved || (custom && storedServer)) && (
            <ListRow title={t('removeKey')} destructive trailing={null} onPress={remove} />
          )}
        </Group>
      )}

      <View style={{ paddingBottom: 4 }}>
        <PillAction
          primary
          label={t('done')}
          disabled={!usable || busy}
          onPress={() => void done()}
        />
      </View>
    </SettingsPage>
  );
}
