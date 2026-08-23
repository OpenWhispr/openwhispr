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

import atexit
import base64
import signal
import sys
import threading
import time

TIMEOUT_SECONDS = 30
MAX_OUTPUT_CHARS = 10240
EFFECTIVE_TEXT_MAX_DEPTH = 8
WAKE_PROBE_MAX_DEPTH = 4
WAKE_SETTLE_MS = 400
FIND_RETRIES = 3
FIND_RETRY_DELAY_MS = 250
OBJECT_REPLACEMENT = "\ufffc"

try:
    import gi

    gi.require_version("Atspi", "2.0")
    gi.require_version("Gio", "2.0")
    from gi.repository import Atspi, GLib, Gio

    HAS_ATSPI = True
except (ImportError, ValueError):
    HAS_ATSPI = False

_a11y_state = {
    "touched": False,
    "set_screen_reader": False,
    "set_is_enabled": False,
    "prior_screen_reader": False,
    "prior_is_enabled": False,
}


def _is_usable_text(value):
    if not value:
        return False
    cleaned = "".join(c for c in value if c != OBJECT_REPLACEMENT).strip()
    return bool(cleaned)


def _usable_content_len(value):
    if not value:
        return 0
    return sum(1 for c in value if c != OBJECT_REPLACEMENT and not c.isspace())


def _text_of(accessible):
    try:
        n = Atspi.Text.get_character_count(accessible)
        if n is None or n <= 0:
            return None
        return Atspi.Text.get_text(accessible, 0, min(int(n), MAX_OUTPUT_CHARS))
    except Exception:
        return None


def _is_editable_field(accessible):
    try:
        state_set = accessible.get_state_set()
        if state_set.contains(Atspi.StateType.EDITABLE):
            return True
        role = accessible.get_role_name() or ""
        return role in ("entry", "text", "password text", "spin button")
    except Exception:
        return False


def _should_walk_child(child, depth):
    try:
        state_set = child.get_state_set()
        if state_set.contains(Atspi.StateType.EDITABLE):
            return True
        role = child.get_role_name() or ""
        if role in ("entry", "text", "password text", "spin button", "section", "static", "paragraph"):
            return True
        return depth < 3
    except Exception:
        return depth < 3


def _read_effective_text(accessible, depth=0):
    if accessible is None or depth > EFFECTIVE_TEXT_MAX_DEPTH:
        return None

    best = None
    direct = _text_of(accessible)
    if _is_usable_text(direct):
        best = direct

    try:
        count = accessible.get_child_count()
    except Exception:
        return best

    for i in range(count):
        try:
            child = accessible.get_child_at_index(i)
        except Exception:
            continue
        if child is None:
            continue
        if not _should_walk_child(child, depth):
            continue
        child_text = _read_effective_text(child, depth + 1)
        if not _is_usable_text(child_text):
            continue
        if best is None or _usable_content_len(child_text) >= _usable_content_len(best):
            best = child_text

    return best


def _focused_field_rank(accessible):
    editable = _is_editable_field(accessible)
    usable = _is_usable_text(_read_effective_text(accessible))
    if editable and usable:
        return 4
    if editable:
        return 3
    if usable:
        return 2
    return 1 if _is_usable_text(_text_of(accessible)) else 0


def _find_best_focused(accessible, best=None):
    """Return (accessible, rank) for the best focused field under accessible."""
    if best is None:
        best = [None, -1]

    try:
        state_set = accessible.get_state_set()
        if state_set.contains(Atspi.StateType.FOCUSED):
            rank = _focused_field_rank(accessible)
            if rank > best[1]:
                best[0] = accessible
                best[1] = rank
    except Exception:
        pass

    if best[1] >= 4:
        return best

    try:
        count = accessible.get_child_count()
    except Exception:
        return best

    for i in range(count):
        try:
            child = accessible.get_child_at_index(i)
        except Exception:
            continue
        if child is None:
            continue
        _find_best_focused(child, best)
        if best[1] >= 4:
            break

    return best


def _find_best_editable_descendant(node, best=None, depth=0):
    if best is None:
        best = [None, -1]
    if node is None or depth > EFFECTIVE_TEXT_MAX_DEPTH:
        return best

    if _is_editable_field(node):
        length = _usable_content_len(_read_effective_text(node))
        if best[0] is None or length > best[1]:
            best[0] = node
            best[1] = length

    try:
        count = node.get_child_count()
    except Exception:
        return best

    for i in range(count):
        try:
            child = node.get_child_at_index(i)
        except Exception:
            continue
        if child is None:
            continue
        _find_best_editable_descendant(child, best, depth + 1)

    return best


def _resolve_monitor_target(focused):
    if focused is None:
        return None
    if _is_editable_field(focused):
        return focused
    best, _length = _find_best_editable_descendant(focused)
    return best or focused


