// The default entry owns startup side effects. Explicitly load that module once:
// Router also validates fallback routes in development, so repeating startup here
// would run local database initialization twice.
import './_layout.tsx';
import AndroidRoot from '@/android/Root';
import { Sentry } from '@/lib/sentry';

export default Sentry.wrap(AndroidRoot);
