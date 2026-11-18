import { router } from 'expo-router';
import { useConfigStore } from '@/store/useConfigStore';
import { Group, ListRow, SettingsPage } from '../settings/kit';
import { SHEET_TASKS } from '../settings/ownKey';
import {
  KEY_SOURCES,
  TASK_KEY,
  taskList,
  taskValue,
  tasksUsing,
  useCustomServer,
  useKeyTails,
} from './logic';
import { useV1T } from './strings';

const TASK_ICON = {
  dictation: 'Mic',
  upload: 'FileUp',
  cleanup: 'Sparkles',
  notes: 'FileText',
  meeting: 'UsersRound',
} as const;

/**
 * 10.1 Customize each task, with 10.9's saved keys underneath. Each task runs its own engine;
 * a key is saved once and every task on that provider uses it. The cleanup prompt has moved to
 * Text cleanup, its one home.
 */
export default function TasksScreenV1() {
  const t = useV1T();
  const config = useConfigStore((s) => s.config);
  const tails = useKeyTails();
  const server = useCustomServer((s) => s.endpoint);

  return (
    <SettingsPage title={t('customizeTasks')}>
      <Group title={t('eachTask')}>
        {SHEET_TASKS.map((task) => (
          <ListRow
            key={task}
            icon={TASK_ICON[task]}
            title={t(TASK_KEY[task])}
            value={taskValue(t, config, task)}
            onPress={() => router.push({ pathname: '/android-v1-task', params: { task } })}
          />
        ))}
      </Group>

      <Group title={t('yourApiKeys')} inset={16}>
        {KEY_SOURCES.map(({ id, name }) => {
          const tail = tails[id];
          const saved = tail !== undefined;
          const used = tasksUsing(config, id);
          return (
            <ListRow
              key={id}
              title={id === 'custom' ? t('customServer') : name}
              subtitle={
                saved
                  ? used.length
                    ? t('usedBy', { tasks: taskList(t, used) })
                    : id === 'custom' && server
                      ? new URL(server).host
                      : t('notUsedYet')
                  : id === 'custom'
                    ? t('customServerBody')
                    : undefined
              }
              value={saved ? (tail ? `••••${tail}` : t('saved')) : t('add')}
              valueAccent={!saved}
              onPress={() => router.push({ pathname: '/android-v1-key', params: { provider: id } })}
            />
          );
        })}
      </Group>
    </SettingsPage>
  );
}
