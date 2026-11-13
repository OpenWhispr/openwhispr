/**
 * Linux Text Edit Monitor
 *
 * Uses AT-SPI2 to monitor the focused text field for value changes.
 * Outputs "CHANGED:<value>" to stdout when the text changes.
 * Exits after a timeout or on receiving a termination signal.
 *
 * Protocol (stdout):
 *   INITIAL_VALUE:<text>  - Initial text field value
 *   INITIAL_VALUE_B64:<base64> - Initial text field value (multiline)
 *   CHANGED:<text>        - Text field value after a change
 *   CHANGED_B64:<base64>  - Text field value after a change (multiline)
 *   EDITABLE              - Focused element in the active window of <pid> is
 *                           writable with no live selection (--probe-editable <pid>)
 *   NOT_EDITABLE          - Focused element is not safely writable
 *   NO_ELEMENT            - Could not get focused element (with --probe-editable,
 *                           also a missing or invalid pid, or no accessible app for it)
 *   NO_VALUE              - Focused element has no text value
 *
 * Input (stdin):
 *   First line: original pasted text (informational)
 *
 * Compile:
 *   gcc -O2 linux-text-monitor.c -o linux-text-monitor $(pkg-config --cflags --libs atspi-2) -lgobject-2.0
 *
 * Note: -lgobject-2.0 must be added explicitly because atspi-2.pc lists
 * gobject-2.0 under Requires.private rather than Requires, so a plain
 * `pkg-config --libs` omits it and the link fails with linkers defaulting
 * to --as-needed (e.g. current Ubuntu/Arch toolchains).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <time.h>
#include <unistd.h>
#include <atspi/atspi.h>

#define TIMEOUT_SECONDS 30
#define POLL_INTERVAL_MS 500
#define MAX_OUTPUT_CHARS 10240
/* libatspi gives every application it hasn't seen yet 15s to answer, so one
 * peer that stops answering (#1944) would hold the probe past the caller's
 * 1.6s kill. linux-fast-paste bounds its calls the same way. */
#define PROBE_ATSPI_CALL_TIMEOUT_MS 500

