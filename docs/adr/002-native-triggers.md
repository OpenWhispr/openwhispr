# ADR 002: Configurable native triggers

TriggerManager extends the existing slot registration and rollback contract.
Keyboard accelerators and mouse button descriptors resolve to the same persisted
slot names, preserving upstream settings. Dictation uses the existing hold/push
or toggle/tap mode. Other actions retain toggle behavior.

Windows uses WH_MOUSE_LL; macOS uses a listen-only CGEvent tap. Middle button 3
and side buttons 4/5 are configurable. Left/right clicks are intentionally not
capture triggers because ordinary editing would continually start dictation.
Mouse-plus-keyboard chords are rejected rather than partially registered.
Both native mouse paths pass events through to the focused application. Mouse
capture mode suspends dictation dispatch. Existing keyboard suppression rules
remain unchanged to preserve upstream shortcuts.

No polling was added. Native callbacks only report transitions. End-to-end
latency and real hold/toggle behavior still require physical-device validation
on each OS; compilation and unit tests alone do not establish negligible latency.
