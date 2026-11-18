import { createAuthStore } from './createAuthStore';
import { androidAuthLifecycle } from '@/android/authLifecycle';

export const useAuthStore = createAuthStore(androidAuthLifecycle);
