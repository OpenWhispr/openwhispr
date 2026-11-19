import { useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { cloudAccessFor } from '@/lib/aiWorkflows';
import { home, type } from '../home/kit';
import { ANDROID_MODELS, useModelDownloads } from '../models';
import { settings, SettingsPage, showToast } from '../settings/kit';
import { KEY_CHECK_COLORS } from '../settings/KeyCheckMark';
import { formatSize, modelName } from '../settings/modelCatalog';
import { SHEET_TASKS, type SheetTask } from '../settings/ownKey';
import { AddKeySheet } from './AddKeySheet';
import { DeviceSheet } from './DeviceSheet';
import { KeyDetailSheet } from './KeyDetailSheet';
import {
  cancelPhoneDownloads,
  everythingOnCloud,
  everythingOnDevice,
  missingForEverything,
  placementOf,
  sourceName,
  usePhoneQueue,
  useSavedSources,
  type Place,
  type Source,
} from './places';
import { useFableT, type FableT } from './strings';
import { TaskSheet } from './TaskSheet';
import { OutlineButton, Tile, edgeCard, sectionLabel } from './look';
import { AddRow, ChipRow, Divider, PlaceHeader, TaskChip, confirmWithUndo, taskChip } from './ui';
import type { AndroidModelId } from '../models';

/** The On device card's one progress line while models download for waiting tasks (D2). */
function DownloadLine({ t }: { t: FableT }) {
  const { jobs, doneBytes, totalBytes } = usePhoneQueue();
  const progress = useModelDownloads((state) => state.progress);
  const current = jobs[0];
  if (!current || !totalBytes) return null;
  const fraction = progress[current.id] ?? 0;
  const done = doneBytes + fraction * ANDROID_MODELS[current.id].bytes;
  const share = Math.min(1, done / totalBytes);
  return (
    <View style={{ gap: 6 }} accessibilityLiveRegion="polite">
      <View style={{ height: 4, borderRadius: 2, backgroundColor: 'rgba(0,0,0,0.07)' }}>
        <View
          style={{
            width: `${Math.round(share * 100)}%`,
            height: 4,
            borderRadius: 2,
            experimental_backgroundImage: 'linear-gradient(90deg, #5588f0 0%, #3466e2 100%)',
          }}
        />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Text style={[settings.subtitle, settings.tabular, { flex: 1 }]}>
          {t('downloadingLine', {
            model: modelName(current.id),
            done: formatSize(done).replace(/ (MB|GB)$/, ''),
            total: formatSize(totalBytes),
          })}
        </Text>
        <Pressable
          cssInterop={false}
          accessibilityRole="button"
          accessibilityLabel={t('cancelDownloads')}
          hitSlop={12}
          onPress={() => {
            cancelPhoneDownloads();
            showToast(t('downloadCancelled'), 'neutral');
          }}
          style={({ pressed }) => ({
            minHeight: 32,
            justifyContent: 'center',
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={[type.subhead, { color: home.accent, fontWeight: '500' }]}>
            {t('cancel')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/** A card per place; its tasks sit inside it. */
function PlaceCard({ children }: { children: React.ReactNode }) {
  return (
    <View style={[edgeCard, { paddingHorizontal: 16, paddingVertical: 16, gap: 14 }]}>
      {children}
    </View>
  );
}

/**
 * Settings → Processing, Fable's take (P1–P3). Three places, OpenWhispr Cloud, On device and
 * Your own API key, each holding the tasks it runs as chips. A place that runs nothing offers
 * "Use for everything"; a chip opens its task's sheet; a key's line opens the key's sheet.
 */
export default function ProcessingScreen() {
  const t = useFableT();
  const config = useConfigStore((s) => s.config);
  const activeMode = useProcessingModeStore((s) => s.activeMode);
  const user = useAuthStore((s) => s.user);
  const cloudAccess = cloudAccessFor(user);
  const signedIn = !!user && !user.isAnonymous;
  const sources = useSavedSources();
  const waiting = usePhoneQueue((s) => s.jobs);
  const [task, setTask] = useState<SheetTask | null>(null);
  const [addKey, setAddKey] = useState(false);
  const [keyOpen, setKeyOpen] = useState<Source | null>(null);
  const [deviceNeeds, setDeviceNeeds] = useState<AndroidModelId[] | null>(null);
  const [busy, setBusy] = useState(false);

  const placements = SHEET_TASKS.map((item) => ({
    task: item,
    ...placementOf(config, item, activeMode, cloudAccess),
  }));
  const on = (place: Place, source?: Source) =>
    placements.filter((item) => item.place === place && (!source || item.source === source));
  const queued = new Set(waiting.flatMap((job) => job.tasks));

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      Alert.alert(t('errorTitle'), (error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cloudEverything = () =>
    void run(async () => {
      const undo = await everythingOnCloud();
      confirmWithUndo(t, t('everythingCloud'), undo);
    });

  const deviceEverything = () =>
    void run(async () => {
      const missing = await missingForEverything();
      if (missing.length) {
        setDeviceNeeds(missing);
        return;
      }
      const undo = await everythingOnDevice();
      confirmWithUndo(t, t('everythingDevice'), undo);
    });

  const chips = (items: typeof placements) => (
    <ChipRow>
      {items.map((item) => (
        <TaskChip
          key={item.task}
          {...taskChip(t, item.task, item.place)}
          onPress={() => setTask(item.task)}
        />
      ))}
    </ChipRow>
  );

  const cloud = on('cloud');
  const device = on('device');
  const keyed = on('key');
  const count = (items: unknown[]) =>
    items.length ? t('taskCount', { count: items.length }) : undefined;

  return (
    <SettingsPage title={t('processing')}>
      <View style={{ gap: 12 }}>
        <Text accessibilityRole="header" style={sectionLabel}>
          {t('whereProcessed')}
        </Text>

        <PlaceCard>
          <PlaceHeader
            place="cloud"
            title={t('cloud')}
            body={t(signedIn ? 'cloudSignedIn' : 'cloudSignedOut')}
            count={count(cloud)}
          />
          {cloud.length ? chips(cloud) : <Text style={settings.subtitle}>{t('noTasksHere')}</Text>}
          {!signedIn ? (
            <OutlineButton label={t('signIn')} onPress={() => router.push('/auth?reason=cloud')} />
          ) : (
            !cloud.length && (
              <OutlineButton
                label={t('useForEverything')}
                onPress={cloudEverything}
                disabled={busy}
              />
            )
          )}
        </PlaceCard>

        <View style={[edgeCard, { paddingTop: 16 }]}>
          <View style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 14 }}>
            <PlaceHeader
              place="device"
              title={t('thisPhone')}
              body={t('deviceBody')}
              count={count(device)}
            />
            {device.length ? (
              chips(device)
            ) : (
              <Text style={settings.subtitle}>
                {t(
                  placements.some((item) => item.place === 'device') ? 'noTasksHere' : 'noTasksYet',
                )}
              </Text>
            )}
            <DownloadLine t={t} />
            {!device.length && !queued.size && (
              <OutlineButton
                label={t('useForEverything')}
                onPress={deviceEverything}
                disabled={busy}
              />
            )}
          </View>
          <Divider />
          <Pressable
            cssInterop={false}
            accessibilityRole="button"
            onPress={() => router.push('/android-fable-check')}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingVertical: 14,
              gap: 12,
              backgroundColor: pressed ? home.canvas : undefined,
            })}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={settings.title}>{t('checkPhone')}</Text>
              <Text style={settings.subtitle}>{t('checkPhoneBody')}</Text>
            </View>
            <SystemIcon
              name="chevron.right"
              mdName="ChevronRight"
              size={20}
              color={home.tertiary}
            />
          </Pressable>
        </View>

        <View style={[edgeCard, { paddingTop: 16 }]}>
          <View style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 14 }}>
            <PlaceHeader
              place="key"
              title={t('ownKey')}
              body={t('keyPlaceBody')}
              count={count(keyed)}
            />
            {sources && !sources.length && (
              <>
                <Text style={settings.subtitle}>{t('noKeysYet')}</Text>
                <OutlineButton icon="Plus" label={t('addAKey')} onPress={() => setAddKey(true)} />
              </>
            )}
          </View>
          {sources && sources.length > 0 && (
            <>
              {sources.map(({ source, tail }) => {
                const items = on('key', source);
                const ending = tail
                  ? t(items.length ? 'keyEnding' : 'keyEndingIdle', { tail })
                  : t(items.length ? 'noKeyNeeded' : 'noKeyNeededIdle');
                return (
                  // Keyed by its task count, so a line that loses its chips lays out afresh.
                  <View key={`${source}-${items.length}`}>
                    <Divider />
                    <Pressable
                      cssInterop={false}
                      accessibilityRole="button"
                      accessibilityLabel={`${sourceName(source)}, ${ending}`}
                      onPress={() => setKeyOpen(source)}
                      style={({ pressed }) => ({
                        paddingHorizontal: 16,
                        paddingVertical: 14,
                        gap: 12,
                        backgroundColor: pressed ? home.canvas : undefined,
                      })}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                        <Tile kind={source === 'custom' ? 'idle' : 'logo'} source={source} />
                        <View style={{ flex: 1, gap: 2 }}>
                          <Text style={settings.title}>{sourceName(source)}</Text>
                          <Text style={settings.subtitle} numberOfLines={1}>
                            {ending}
                          </Text>
                        </View>
                        {/* A key that runs nothing has no tick, so its line stays one line (9.1). */}
                        {items.length > 0 && (
                          <SystemIcon
                            name="checkmark"
                            mdName="Check"
                            size={20}
                            color={KEY_CHECK_COLORS.connected}
                          />
                        )}
                        <SystemIcon
                          name="chevron.right"
                          mdName="ChevronRight"
                          size={20}
                          color={home.tertiary}
                        />
                      </View>
                      {items.length > 0 && <View style={{ paddingLeft: 48 }}>{chips(items)}</View>}
                    </Pressable>
                  </View>
                );
              })}
              <Divider />
              <AddRow label={t('addAKey')} onPress={() => setAddKey(true)} />
            </>
          )}
        </View>

        <Text style={[settings.subtitle, { textAlign: 'center', color: home.tertiary }]}>
          {t('tapTaskHint')}
        </Text>
      </View>

      <TaskSheet
        task={task}
        onClose={() => setTask(null)}
        onAddKey={() => {
          setTask(null);
          setAddKey(true);
        }}
      />
      <AddKeySheet visible={addKey} onClose={() => setAddKey(false)} />
      <KeyDetailSheet
        source={keyOpen}
        tail={sources?.find((item) => item.source === keyOpen)?.tail ?? ''}
        signedIn={signedIn}
        onClose={() => setKeyOpen(null)}
      />
      <DeviceSheet
        needs={deviceNeeds}
        onClose={() => setDeviceNeeds(null)}
        onDownload={() =>
          void run(async () => {
            setDeviceNeeds(null);
            const undo = await everythingOnDevice();
            confirmWithUndo(t, t('everythingDeviceSoon'), undo);
          })
        }
        onCheckFirst={() => {
          setDeviceNeeds(null);
          router.push('/android-fable-check');
        }}
      />
    </SettingsPage>
  );
}