static volatile sig_atomic_t running = 1;
static const char BASE64_TABLE[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static void signal_handler(int sig) {
    (void)sig;
    running = 0;
}

static char *base64_encode(const unsigned char *data, size_t len) {
    size_t out_len = 4 * ((len + 2) / 3);
    char *out = (char *)malloc(out_len + 1);
    if (!out) return NULL;

    size_t i = 0, j = 0;
    while (i < len) {
        unsigned int octet_a = i < len ? data[i++] : 0;
        unsigned int octet_b = i < len ? data[i++] : 0;
        unsigned int octet_c = i < len ? data[i++] : 0;
        unsigned int triple = (octet_a << 16) | (octet_b << 8) | octet_c;

        out[j++] = BASE64_TABLE[(triple >> 18) & 0x3F];
        out[j++] = BASE64_TABLE[(triple >> 12) & 0x3F];
        out[j++] = BASE64_TABLE[(triple >> 6) & 0x3F];
        out[j++] = BASE64_TABLE[triple & 0x3F];
    }

    if (len % 3 == 1) {
        out[out_len - 1] = '=';
        out[out_len - 2] = '=';
    } else if (len % 3 == 2) {
        out[out_len - 1] = '=';
    }

    out[out_len] = '\0';
    return out;
}

static void print_text_output(const char *name, const char *value) {
    if (!value) return;

    size_t len = strlen(value);
    size_t limit = len < MAX_OUTPUT_CHARS ? len : MAX_OUTPUT_CHARS;

    if (memchr(value, '\n', limit) || memchr(value, '\r', limit)) {
        char *encoded = base64_encode((const unsigned char *)value, limit);
        if (!encoded) return;
        printf("%s_B64:%s\n", name, encoded);
        fflush(stdout);
        free(encoded);
        return;
    }

    printf("%s:%.*s\n", name, (int)limit, value);
    fflush(stdout);
}

static AtspiAccessible *find_focused(AtspiAccessible *accessible) {
    GError *error = NULL;

    AtspiStateSet *states = atspi_accessible_get_state_set(accessible);
    if (states) {
        if (atspi_state_set_contains(states, ATSPI_STATE_FOCUSED)) {
            g_object_unref(states);
            return g_object_ref(accessible);
        }
        g_object_unref(states);
    }

    int count = atspi_accessible_get_child_count(accessible, &error);
    if (error) {
        g_error_free(error);
        return NULL;
    }

    for (int i = 0; i < count; i++) {
        AtspiAccessible *child = atspi_accessible_get_child_at_index(accessible, i, &error);
        if (error) {
            g_error_free(error);
            error = NULL;
            continue;
        }
        if (!child) continue;

        AtspiAccessible *result = find_focused(child);
        g_object_unref(child);
        if (result) return result;
    }

    return NULL;
}

/* The editable probe vouches for the app a paste will reach, so it looks only
 * inside that process's first ACTIVE window. A FOCUSED state left behind in
 * another app must not count, even when the target window has nothing focused
 * or exposes no accessibility at all. */
static AtspiAccessible *find_focused_in_active_window(AtspiAccessible *desktop, gint target_pid) {
    int app_count = atspi_accessible_get_child_count(desktop, NULL);
    for (int i = 0; i < app_count; i++) {
        AtspiAccessible *app = atspi_accessible_get_child_at_index(desktop, i, NULL);
        if (!app) continue;
        GError *pid_error = NULL;
        gint pid = atspi_accessible_get_process_id(app, &pid_error);
        if (pid_error) {
            g_error_free(pid_error);
            pid = 0;
        }
        if (pid != target_pid) {
            g_object_unref(app);
            continue;
        }
        int window_count = atspi_accessible_get_child_count(app, NULL);
        for (int j = 0; j < window_count; j++) {
            AtspiAccessible *win = atspi_accessible_get_child_at_index(app, j, NULL);
            if (!win) continue;
            AtspiStateSet *states = atspi_accessible_get_state_set(win);
            int active = states && atspi_state_set_contains(states, ATSPI_STATE_ACTIVE);
            if (states) g_object_unref(states);
            if (active) {
                AtspiAccessible *focused = find_focused(win);
                g_object_unref(win);
                g_object_unref(app);
                return focused;
            }
            g_object_unref(win);
        }
        g_object_unref(app);
    }
    return NULL;
}

static char *read_text_value(AtspiText *text_iface) {
    GError *error = NULL;

    int char_count = atspi_text_get_character_count(text_iface, &error);
    if (error) {
        g_error_free(error);
        return NULL;
    }
    if (char_count <= 0) return NULL;

    int limit = char_count < MAX_OUTPUT_CHARS ? char_count : MAX_OUTPUT_CHARS;
    char *value = atspi_text_get_text(text_iface, 0, limit, &error);
    if (error) {
        g_error_free(error);
        return NULL;
    }

    return value;
}

int main(int argc, char **argv) {
    int probe_editable = argc >= 2 && strcmp(argv[1], "--probe-editable") == 0;
    /* The probe never reads `running`, so it keeps the default action and the
     * caller's kill at its give-up stops a slow walk. */
    if (!probe_editable) {
        signal(SIGTERM, signal_handler);
        signal(SIGINT, signal_handler);
    }
    gint target_pid = 0;
    if (probe_editable && argc >= 3) {
        char *end = NULL;
        long parsed = strtol(argv[2], &end, 10);
        if (end != argv[2] && *end == '\0' && parsed > 0 && parsed <= G_MAXINT) {
            target_pid = (gint)parsed;
        }
    }
    if (probe_editable && !target_pid) {
        printf("NO_ELEMENT\n");
        fflush(stdout);
        return 1;
    }

    /* Read original text from stdin (consume but don't use) */
    char stdin_buf[4096];
    if (!probe_editable && fgets(stdin_buf, sizeof(stdin_buf), stdin)) {
        /* consumed */
    }

    int init_result = atspi_init();
    if (init_result != 0 && init_result != 1) {
        printf("NO_ELEMENT\n");
        fflush(stdout);
        return 1;
    }
    if (probe_editable) atspi_set_timeout(PROBE_ATSPI_CALL_TIMEOUT_MS, -1);

    GError *error = NULL;
    AtspiAccessible *desktop = atspi_get_desktop(0);
    if (!desktop) {
        printf("NO_ELEMENT\n");
        fflush(stdout);
        return 1;
    }

    AtspiAccessible *focused = NULL;
    if (probe_editable) {
        focused = find_focused_in_active_window(desktop, target_pid);
    } else {
        /* Search for focused element across all applications */
        int app_count = atspi_accessible_get_child_count(desktop, &error);
        if (error) {
            g_error_free(error);
            error = NULL;
            app_count = 0;
        }

        for (int i = 0; i < app_count && !focused; i++) {
            AtspiAccessible *app = atspi_accessible_get_child_at_index(desktop, i, &error);
            if (error) {
                g_error_free(error);
                error = NULL;
                continue;
            }
            if (!app) continue;

            focused = find_focused(app);
            g_object_unref(app);
        }
    }

    g_object_unref(desktop);

    if (!focused) {
        printf("NO_ELEMENT\n");
        fflush(stdout);
        return 1;
    }

    if (probe_editable) {
        /* GTK4 reports a usable field as SENSITIVE without ENABLED; a
         * disabled one has neither. */
        AtspiStateSet *states = atspi_accessible_get_state_set(focused);
        int editable = states &&
            atspi_state_set_contains(states, ATSPI_STATE_EDITABLE) &&
            (atspi_state_set_contains(states, ATSPI_STATE_ENABLED) ||
             atspi_state_set_contains(states, ATSPI_STATE_SENSITIVE)) &&
            atspi_state_set_contains(states, ATSPI_STATE_FOCUSABLE);
        if (states) g_object_unref(states);
        /* AT-SPI has no "protected" state; a secure field is known only by
         * its role (GTK, Qt, Chromium and Firefox all report PASSWORD_TEXT),
         * and generated text must never be pasted into one. A shell prompt
         * must never read as a writable caret either: pasted newlines
         * execute. VTE and Qt terminals expose ATSPI_ROLE_TERMINAL; the
         * caller separately refuses terminals by executable name. A role
         * that cannot be read could be either, so it is not editable. */
        if (editable) {
            GError *role_error = NULL;
            AtspiRole role = atspi_accessible_get_role(focused, &role_error);
            if (role_error) {
                g_error_free(role_error);
                editable = 0;
            } else if (role == ATSPI_ROLE_PASSWORD_TEXT || role == ATSPI_ROLE_TERMINAL) {
                editable = 0;
            }
        }
        /* A live selection means an EDITABLE verdict would let generated text
         * paste over the user's highlighted text. This is the authoritative
         * check: the caller's clipboard-based capture cannot see a selection
         * whose text already matches the clipboard. */
        if (editable) {
            /* A selection that cannot be read could be live, so it is not
             * editable. That includes a Text interface that cannot be read:
             * libatspi returns none when its GetInterfaces call fails. */
            AtspiText *probe_text = atspi_accessible_get_text_iface(focused);
            if (probe_text) {
                GError *selection_error = NULL;
                gint n_selections = atspi_text_get_n_selections(probe_text, &selection_error);
                if (selection_error) {
                    g_error_free(selection_error);
                    selection_error = NULL;
                    editable = 0;
                }
                for (gint i = 0; i < n_selections && editable; i++) {
                    AtspiRange *selection =
                        atspi_text_get_selection(probe_text, i, &selection_error);
                    if (selection_error) {
                        g_error_free(selection_error);
                        selection_error = NULL;
                        editable = 0;
                    } else if (selection && selection->end_offset > selection->start_offset) {
                        editable = 0;
                    }
                    if (selection) g_free(selection);
                }
                g_object_unref(probe_text);
            } else {
                editable = 0;
            }
        }
        printf("%s\n", editable ? "EDITABLE" : "NOT_EDITABLE");
        fflush(stdout);
        g_object_unref(focused);
        return 0;
    }

    /* Get the Text interface */
    AtspiText *text_iface = atspi_accessible_get_text_iface(focused);
    if (!text_iface) {
        printf("NO_VALUE\n");
        fflush(stdout);
        g_object_unref(focused);
        return 0;
    }

    /* Read initial value */
    char *last_value = read_text_value(text_iface);
    if (!last_value) {
        printf("NO_VALUE\n");
        fflush(stdout);
        g_object_unref(text_iface);
        g_object_unref(focused);
        return 0;
    }

    print_text_output("INITIAL_VALUE", last_value);

    /* Poll for changes */
    struct timespec start;
    clock_gettime(CLOCK_MONOTONIC, &start);

    while (running) {
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        long elapsed_ms = (now.tv_sec - start.tv_sec) * 1000 +
                          (now.tv_nsec - start.tv_nsec) / 1000000;
        if (elapsed_ms >= TIMEOUT_SECONDS * 1000) break;

        usleep(POLL_INTERVAL_MS * 1000);

        char *current_value = read_text_value(text_iface);
        if (!current_value) continue;

        if (strcmp(current_value, last_value) != 0) {
            print_text_output("CHANGED", current_value);
            g_free(last_value);
            last_value = current_value;
        } else {
            g_free(current_value);
        }
    }

    g_free(last_value);
    g_object_unref(text_iface);
    g_object_unref(focused);

    return 0;
}
