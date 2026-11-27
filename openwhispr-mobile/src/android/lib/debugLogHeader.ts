/**
 * The header at the top of a shared debug log: what the app, the phone and the account are set to,
 * so a log can be read without asking. Ids and names only: no email, no account id, no keys.
 */
export interface ScopeLine {
  scope: string;
  mode?: string;
  provider?: string;
  model?: string;
}
export interface DebugLogSnapshot {
  generatedAt: Date;
  app: { version: string; build: string; packageName: string; environment: string; apiBaseUrl: string };
  device: { manufacturer: string; model: string; release: string; sdk: number };
  batteryOptimizationIgnored: boolean | null;
  permissions: { microphone: boolean; overlay: boolean; accessibility: boolean; notifications: boolean };
  account: { signedIn: boolean; plan: string | null; workspaceIds: string[] };
  defaultMode: string | null;
  scopes: ScopeLine[];
  models: { id: string; ready: boolean }[];
  services: { bubble: boolean; meeting: boolean };
  debugLogging: { on: boolean; since: number; onAtLaunch: boolean; processAgeMs: number };
  microphone: { owner: string | null; module: string | null; heldMs: number | null };
}

const pad = (label: string) => label.padEnd(15);
const yes = (value: boolean) => (value ? 'granted' : 'denied');
// The header is a fixed set of names; this keeps anything unexpected to one line and short.
const clean = (value: string | null | undefined) =>
  (value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 80) || '-';

function scopeText(line: ScopeLine): string {
  const target = [line.provider, line.model].filter(Boolean).map(clean).join('/');
  return `${line.scope}=${clean(line.mode)}${target ? ` ${target}` : ''}`;
}

export function buildDebugLogHeader(snapshot: DebugLogSnapshot): string {
  const s = snapshot;
  const iso = (ms: number) => (ms > 0 ? new Date(ms).toISOString() : '-');
  const processStart = new Date(s.generatedAt.getTime() - s.debugLogging.processAgeMs).toISOString();
  const lock = s.microphone.owner
    ? `held by ${clean(s.microphone.owner)}${s.microphone.module ? `, module ${clean(s.microphone.module)}` : ''}` +
      (s.microphone.heldMs != null ? `, ${Math.round(s.microphone.heldMs / 1000)} s` : '')
    : 'free';
  return [
    'OpenWhispr debug log',
    `${pad('generated')}${s.generatedAt.toISOString()}`,
    `${pad('app')}${clean(s.app.version)} (${clean(s.app.build)}) ${clean(s.app.packageName)} ${clean(s.app.environment)} api=${clean(s.app.apiBaseUrl)}`,
    `${pad('device')}${clean(s.device.manufacturer)} ${clean(s.device.model)}, Android ${clean(s.device.release)} (API ${s.device.sdk})`,
    `${pad('battery_opt')}ignoring=${s.batteryOptimizationIgnored ?? 'unknown'}`,
    `${pad('permissions')}mic=${yes(s.permissions.microphone)} overlay=${yes(s.permissions.overlay)} ` +
      `accessibility=${s.permissions.accessibility ? 'on' : 'off'} notifications=${yes(s.permissions.notifications)}`,
    `${pad('account')}signed_in=${s.account.signedIn} plan=${clean(s.account.plan)} ` +
      `workspace=${s.account.workspaceIds.length ? s.account.workspaceIds.map(clean).join(',') : 'none'}`,
    `${pad('mode/provider')}default=${clean(s.defaultMode)} · ${s.scopes.map(scopeText).join(' · ')}`,
    `${pad('models')}${s.models.length ? s.models.map((m) => `${clean(m.id)} (${m.ready ? 'ready' : 'missing'})`).join(', ') : 'none downloaded'}`,
    `${pad('services')}bubble=${s.services.bubble ? 'running' : 'off'} meeting=${s.services.meeting ? 'recording' : 'off'}`,
    `${pad('debug_logging')}${s.debugLogging.on ? `on since ${iso(s.debugLogging.since)}` : 'off'} ` +
      `(on at this launch: ${s.debugLogging.onAtLaunch ? 'yes' : 'no'}, process start ${processStart})`,
    `${pad('mic_lock')}${lock}`,
    '',
  ].join('\n');
}
