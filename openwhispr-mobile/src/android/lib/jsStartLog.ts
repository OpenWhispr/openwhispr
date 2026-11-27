import { dlog } from './debugLog';

const startedSurfaces = new Set<string>();

/**
 * The debug log's `app js.start`: once per surface (the app's root, the bubble's headless task) in
 * this JS runtime. `cold` is true for the first one, the one that started the runtime.
 */
export function logJsStart(surface: 'app' | 'headless'): void {
  if (startedSurfaces.has(surface)) return;
  const cold = startedSurfaces.size === 0;
  startedSurfaces.add(surface);
  dlog.info('app', 'js.start', { surface, cold, headless: surface === 'headless' });
}
