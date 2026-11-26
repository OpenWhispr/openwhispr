import { createAndroidLibraryLoad } from '@/android/libraryStores';
import { createDictionaryStore } from '@/android/store/createDictionaryStore';

export type { DictionaryEntry, DictionarySource } from '@/android/store/createDictionaryStore';
export const useDictionaryStore = createDictionaryStore(createAndroidLibraryLoad);
