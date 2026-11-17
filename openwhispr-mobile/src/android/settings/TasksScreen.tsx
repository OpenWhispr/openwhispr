import { router } from 'expo-router';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { useCustomPromptsStore } from '@/store/useCustomPromptsStore';
import { resolveCustomPrompt } from '@/config/prompts/registry';
import { cloudAccessFor, workflowSummary } from '@/lib/aiWorkflows';
import { MODE_LABELS } from '@/lib/inferenceModes';
import type { MobileInferenceScope } from '@/lib/mobileProviders';
import { Group, ListRow, SettingsPage } from './kit';
import { useSettingsT, type SettingsKey } from './strings';

const TASKS: {
  scope: MobileInferenceScope;
  title: SettingsKey;
  icon: 'Mic' | 'FileAudio' | 'Sparkles' | 'FileText';
}[] = [
  { scope: 'dictation', title: 'dictation', icon: 'Mic' },
  { scope: 'upload', title: 'audioUploads', icon: 'FileAudio' },
  { scope: 'cleanup', title: 'textCleanup', icon: 'Sparkles' },
  { scope: 'notes', title: 'noteFormatting', icon: 'FileText' },
];

/**
 * Settings → Processing → Customize each task. Each task opens its own engine choice (today's
 * workflow screen, which also holds provider, model and key).
 */
export default function TasksScreen() {
  const t = useSettingsT();
  const config = useConfigStore((s) => s.config);
  const activeMode = useProcessingModeStore((s) => s.activeMode);
  const cloudAccess = cloudAccessFor(useAuthStore((s) => s.user));
  // The row value has room for a word or two: "Cloud", "This phone", a provider or model name.
  const shortSummary = (summary: string) =>
    summary === MODE_LABELS.openwhispr
      ? t('cloudShort')
      : summary === MODE_LABELS.local
        ? t('thisPhoneShort')
        : summary;
  const customPrompt = useCustomPromptsStore(
    (state) => resolveCustomPrompt(state.customPrompts.cleanup) !== undefined,
  );
  return (
    <SettingsPage title={t('customize')}>
      <Group title={t('eachTask')}>
        {TASKS.map(({ scope, title, icon }) => (
          <ListRow
            key={scope}
            icon={icon}
            title={t(title)}
            value={shortSummary(workflowSummary(config, scope, activeMode, { cloudAccess }))}
            onPress={() => router.push({ pathname: '/(account)/ai-workflow', params: { scope } })}
          />
        ))}
      </Group>
      <Group title={t('cleanup')}>
        <ListRow
          icon="Type"
          title={t('cleanupPrompt')}
          subtitle={t('cleanupPromptBody')}
          value={t(customPrompt ? 'custom' : 'default')}
          onPress={() => router.push('/(account)/cleanup-prompt')}
        />
      </Group>
    </SettingsPage>
  );
}
