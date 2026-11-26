import { createAndroidLibraryLoad, findAndroidSnippetByTrigger } from '@/android/libraryStores';
import { createSnippetsStore } from '@/android/store/createSnippetsStore';

export const useSnippetsStore = createSnippetsStore({
  createLoad: createAndroidLibraryLoad,
  findByTrigger: findAndroidSnippetByTrigger,
  checkEveryRename: true,
});
