#!/usr/bin/env python3
"""
Linux Text Edit Monitor

Uses AT-SPI2 to monitor the focused text field for changes.
Outputs "CHANGED:<value>" to stdout when the text changes.
Exits after a timeout or on receiving SIGTERM.

Protocol (stdout):
  INITIAL_VALUE:<text>  - Initial text field value
  INITIAL_VALUE_B64:<base64> - Initial text field value (multiline)
  CHANGED:<text>        - Text field value after a change
  CHANGED_B64:<base64>  - Text field value after a change (multiline)
  EDITABLE              - Focused element in the active window of <pid> is
                          writable with no live selection (--probe-editable <pid>)
  NOT_EDITABLE          - Focused element is not safely writable
  NO_ELEMENT            - Could not get focused element (with --probe-editable,
                          also a missing or invalid pid, or no accessible app for it)
  NO_VALUE              - Focused element has no text value

Input (stdin):
  First line: original pasted text (informational)

Requires: python3-atspi / pyatspi (gi.repository.Atspi)
"""

import sys
import signal
import threading
import base64

TIMEOUT_SECONDS = 30
MAX_OUTPUT_CHARS = 10240
# libatspi gives every application it hasn't seen yet 15s to answer, so one
# peer that stops answering (#1944) would hold the probe past the caller's
# 1.6s kill. linux-fast-paste bounds its calls the same way.
PROBE_ATSPI_CALL_TIMEOUT_MS = 500

try:
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi, GLib
    HAS_ATSPI = True
except (ImportError, ValueError):
    HAS_ATSPI = False


def _find_focused(accessible):
    """Recursively find the focused accessible element."""
    try:
        state_set = accessible.get_state_set()
        if state_set.contains(Atspi.StateType.FOCUSED):
            return accessible
        for i in range(accessible.get_child_count()):
            child = accessible.get_child_at_index(i)
            if child is None:
                continue
            result = _find_focused(child)
            if result is not None:
                return result
    except Exception:
        pass
    return None


# The editable probe vouches for the app a paste will reach, so it looks only
# inside that process's first ACTIVE window. A FOCUSED state left behind in
# another app must not count, even when the target window has nothing focused
# or exposes no accessibility at all.
def _find_focused_in_active_window(desktop, target_pid):
    for i in range(desktop.get_child_count()):
        try:
            app = desktop.get_child_at_index(i)
            if app is None or app.get_process_id() != target_pid:
                continue
            window_count = app.get_child_count()
        except Exception:
            continue
        for j in range(window_count):
            try:
                window = app.get_child_at_index(j)
                active = window is not None and window.get_state_set().contains(
                    Atspi.StateType.ACTIVE
                )
            except Exception:
                continue
            if active:
                return _find_focused(window)
    return None


def _emit_text(prefix, value):
    truncated = value[:MAX_OUTPUT_CHARS]
    if "\n" in truncated or "\r" in truncated:
        encoded = base64.b64encode(truncated.encode("utf-8")).decode("ascii")
        print(f"{prefix}_B64:{encoded}", flush=True)
    else:
        print(f"{prefix}:{truncated}", flush=True)


def _parse_pid(value):
    try:
        pid = int(value)
    except ValueError:
        return 0
    return pid if 0 < pid <= 2**31 - 1 else 0


