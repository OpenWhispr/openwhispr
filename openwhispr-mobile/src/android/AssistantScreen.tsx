import { useEffect, useRef, useState } from 'react';
import { TextInput } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/Text';
import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { getInferenceSelection } from '@/lib/inferenceRouting';
import { Page, Button, Card, styles } from './ui';
export default function AssistantScreen() {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const generate = async () => {
    if (busy) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    try {
      const selection = getInferenceSelection('agent');
      const result = await ReasoningService.processText({
        text: prompt,
        systemPrompt:
          'You are OpenWhispr, a concise helpful writing assistant. Answer the user directly.',
        inferenceScope: 'agent',
        inferenceRoute: selection?.mode === 'local' ? { mode: 'local', scope: 'agent' } : undefined,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setAnswer(result.text);
    } catch (error) {
      if (!controller.signal.aborted) setAnswer((error as Error).message);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <Page title={t('assistant')} back>
      <Text style={styles.body}>{t('assistantHint')}</Text>
      <TextInput
        multiline
        value={prompt}
        onChangeText={setPrompt}
        style={[styles.input, { minHeight: 160 }]}
        accessibilityLabel={t('assistantHint')}
      />
      <Button
        disabled={!prompt.trim()}
        busy={busy}
        label={t('send')}
        onPress={() => {
          void generate();
        }}
      />
      {busy && (
        <Button
          secondary
          label={t('cancel')}
          onPress={() => {
            abort.current?.abort();
            setBusy(false);
          }}
        />
      )}
      {answer && (
        <Card>
          <Text style={styles.body}>{answer}</Text>
        </Card>
      )}
    </Page>
  );
}
