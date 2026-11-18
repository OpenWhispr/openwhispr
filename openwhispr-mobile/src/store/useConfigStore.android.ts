import { createConfigStore } from './createConfigStore';
import { createAndroidConfigLifecycle } from '../android/configStoreLifecycle';

export const useConfigStore = createConfigStore(createAndroidConfigLifecycle);
