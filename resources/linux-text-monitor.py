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
  NO_ELEMENT            - Could not get focused element
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


def _emit_text(prefix, value):
    truncated = value[:MAX_OUTPUT_CHARS]
    if "\n" in truncated or "\r" in truncated:
        encoded = base64.b64encode(truncated.encode("utf-8")).decode("ascii")
        print(f"{prefix}_B64:{encoded}", flush=True)
    else:
        print(f"{prefix}:{truncated}", flush=True)


def main():
    # Read original text from stdin (consume but don't use in this binary)
    try:
        sys.stdin.readline()
    except Exception:
        pass

    if not HAS_ATSPI:
        print("NO_ELEMENT", flush=True)
        sys.exit(1)

    Atspi.init()

    # Get the focused accessible element
    desktop = Atspi.get_desktop(0)
    focused = None

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
