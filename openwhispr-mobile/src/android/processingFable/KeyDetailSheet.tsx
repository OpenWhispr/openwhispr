import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { cloudAccessFor } from '@/lib/aiWorkflows';
import { BottomSheet, TextAction, settings, showToast } from '../settings/kit';
import { useKeyCheck, type KeyProviderId } from '../settings/keyCheck';
import { maskKey } from '../settings/ownKey';
import { noOrphan } from '../settings/strings';
import {
  changeSourceKey,
  readSourceKey,
  removeSource,
  sourceName,
  tasksOn,
  useCustomServer,
  useServerCheck,
  type Source,
} from './places';
import { useFableT } from './strings';
import { Tile } from './look';
import { ChipRow, Field, Reason, SectionLabel, TaskChip, confirmWithUndo, taskChip } from './ui';

/**
 * A saved key's sheet (7D): the key with Change, the tasks it runs, and a red Remove key. The
 * provider can't change on a saved key, so it is the title. Removing moves the key's tasks to
 * Cloud (On device when signed out), with Undo at the bottom.
 */
export function KeyDetailSheet({
  source: requested,
  tail,
  signedIn,
  onClose,
}: {
  source: Source | null;
  tail: string;
  signedIn: boolean;
  onClose: () => void;
}) {
  const t = useFableT();
  const config = useConfigStore((s) => s.config);
  const activeMode = useProcessingModeStore((s) => s.activeMode);
  const cloudAccess = cloudAccessFor(useAuthStore((s) => s.user));
  const endpoint = useCustomServer((s) => s.endpoint);
  // The sheet keeps showing its key while it slides away.
  const [source, setSource] = useState<Source>(requested ?? 'openai');
  const [key, setKey] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const custom = source === 'custom';
  const check = useKeyCheck(
    (custom ? 'openai' : source) as KeyProviderId,
    editing && !custom ? draft : '',
  );
  const server = useServerCheck(editing && custom && draft ? (endpoint ?? '') : '', draft);

  useEffect(() => {
    if (!requested) return;
    setSource(requested);
    setEditing(false);
    setDraft('');
    void readSourceKey(requested).then(setKey);
  }, [requested]);

  const result = custom ? server.result : check.result;
  const state = custom ? server.state : check.state;
  // A new key that passes its check replaces the saved one at once.
  useEffect(() => {
    if (!editing || state !== 'connected' || !draft.trim()) return;
    const next = draft.trim();
    void changeSourceKey(source, next)
      .then(() => {
        setKey(next);
        setEditing(false);
        setDraft('');
        showToast(t('keyChanged', { provider: sourceName(source) }), 'success');
      })
      .catch(() => showToast(t('keySaveFailed'), 'error'));
    // t is a fresh function each render; the check's answer decides this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, editing]);

  const tasks = tasksOn(source, config, activeMode, cloudAccess);
  const name = sourceName(source);
  const failed = editing && state === 'failed';

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const undo = await removeSource(source, signedIn, cloudAccess);
      onClose();
      confirmWithUndo(t, t(custom ? 'serverRemoved' : 'keyRemoved', { provider: name }), undo);
    } catch {
      showToast(t('keySaveFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet
      visible={!!requested}
      onClose={onClose}
      title={custom ? t('customServer') : t('sourceKey', { provider: name })}
      leading={<Tile kind={custom ? 'idle' : 'logo'} source={source} />}
    >
      {custom && endpoint && (
        <Field label={t('serverAddress')} value={endpoint} locked mark="connected" />
      )}
      <View style={{ gap: 8 }}>
        <Field
          label={custom ? t('serverKey') : t('apiKey')}
          action={
            editing
              ? { label: t('cancel'), onPress: () => setEditing(false) }
              : { label: t('change'), onPress: () => setEditing(true) }
          }
          value={editing ? draft : key ? maskKey(key) : tail ? `••••${tail}` : t('noKeyNeeded')}
          onChangeText={setDraft}
          placeholder={custom ? t('pasteTheKey') : t('pasteProviderKey', { provider: name })}
          secure
          locked={!editing}
          mark={editing ? state : key || !custom ? 'connected' : undefined}
          failed={failed}
        />
        {editing && result && state !== 'connected' && (
          <Reason
            failed={failed}
            text={
              state === 'unverified'
                ? t('keyNoAnswer', { provider: name })
                : custom
                  ? t('serverRefusedKey')
                  : t('keyRefused', { provider: name })
            }
          />
        )}
      </View>
      <View style={{ gap: 8 }}>
        <SectionLabel>{t('runsLabel')}</SectionLabel>
        {tasks.length ? (
          <>
            <ChipRow>
              {tasks.map((task) => (
                <TaskChip key={task} {...taskChip(t, task, 'key')} />
              ))}
            </ChipRow>
            <Text style={settings.subtitle}>{t('moveHint')}</Text>
          </>
        ) : (
          <Text style={settings.subtitle}>{noOrphan(t('runsNothing'))}</Text>
        )}
      </View>
      <View style={{ paddingBottom: 4 }}>
        <TextAction
          destructive
          label={t(custom ? 'removeServer' : 'removeKey')}
          onPress={() => void remove()}
        />
      </View>
    </BottomSheet>
  );
}