def main():
    probe_editable = len(sys.argv) >= 2 and sys.argv[1] == "--probe-editable"
    target_pid = _parse_pid(sys.argv[2]) if probe_editable and len(sys.argv) >= 3 else 0
    if probe_editable and not target_pid:
        print("NO_ELEMENT", flush=True)
        sys.exit(1)

    # Read original text from stdin (consume but don't use in this binary)
    if not probe_editable:
        try:
            sys.stdin.readline()
        except Exception:
            pass

    if not HAS_ATSPI:
        print("NO_ELEMENT", flush=True)
        sys.exit(1)

    Atspi.init()
    if probe_editable:
        Atspi.set_timeout(PROBE_ATSPI_CALL_TIMEOUT_MS, -1)

    # Get the focused accessible element
    desktop = Atspi.get_desktop(0)
    focused = None

    if probe_editable:
        focused = _find_focused_in_active_window(desktop, target_pid)
    else:
        # Search for the focused element across all applications
        for i in range(desktop.get_child_count()):
            try:
                app = desktop.get_child_at_index(i)
                if app is None:
                    continue
                focused = _find_focused(app)
                if focused is not None:
                    break
            except Exception:
                continue

    if focused is None:
        print("NO_ELEMENT", flush=True)
        sys.exit(1)

    if probe_editable:
        try:
            states = focused.get_state_set()
            # GTK4 reports a usable field as SENSITIVE without ENABLED; a
            # disabled one has neither.
            editable = (
                states.contains(Atspi.StateType.EDITABLE)
                and (
                    states.contains(Atspi.StateType.ENABLED)
                    or states.contains(Atspi.StateType.SENSITIVE)
                )
                and states.contains(Atspi.StateType.FOCUSABLE)
            )
        except Exception:
            editable = False
        # AT-SPI has no "protected" state; a secure field is known only by its
        # role (GTK, Qt, Chromium and Firefox all report PASSWORD_TEXT), and
        # generated text must never be pasted into one. A shell prompt must
        # never read as a writable caret either: pasted newlines execute. VTE
        # and Qt terminals expose the TERMINAL role; the caller separately
        # refuses terminals by executable name. A role that cannot be read
        # could be either, so it is not editable.
        if editable:
            try:
                if focused.get_role() in (Atspi.Role.PASSWORD_TEXT, Atspi.Role.TERMINAL):
                    editable = False
            except Exception:
                editable = False
        # A live selection means an EDITABLE verdict would let generated text
        # paste over the user's highlighted text. This is the authoritative
        # check: the caller's clipboard-based capture cannot see a selection
        # whose text already matches the clipboard.
        # GI returns the text interface as an Atspi.Accessible, whose own
        # get_selection() is the unrelated Selection interface, so the Text
        # methods are called unbound. A selection that cannot be read could
        # be live, so it is not editable. That includes a Text interface that
        # cannot be read: libatspi returns none when its GetInterfaces call
        # fails.
        if editable:
            try:
                text_iface = focused.get_text_iface()
                if text_iface:
                    for i in range(Atspi.Text.get_n_selections(text_iface)):
                        selection = Atspi.Text.get_selection(text_iface, i)
                        if selection and selection.end_offset > selection.start_offset:
                            editable = False
                            break
                else:
                    editable = False
            except Exception:
                editable = False
        print("EDITABLE" if editable else "NOT_EDITABLE", flush=True)
        sys.exit(0)

    # Check if the element supports the Text interface
    try:
        text_iface = focused.get_text_iface()
        if text_iface is None:
            print("NO_VALUE", flush=True)
            sys.exit(0)
    except Exception:
        print("NO_VALUE", flush=True)
        sys.exit(0)

    # Read initial value
    try:
        char_count = text_iface.get_character_count()
        initial_value = text_iface.get_text(0, min(char_count, MAX_OUTPUT_CHARS))
        _emit_text("INITIAL_VALUE", initial_value)
    except Exception:
        print("NO_VALUE", flush=True)
        sys.exit(0)

    # Set up event listener for text changes
    last_value = [initial_value]
    loop = GLib.MainLoop()

    def on_text_changed(event):
        try:
            source = event.source
            ti = source.get_text_iface()
            if ti is None:
                return
            cc = ti.get_character_count()
            new_value = ti.get_text(0, min(cc, MAX_OUTPUT_CHARS))
            if new_value != last_value[0]:
                last_value[0] = new_value
                _emit_text("CHANGED", new_value)
        except Exception:
            pass

    Atspi.EventListener.register_from_callback(
        on_text_changed, "object:text-changed:insert"
    )
    Atspi.EventListener.register_from_callback(
        on_text_changed, "object:text-changed:delete"
    )

    # Set up timeout
    def timeout_handler():
        loop.quit()
    timer = threading.Timer(TIMEOUT_SECONDS, timeout_handler)
    timer.daemon = True
    timer.start()

    # Handle SIGTERM
    def sigterm_handler(signum, frame):
        loop.quit()
    signal.signal(signal.SIGTERM, sigterm_handler)
    signal.signal(signal.SIGINT, sigterm_handler)

    try:
        loop.run()
    except KeyboardInterrupt:
        pass

    timer.cancel()


if __name__ == "__main__":
    main()
