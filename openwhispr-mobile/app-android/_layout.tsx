// Android's root route. Startup side effects run once, from src/android/startup.ts, before the
// root renders.
import '@/android/startup';
import AndroidRoot from '@/android/Root';
import { Sentry } from '@/android/lib/sentry';

export default Sentry.wrap(AndroidRoot);
