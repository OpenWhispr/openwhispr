import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { safeHaptics } from '@/android/shared/lib/utils';
import { useDictionaryStore, type DictionaryEntry } from '@/android/store/useDictionaryStore';
import { useSnippetsStore } from '@/android/store/useSnippetsStore';
import { Field } from './Field';
import type { Snippet } from '@/android/dictation/snippets';
import { createSnippetCloseHandler } from '@/lib/snippetClose';
import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { useHome } from '../home/kit';
import { useNotesLook } from '../notes/look';
import { useTheme } from '../ThemeProvider';
import { BottomSheet } from '../settings/kit';
import { GlassButton } from '../processingFable/look';
import { addWordsByHand, deleteSnippetWithUndo, deleteWordWithUndo } from './actions';
import { learnedInfo, renameLearned, useAccountLearned, type LearnedInfo } from './learned';
import { shortDate } from './time';
import { splitWords } from './search';
import { useDictionaryT, type DictionaryT } from './strings';

function ErrorLine({ text }: { text: string | null }) {
  const k = useTheme().tokens;
  const ty = useHome().type;
  if (!text) return null;
  return (
    <Text accessibilityLiveRegion="polite" style={[ty.footnote, { color: k.error }]}>
      {text}
    </Text>
  );
}

/** C2: a comma list turns into chips; the button counts them. */
export function AddWordsSheet({
  visible,
  onClose,
  initial = '',
}: {
  visible: boolean;
  onClose: () => void;
  initial?: string;
}) {
  const { type: ty, theme: th } = useHome();
  const k = th.tokens;
  const n = useNotesLook();
  const t = useDictionaryT();
  const [input, setInput] = useState('');
  const field = useRef<TextInput>(null);
  useEffect(() => {
    if (!visible) return;
    setInput(initial);
    const timer = setTimeout(() => field.current?.focus(), 280);
    return () => clearTimeout(timer);
  }, [visible, initial]);
  const words = useMemo(() => splitWords(input), [input]);
  const submit = () => {
    if (words.length === 0) return;
    safeHaptics('success');
    addWordsByHand(words);
    onClose();
  };
  const removeChip = (word: string) =>
    setInput(
      input
        .split(',')
        .filter((part) => part.trim().toLowerCase() !== word.toLowerCase())
        .join(','),
    );
  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('addWords')}>
      <Field
        inputRef={field}
        value={input}
        onChangeText={setInput}
        placeholder={t('addWordsPlaceholder')}
        accessibilityLabel={t('addWords')}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
        onSubmitEditing={submit}
      />
      {words.length > 0 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {words.map((word) => (
            <Pressable
              cssInterop={false}
              key={word.toLowerCase()}
              accessibilityRole="button"
              accessibilityLabel={t('removeChip', { word })}
              onPress={() => removeChip(word)}
              style={({ pressed }) => ({
                ...n.edge,
                minHeight: 34,
                paddingHorizontal: 14,
                borderRadius: 999,
                justifyContent: 'center',
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text style={{ fontSize: 14, lineHeight: 18, fontWeight: '500', color: k.ink }}>
                {word}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      <Text style={[ty.footnote, { fontSize: 14, lineHeight: 20 }]}>{t('addWordsHelp')}</Text>
      <GlassButton
        label={
          words.length > 1
            ? t('addMany', { count: words.length })
            : words.length === 1
              ? t('addOne', { count: 1 })
              : t('addWords')
        }
        onPress={submit}
        disabled={words.length === 0}
      />
    </BottomSheet>
  );
}

function originTitle(info: LearnedInfo, t: DictionaryT): string {
  if (info.origin.kind === 'note') return t('learnedFromNote');
  if (info.origin.kind === 'transcript') return t('learnedFromTranscript');
  return t('learnedAfterDictating');
}

function originLine(info: LearnedInfo, t: DictionaryT, language: string): string {
  const date = shortDate(info.learnedAt, language);
  if (info.origin.kind !== 'app')
    return t('originNote', { title: info.origin.title || t('untitledNote'), date });
  return info.from ? t('originFixed', { from: info.from, date }) : date;
}

/** Where a learned word came from; a note opens. Other phones' learned words say only that. */
function OriginCard({
  entry,
  info,
  onOpen,
}: {
  entry: DictionaryEntry;
  info: LearnedInfo | null;
  onOpen: () => void;
}) {
  const { type: ty, theme: th } = useHome();
  const k = th.tokens;
  const n = useNotesLook();
  const t = useDictionaryT();
  const language = useLanguage();
  if (entry.source !== 'learned') return null;
  const noteId = info && info.origin.kind !== 'app' ? info.origin.noteId : null;
  const title = info ? originTitle(info, t) : t('learnedFromFixesShort');
  const line = info
    ? originLine(info, t, language)
    : entry.addedAt
      ? shortDate(entry.addedAt, language)
      : '';
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole={noteId != null ? 'button' : 'text'}
      disabled={noteId == null}
      onPress={() => {
        if (noteId == null) return;
        onOpen();
        router.push(`/(tabs)/(notes)/${noteId}`);
      }}
      style={({ pressed }) => [
        n.edgeCard,
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          padding: 14,
          backgroundColor: pressed ? k.tile : k.surface,
        },
      ]}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          backgroundColor: k.selFill,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <SystemIcon name="sparkles" mdName="Sparkles" size={18} color={k.accent} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: 16, lineHeight: 22, fontWeight: '500', color: k.ink }}>
          {title}
        </Text>
        {line ? (
          <Text numberOfLines={1} style={ty.footnote}>
            {line}
          </Text>
        ) : null}
      </View>
      {noteId != null && (
        <SystemIcon name="chevron.right" mdName="ChevronRight" size={18} color={k.tertiary} />
      )}
    </Pressable>
  );
}

function useLanguage(): string {
  return useTranslation().i18n.language;
}

/**
 * Renames a word, keeping where it came from. A change of case only rewrites the spelling;
 * anything else replaces the old row with a new one of the same kind (learned stays learned).
 * Returns an error to show, or null.
 */
export function renameWord(entry: DictionaryEntry, next: string, t: DictionaryT): string | null {
  const word = next.trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (!word || word === entry.word) return null;
  const store = useDictionaryStore.getState();
  const sameWord = word.toLowerCase() === entry.word.toLowerCase();
  if (!sameWord && store.entries.some((other) => other.word.toLowerCase() === word.toLowerCase()))
    return t('alreadyHave', { word });
  if (!sameWord) store.removeWord(entry.word);
  if (entry.source === 'learned') store.addLearnedWords([word]);
  else store.addWords(word);
  renameLearned(entry.word, word);
  return null;
}

/** C3: tap a word to fix its spelling, see where a learned one came from, or delete it. */
export function EditWordSheet({
  entry,
  onClose,
}: {
  entry: DictionaryEntry | null;
  onClose: () => void;
}) {
  const t = useDictionaryT();
  const learned = useAccountLearned();
  // Keeps the last word while the sheet slides away.
  const [shown, setShown] = useState<DictionaryEntry | null>(entry);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!entry) return;
    setShown(entry);
    setValue(entry.word);
    setError(null);
  }, [entry]);
  const changed = shown != null && value.trim() !== '' && value.trim() !== shown.word;
  const save = () => {
    if (!shown || !changed) return;
    const problem = renameWord(shown, value, t);
    if (problem) {
      setError(problem);
      return;
    }
    safeHaptics('success');
    onClose();
  };
  return (
    <BottomSheet visible={entry != null} onClose={onClose} title={t('editWord')}>
      <Field
        value={value}
        onChangeText={(text) => {
          setValue(text);
          setError(null);
        }}
        accessibilityLabel={t('editWordField')}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
        onSubmitEditing={save}
      />
      <ErrorLine text={error} />
      {shown && (
        <OriginCard entry={shown} info={learnedInfo(learned, shown.word)} onOpen={onClose} />
      )}
      <GlassButton label={t('save')} onPress={save} disabled={!changed} />
      <DeleteLink
        label={t('deleteWord')}
        onPress={() => {
          if (!shown) return;
          onClose();
          deleteWordWithUndo(shown);
        }}
      />
    </BottomSheet>
  );
}