def _dbus_get_bool(prop):
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        result = bus.call_sync(
            "org.a11y.Bus",
            "/org/a11y/bus",
            "org.freedesktop.DBus.Properties",
            "Get",
            GLib.Variant("(ss)", ("org.a11y.Status", prop)),
            GLib.VariantType("(v)"),
            Gio.DBusCallFlags.NONE,
            1000,
            None,
        )
        inner = result.unpack()[0]
        return True, bool(inner)
    except Exception:
        return False, False


def _dbus_set_bool(prop, value):
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        bus.call_sync(
            "org.a11y.Bus",
            "/org/a11y/bus",
            "org.freedesktop.DBus.Properties",
            "Set",
            GLib.Variant("(ssv)", ("org.a11y.Status", prop, GLib.Variant("b", value))),
            None,
            Gio.DBusCallFlags.NONE,
            1000,
            None,
        )
        return True
    except Exception:
        return False


def _restore_a11y_advertise():
    if not _a11y_state["touched"]:
        return
    if _a11y_state["set_screen_reader"]:
        _dbus_set_bool("ScreenReaderEnabled", _a11y_state["prior_screen_reader"])
    if _a11y_state["set_is_enabled"]:
        _dbus_set_bool("IsEnabled", _a11y_state["prior_is_enabled"])
    _a11y_state["touched"] = False


def _ensure_a11y_advertised():
    have_sr, screen_reader = _dbus_get_bool("ScreenReaderEnabled")
    have_en, is_enabled = _dbus_get_bool("IsEnabled")

    if have_sr and not screen_reader and _dbus_set_bool("ScreenReaderEnabled", True):
        _a11y_state["prior_screen_reader"] = False
        _a11y_state["set_screen_reader"] = True
        _a11y_state["touched"] = True

    if have_en and not is_enabled and _dbus_set_bool("IsEnabled", True):
        _a11y_state["prior_is_enabled"] = False
        _a11y_state["set_is_enabled"] = True
        _a11y_state["touched"] = True


def _wake_probe_node(node, depth=0):
    if node is None or depth > WAKE_PROBE_MAX_DEPTH:
        return
    try:
        _ = node.get_attributes()
    except Exception:
        pass
    try:
        _ = node.get_relation_set()
    except Exception:
        pass

    try:
        count = node.get_child_count()
    except Exception:
        return

    limit = count
    if depth == 0 and limit > 8:
        limit = 8
    if depth > 0 and limit > 20:
        limit = 20

    for i in range(limit):
        try:
            child = node.get_child_at_index(i)
        except Exception:
            continue
        if child is None:
            continue
        _wake_probe_node(child, depth + 1)


def _wake_accessibility_trees(desktop):
    try:
        count = desktop.get_child_count()
    except Exception:
        return
    for i in range(count):
        try:
            app = desktop.get_child_at_index(i)
        except Exception:
            continue
        if app is None:
            continue
        _wake_probe_node(app, 0)


def _find_focused_on_desktop(desktop):
    focused = None
    best_rank = -1
    try:
        count = desktop.get_child_count()
    except Exception:
        return None

    for i in range(count):
        try:
            app = desktop.get_child_at_index(i)
            if app is None:
                continue
            candidate, rank = _find_best_focused(app)
            if candidate is not None and rank > best_rank:
                focused = candidate
                best_rank = rank
            if best_rank >= 4:
                break
        except Exception:
            continue

    return _resolve_monitor_target(focused)


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

    atexit.register(_restore_a11y_advertise)
    Atspi.init()
    _ensure_a11y_advertised()

    desktop = Atspi.get_desktop(0)
    _wake_accessibility_trees(desktop)
    time.sleep(WAKE_SETTLE_MS / 1000.0)

    focused = None
    for attempt in range(FIND_RETRIES):
        focused = _find_focused_on_desktop(desktop)
        if focused is not None:
            break
        if attempt + 1 < FIND_RETRIES:
            _wake_accessibility_trees(desktop)
            time.sleep(FIND_RETRY_DELAY_MS / 1000.0)

    if focused is None:
        print("NO_ELEMENT", flush=True)
        sys.exit(1)

    initial_value = _read_effective_text(focused)
    if not initial_value:
        print("NO_VALUE", flush=True)
        sys.exit(0)

    _emit_text("INITIAL_VALUE", initial_value)

    last_value = [initial_value]
    loop = GLib.MainLoop()

    def on_text_changed(_event):
        # Re-read effective text from the captured focused entry — Chromium
        # fires text-changed on descendant static/section nodes, not the entry.
        try:
            new_value = _read_effective_text(focused)
            if not new_value:
                return
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

    def timeout_handler():
        loop.quit()

    timer = threading.Timer(TIMEOUT_SECONDS, timeout_handler)
    timer.daemon = True
    timer.start()

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
