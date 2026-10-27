# Linux D-Bus Start and Stop Controls

## Scope

Expose explicit `Start` and `Stop` methods on OpenWhispr's existing Linux D-Bus service while preserving every existing toggle and push-to-talk method. This feature changes only the OpenWhispr control surface. Wake-word detection is a separate feature after these controls are accepted and verified.

## Acceptance criteria

- GNOME and Hyprland export `Start` and `Stop` on `com.openwhispr.App` at `/com/openwhispr/App`.
- `Start` routes to OpenWhispr's existing start-dictation path and is side-effect free when an explicit start is already pending or dictation is not idle.
- `Stop` routes to OpenWhispr's existing stop-dictation path and is a no-op when dictation is not active.
- Existing `Toggle`, slot toggles, `PttDown`, and `PttUp` behavior remains unchanged.
- Automated tests cover each exported method and its callback routing.
- The focused tests, full test suite, formatting checks, lint, and type checks pass.

## Approach

The D-Bus shortcut managers remain transport adapters. They will translate `Start` and `Stop` into explicit actions on the existing dictation callback. `WindowManager.createHotkeyCallback()` remains the recording-control owner and will route those actions before applying hotkey activation-mode rules.

The explicit D-Bus start route will have its own main-process dispatch guard. It will reject a duplicate before capturing a new paste target or repositioning the panel. The renderer will acknowledge the matching request when its start attempt settles, while any lifecycle report also releases the dispatch guard. The existing `sendStartDictation()` path remains available to push-to-talk flows whose prepare phase legitimately precedes their start. Renderer lifecycle guards remain authoritative, including the existing queued stop when a stop arrives while microphone startup is still pending.

Data flow:

1. A local D-Bus client calls `com.openwhispr.App.Start` or `com.openwhispr.App.Stop`.
2. The active GNOME or Hyprland shortcut manager invokes the shared dictation callback with the explicit action.
3. `WindowManager` rejects duplicate explicit starts before any target or panel side effects, then sends the existing `start-dictation` or `stop-dictation` IPC event.
4. The renderer uses its existing guarded start and stop functions, which already reject duplicate or invalid transitions.

D-Bus method returns acknowledge local dispatch only. They do not claim that microphone startup, recording completion, transcription, or paste delivery has completed.

No new service, setting, dependency, background listener, or persistence is introduced.

## Risks

- The D-Bus interface is a public local contract, so existing methods must stay backward compatible.
- Explicit actions must bypass tap-versus-push interpretation or they can degrade back into toggle behavior.
- GNOME and Hyprland share the service name and should expose the same dictation methods.
- A command may arrive while OpenWhispr is processing or starting. Existing lifecycle guards remain authoritative.
- A stop received during microphone startup must preserve the current queued-stop behavior and stop the recording as soon as startup settles.

## Delegation

The parent implements and validates this bounded feature. An independent reviewer checks the settled diff, public contract, state transitions, tests, and maintainability before completion.

## Verification

- Targeted GNOME and Hyprland export and callback-routing tests
- Window-manager tests in tap and push modes covering explicit Start and Stop while preserving zero-argument toggle and down/up behavior
- Recording transition tests covering duplicate Start, idle Stop, duplicate Stop, and Stop during deferred microphone startup
- `npm test`
- `npm run quality-check`
- `npm run i18n:check`

Native GNOME D-Bus acceptance and installing a locally built package remain separate manual steps after automated verification.
