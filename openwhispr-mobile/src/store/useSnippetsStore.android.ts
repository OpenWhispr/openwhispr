import { createAndroidLibraryLoad, findAndroidSnippetByTrigger } from '@/android/libraryStores';
import { createSnippetsStore } from './createSnippetsStore';

export const useSnippetsStore = createSnippetsStore({
  createLoad: createAndroidLibraryLoad,
  findByTrigger: findAndroidSnippetByTrigger,
  checkEveryRename: true,
});
