import type {
  PermissionGuideAction,
  PermissionGuideId,
  PermissionGuideProgress,
  PermissionGuideState,
} from "../../types/permissionGuide";

export interface GuideAccess {
  granted: boolean;
  needsRelaunch?: boolean;
}

export interface GuidePermission extends GuideAccess {
  id: PermissionGuideId;
  request: () => Promise<unknown>;
  check: () => Promise<GuideAccess>;
  verify?: () => Promise<GuideAccess>;
  openSettings: () => Promise<unknown>;
  onGranted?: () => void;
}

interface ControllerOptions {
  sessionId: string;
  rows: () => GuidePermission[];
  save: (progress: PermissionGuideProgress | null) => void;
  publish: (state: PermissionGuideState) => Promise<boolean>;
  // The helper could not be opened for a request that is still live; a false
  // publish for a superseded request is expected and not reported.
  unavailable: () => void;
  close: () => void;
  restart: () => Promise<unknown>;
}

interface MicrophoneAccess {
  requestAccess: () => Promise<unknown>;
  checkAccess: () => Promise<{ granted: boolean; status: string }>;
  openSettings: () => Promise<unknown>;
}

// The native prompt is the request. Settings only helps after a denial: until
// the user has answered a prompt the Privacy pane does not list the app, and
// the in-app alert that getUserMedia raises would stack under the overlay.
export async function requestMicrophoneForGuide(
  access: MicrophoneAccess
): Promise<{ granted: boolean; status: string }> {
  await access.requestAccess();
  const result = await access.checkAccess();
  if (result.status === "denied") await access.openSettings();
  return result;
}

export function createPermissionGuideController(options: ControllerOptions): {
  start: (requested?: PermissionGuideId, saved?: PermissionGuideProgress) => Promise<void>;
  act: (action: PermissionGuideAction) => Promise<void>;
  refresh: () => Promise<void>;
  reconcile: () => Promise<void>;
  dispose: () => void;
} {
  let current: PermissionGuideId | null = null;
  let busy = false;
  let checking = false;
  let error = false;
  let revision = 0;
  let access: GuideAccess = { granted: false };

  const row = (): GuidePermission | undefined => options.rows().find((item) => item.id === current);
  const close = (): void => {
    revision++;
    current = null;
    busy = false;
    options.save(null);
    options.close();
  };
  const valid = (expected: number): boolean => revision === expected && !!row();

  const publish = async (): Promise<void> => {
    if (!current || !row()) return;
    if (access.granted && !access.needsRelaunch) {
      close();
      return;
    }
    const expected = revision;
    const opened = await options.publish({
      sessionId: options.sessionId,
      permission: current,
      granted: access.granted,
      needsRelaunch: access.needsRelaunch ?? false,
      busy,
      error,
    });
    if (!opened && valid(expected)) {
      close();
      options.unavailable();
    }
  };

  const accept = (result: GuideAccess, expected: number): void => {
    if (!valid(expected)) return;
    const consented = access.granted;
    access = result;
    // Apply feature consent once, on the grant, and only while this explicit
    // request is still active and eligible: a grant that needs a relaunch keeps
    // the helper open, so later checks report granted again.
    if (result.granted && !consented) row()?.onGranted?.();
  };

  const reconcile = async (): Promise<void> => {
    if (current && !row()) close();
  };

  const refresh = async (): Promise<void> => {
    await reconcile();
    const permission = row();
    if (!permission || busy || checking || current === "system-audio") return;
    const expected = revision;
    checking = true;
    try {
      accept(await permission.check(), expected);
      if (!valid(expected)) return;
      await publish();
    } catch {
      if (valid(expected)) {
        error = true;
        await publish();
      }
    } finally {
      checking = false;
    }
  };

  const start = async (
    requested?: PermissionGuideId,
    saved?: PermissionGuideProgress
  ): Promise<void> => {
    if (busy) return;
    const permission = options.rows().find((item) => item.id === (saved?.current ?? requested));
    if (!permission) {
      if (saved) close();
      return;
    }
    if (current) options.close();
    current = permission.id;
    access = { granted: false };
    busy = true;
    error = false;
    const expected = ++revision;
    // Save before the native request; macOS can restart the app while applying access.
    options.save({ current });
    try {
      // The onboarding Enable button is the consent action. Never put a helper in front
      // of a native prompt or require a second click before opening System Settings.
      if (!saved) await permission.request();
      if (!valid(expected)) return;
      accept(await row()!.check(), expected);
      // A resume only has to recognize a grant that landed before a relaunch;
      // without one there is no System Settings window to anchor a helper to.
      if (saved && !access.granted && valid(expected)) close();
    } catch {
      if (valid(expected)) error = true;
    } finally {
      if (valid(expected)) {
        busy = false;
        await publish();
      }
    }
  };

  const act = async (message: PermissionGuideAction): Promise<void> => {
    if (!current || message.sessionId !== options.sessionId || message.permission !== current)
      return;
    if (message.action === "close") {
      close();
      return;
    }
    const permission = row();
    if (!permission || busy) return;
    if (message.action === "restart" && !access.needsRelaunch) return;
    if (message.action === "check" && current !== "system-audio" && !error) return;
    busy = true;
    error = false;
    const expected = ++revision;
    try {
      await publish();
      if (!valid(expected)) return;
      if (message.action === "restart") await options.restart();
      else if (message.action === "settings") await permission.openSettings();
      else accept(await (permission.verify ?? permission.check)(), expected);
    } catch {
      if (valid(expected)) error = true;
    } finally {
      if (valid(expected)) {
        busy = false;
        await publish();
      }
    }
  };

  return {
    start,
    act,
    refresh,
    reconcile,
    dispose: (): void => {
      revision++;
      current = null;
      busy = false;
    },
  };
}
