import { runMigrations } from '@/db/migrate';
import { initSentry } from '@/lib/sentry';

let ran = false;

/**
 * What the app's startup module does before anything saves data, for the bubble's headless task:
 * crash reporting and the database schema. Attribution (AppsFlyer) waits for the app to open.
 * Migrations are idempotent, so the app running them again later in the same runtime is harmless.
 */
export function runHeadlessStartup(): void {
  if (ran) return;
  ran = true;
  initSentry();
  runMigrations();
}
