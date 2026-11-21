// ESM, pure (no React, no Electron): the view decisions for the Subscriptions
// settings section. The component and hook are thin adapters over these
// functions so the decisions run under `node --test` without a DOM.
import {
  ERROR_CODES,
  getProvider,
  installCommand,
  installSpec,
  isAllowedSignInUrl,
  isSeatEnabled,
  signOutSpec,
} from "../llmCliProviders.js";

export const SEATS = Object.freeze(["claude", "codex", "grok", "agy"]);

const STATUSES = Object.freeze([
  "missing",
  "installing",
  "installed",
  "outdated",
  "signing-in",
  "signed-in",
  "signed-out",
  "error",
]);

const KNOWN_ERROR_CODES = new Set(ERROR_CODES);

/** i18n key for a classified error code; an unknown code falls to the generic key. */
export function errorMessageKey(code) {
  if (typeof code !== "string" || code.length === 0) return null;
  return `llmSubscriptions.errors.${KNOWN_ERROR_CODES.has(code) ? code : "generic"}`;
}

/**
 * What a seat row shows and offers.
 * @param {string} seat claude | codex | grok | agy
 * @param {object} state seat state from main (`status`, `version`, `authKnown`, `errorCode`, `lastError`)
 * @param {{claudeEnabled?: boolean}} prefs main-held prefs
 * @param {string} platform process platform, used only to read the install spec kind
 */
export function seatViewModel(seat, state, prefs = {}, platform = "win32") {
  if (!getProvider(seat)) throw new Error(`unknown seat: ${seat}`);
  const status = state && STATUSES.includes(state.status) ? state.status : "missing";
  const isClaude = seat === "claude";
  const enabled = isSeatEnabled(seat, prefs);
  const code =
    status === "error" ? state?.errorCode || "generic" : state?.errorCode || state?.lastError;

  const base = {
    seat,
    status,
    statusKey: `llmSubscriptions.status.${status}`,
    version: state?.version || null,
    disabled: !enabled,
    showToggle: isClaude,
    claudeEnabled: isClaude ? enabled : undefined,
    noticeKey: isClaude && enabled ? "llmSubscriptions.claude.notice" : null,
    errorKey: errorMessageKey(code),
    hintKey: status === "outdated" ? "llmSubscriptions.outdatedHint" : null,
    actions: [],
  };
  if (!enabled) return base;

  switch (status) {
    case "missing":
      base.actions = [
        installSpec(seat, platform).kind === "script" ? "install" : "openGuide",
        "redetect",
      ];
      break;
    case "outdated":
      base.actions = ["redetect"];
      break;
    case "installed":
      base.actions = ["signin", "test", "redetect"];
      break;
    case "signed-out":
      base.actions = ["signin", "redetect"];
      break;
    case "signed-in":
      base.actions = ["test", "signout", "redetect"];
      break;
    case "installing":
      base.actions = ["cancelInstall"];
      break;
    case "signing-in":
      base.actions = ["cancelSignin"];
      break;
    default:
      base.actions = ["redetect"];
  }
  return base;
}

/**
 * The consent dialog content. `confirmUrl` is the table url verbatim: it is
 * the only value the confirm action hands to main.
 */
export function installDialogModel(seat, platform = "win32") {
  const spec = installSpec(seat, platform);
  if (spec.kind !== "script") return { kind: "guided", url: spec.url, confirmUrl: null };
  const argv = installCommand(seat, platform);
  return {
    kind: "script",
    url: spec.url,
    confirmUrl: spec.url,
    command: argv[argv.length - 1],
    shell: spec.shell,
    publisher: spec.publisher,
  };
}

/** Sign-out confirmation: what it affects and which text states it. */
export function signOutConfirmModel(seat) {
  const spec = signOutSpec(seat);
  if (spec.kind === "guide") {
    return { required: false, guide: true, messageKey: "llmSubscriptions.signOut.agyGuide" };
  }
  return {
    required: true,
    guide: false,
    affectsTerminalCli: spec.affectsTerminalCli === true,
    messageKey: spec.affectsTerminalCli
      ? "llmSubscriptions.signOut.terminalCli"
      : "llmSubscriptions.signOut.claudeToken",
  };
}

/**
 * Sign-in prompt for a main `signin-prompt` event. Text from the CLI is shown
 * as plain text; the open-in-browser button needs an allowlisted host.
 */
export function signInPromptModel(seat, event) {
  if (!event || event.seat !== seat) return null;
  if (event.kind === "terminal-guide" || seat === "agy") {
    return {
      kind: "guide",
      guideKey: "llmSubscriptions.signIn.agyGuide",
      url: null,
      code: null,
      canOpenUrl: false,
      showCodeInput: false,
    };
  }
  const url = typeof event.url === "string" ? event.url : null;
  const code = typeof event.code === "string" ? event.code : null;
  return {
    kind: seat === "claude" ? "claude-code" : "device-code",
    guideKey: null,
    url,
    code,
    canOpenUrl: url !== null && isAllowedSignInUrl(seat, url),
    showCodeInput: seat === "claude",
  };
}