function DeleteLink({ label, onPress }: { label: string; onPress: () => void }) {
  const k = useTheme().tokens;
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <SystemIcon name="trash" mdName="Trash2" size={17} color={k.error} />
      <Text style={{ color: k.error, fontSize: 16, lineHeight: 22, fontWeight: '500' }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** C13: add or edit a snippet. `snippet` null with `visible` adds a new one. */
export function SnippetSheet({
  visible,
  snippet,
  onClose,
}: {
  visible: boolean;
  snippet: Snippet | null;
  onClose: () => void;
}) {
  const ty = useHome().type;
  const t = useDictionaryT();
  const [trigger, setTrigger] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Snippet | null>(null);
  const field = useRef<TextInput>(null);
  const textField = useRef<TextInput>(null);
  const { copy } = useAndroidCopy();
  // Back or a tap on the dim with unsaved changes asks before throwing them away.
  const requestClose = createSnippetCloseHandler({
    onClose,
    initial: editing,
    trigger,
    replacement: text,
    copy,
  });
  useEffect(() => {
    if (!visible) return;
    setEditing(snippet);
    setTrigger(snippet?.trigger ?? '');
    setText(snippet?.replacement ?? '');
    setError(null);
    if (snippet) return;
    const timer = setTimeout(() => field.current?.focus(), 280);
    return () => clearTimeout(timer);
  }, [visible, snippet]);
  const cleanTrigger = trigger.trim();
  const cleanText = text.trim();
  const changed = !editing || cleanTrigger !== editing.trigger || cleanText !== editing.replacement;
  const ready = cleanTrigger !== '' && cleanText !== '' && changed;
  const save = () => {
    if (!ready) return;
    const store = useSnippetsStore.getState();
    const clash = store.entries.some(
      (other) =>
        other.trigger.toLowerCase() === cleanTrigger.toLowerCase() &&
        other.trigger.toLowerCase() !== editing?.trigger.toLowerCase(),
    );
    if (clash) {
      setError(t('duplicateTrigger', { trigger: cleanTrigger }));
      return;
    }
    if (editing)
      store.updateSnippet(editing.trigger, { trigger: cleanTrigger, replacement: cleanText });
    else store.addSnippet(cleanTrigger, cleanText);
    safeHaptics('success');
    onClose();
  };
  return (
    <BottomSheet
      visible={visible}
      onClose={() => void requestClose()}
      title={editing ? t('editSnippet') : t('addSnippet')}
    >
      <Field
        inputRef={field}
        value={trigger}
        onChangeText={(value) => {
          setTrigger(value);
          setError(null);
        }}
        placeholder={t('triggerPlaceholder')}
        accessibilityLabel={t('trigger')}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => textField.current?.focus()}
      />
      <Field
        inputRef={textField}
        value={text}
        onChangeText={setText}
        placeholder={t('snippetTextPlaceholder')}
        accessibilityLabel={t('snippetText')}
        multiline
      />
      <ErrorLine text={error} />
      <Text style={[ty.footnote, { fontSize: 14, lineHeight: 20 }]}>{t('snippetHelp')}</Text>
      <GlassButton label={editing ? t('save') : t('addSnippet')} onPress={save} disabled={!ready} />
      {editing && (
        <DeleteLink
          label={t('deleteSnippet')}
          onPress={() => {
            onClose();
            deleteSnippetWithUndo(editing);
          }}
        />
      )}
    </BottomSheet>
  );
}
