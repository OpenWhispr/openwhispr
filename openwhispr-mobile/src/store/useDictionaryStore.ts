import { createDictionaryStore } from './createDictionaryStore';

export type { DictionaryEntry, DictionarySource } from './createDictionaryStore';
export const useDictionaryStore = createDictionaryStore();
