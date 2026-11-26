import { createAuthStore } from '@/android/store/createAuthStore';
import { androidAuthLifecycle } from '@/android/authLifecycle';

export const useAuthStore = createAuthStore(androidAuthLifecycle);
