import { useEffect } from 'react';
import { useDictionaryStore } from '@/store/useDictionaryStore';
import { useSnippetsStore } from '@/store/useSnippetsStore';
import { useNotesStore } from '@/store/useNotesStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useTranscriptStore } from '@/store/useTranscriptStore';

export function useAppInit() {
  const loadDictionary = useDictionaryStore((state) => state.load);
  const isDictionaryLoaded = useDictionaryStore((state) => state.isLoaded);
  const loadSnippets = useSnippetsStore((state) => state.load);
  const isSnippetsLoaded = useSnippetsStore((state) => state.isLoaded);
  const initNotes = useNotesStore((state) => state.initialize);
  const isNotesInitialized = useNotesStore((state) => state.isInitialized);
  const loadConfig = useConfigStore((state) => state.loadConfig);
  const loadTranscripts = useTranscriptStore((state) => state.loadTranscripts);

  useEffect(() => {
    if (!isDictionaryLoaded) loadDictionary();
    // Hydrate snippets at startup so expansion + hints work for keyboard dictation
    // even when the Dictionary screen was never opened.
    if (!isSnippetsLoaded) loadSnippets();
    if (!isNotesInitialized) initNotes();
    loadConfig();
    loadTranscripts();
  }, [
    loadDictionary,
    isDictionaryLoaded,
    loadSnippets,
    isSnippetsLoaded,
    initNotes,
    isNotesInitialized,
    loadConfig,
    loadTranscripts,
  ]);
}
