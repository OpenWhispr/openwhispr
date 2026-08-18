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
 *   NO_ELEMENT            - Could not get focused element
 *   NO_VALUE              - Focused element has no text value
 *
 * Input (stdin):
 *   First line: original pasted text (informational)
 *
 * Compile:
 *   gcc -O2 linux-text-monitor.c -o linux-text-monitor $(pkg-config --cflags --libs atspi-2) -lgobject-2.0 -lgio-2.0
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
#include <gio/gio.h>

#define TIMEOUT_SECONDS 30
#define POLL_INTERVAL_MS 500
#define MAX_OUTPUT_CHARS 10240
#define EFFECTIVE_TEXT_MAX_DEPTH 8
#define WAKE_PROBE_MAX_DEPTH 4
#define WAKE_SETTLE_MS 400
#define FIND_RETRIES 3
#define FIND_RETRY_DELAY_MS 250

/* UTF-8 encoding of U+FFFC OBJECT REPLACEMENT CHARACTER */
#define ORC0 0xEF
#define ORC1 0xBF
#define ORC2 0xBC

static volatile sig_atomic_t running = 1;
static const char BASE64_TABLE[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/* Session a11y advertise — restore on exit if we flipped a property. */
typedef struct {
    int touched;
    int set_screen_reader;
    int set_is_enabled;
    gboolean prior_screen_reader;
    gboolean prior_is_enabled;
} A11yAdvertiseState;

static A11yAdvertiseState g_a11y_state = {0};

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

static int is_orc_at(const unsigned char *p) {
    return p[0] == ORC0 && p[1] == ORC1 && p[2] == ORC2;
}

/* Usable = has non-ORC, non-whitespace content (Chromium composers often return
 * only U+FFFC on the focused entry itself). */
static int is_usable_text(const char *s) {
    if (!s || !*s) return 0;
    const unsigned char *p = (const unsigned char *)s;
    while (*p) {
        if (is_orc_at(p)) {
            p += 3;
            continue;
        }
        if (*p != ' ' && *p != '\t' && *p != '\n' && *p != '\r') return 1;
        p++;
    }
    return 0;
}

static size_t usable_content_len(const char *s) {
    if (!s) return 0;
    size_t n = 0;
    const unsigned char *p = (const unsigned char *)s;
    while (*p) {
        if (is_orc_at(p)) {
            p += 3;
            continue;
        }
        if (*p != ' ' && *p != '\t' && *p != '\n' && *p != '\r') n++;
        p++;
    }
    return n;
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

static char *read_direct_text(AtspiAccessible *node) {
    AtspiText *text_iface = atspi_accessible_get_text_iface(node);
    if (!text_iface) return NULL;
    char *value = read_text_value(text_iface);
    g_object_unref(text_iface);
    return value;
}

static int is_text_field_role(AtspiRole role) {
    return role == ATSPI_ROLE_ENTRY || role == ATSPI_ROLE_TEXT ||
           role == ATSPI_ROLE_PASSWORD_TEXT || role == ATSPI_ROLE_SPIN_BUTTON;
}

static int is_editable_field(AtspiAccessible *node) {
    AtspiStateSet *states = atspi_accessible_get_state_set(node);
    gboolean editable = states && atspi_state_set_contains(states, ATSPI_STATE_EDITABLE);
    if (states) g_object_unref(states);
    if (editable) return 1;

    GError *error = NULL;
    AtspiRole role = atspi_accessible_get_role(node, &error);
    if (error) {
        g_error_free(error);
        return 0;
    }
    return is_text_field_role(role);
}

static int should_walk_child(AtspiAccessible *child, int depth) {
    AtspiStateSet *states = atspi_accessible_get_state_set(child);
    gboolean editable = states && atspi_state_set_contains(states, ATSPI_STATE_EDITABLE);
    if (states) g_object_unref(states);
    if (editable) return 1;

    GError *error = NULL;
    AtspiRole role = atspi_accessible_get_role(child, &error);
    if (error) {
        g_error_free(error);
        return depth < 3;
    }

    if (is_text_field_role(role) || role == ATSPI_ROLE_SECTION || role == ATSPI_ROLE_STATIC ||
        role == ATSPI_ROLE_PARAGRAPH) {
        return 1;
    }
    return depth < 3;
}

/* Prefer longest usable text among this node and editable/text descendants.
 * Chromium composers: entry Text is U+FFFC; draft lives on a child section. */
static char *read_effective_text(AtspiAccessible *node, int depth) {
    if (!node || depth > EFFECTIVE_TEXT_MAX_DEPTH) return NULL;

    char *best = NULL;
    char *direct = read_direct_text(node);
    if (is_usable_text(direct)) {
        best = direct;
    } else {
        g_free(direct);
    }

    GError *error = NULL;
    int count = atspi_accessible_get_child_count(node, &error);
    if (error) {
        g_error_free(error);
        return best;
    }

    for (int i = 0; i < count; i++) {
        AtspiAccessible *child = atspi_accessible_get_child_at_index(node, i, &error);
        if (error) {
            g_error_free(error);
            error = NULL;
            continue;
        }
        if (!child) continue;

        if (should_walk_child(child, depth)) {
            char *child_text = read_effective_text(child, depth + 1);
            if (is_usable_text(child_text)) {
                if (!best || usable_content_len(child_text) >= usable_content_len(best)) {
                    g_free(best);
                    best = child_text;
                } else {
                    g_free(child_text);
                }
            } else {
                g_free(child_text);
            }
        }

        g_object_unref(child);
    }

    return best;
}

/* Rank focused nodes. Prefer editable composers over a focused document web
 * that merely has usable descendant chrome text (notifications, etc.). */
static int focused_field_rank(AtspiAccessible *node) {
    int editable = is_editable_field(node);
    char *effective = read_effective_text(node, 0);
    int usable = is_usable_text(effective);
    g_free(effective);

    if (editable && usable) return 4;
    if (editable) return 3;
    if (usable) return 2;

    char *direct = read_direct_text(node);
    int direct_usable = is_usable_text(direct);
    g_free(direct);
    return direct_usable ? 1 : 0;
}

static void find_best_focused(AtspiAccessible *accessible, AtspiAccessible **best, int *best_rank) {
    GError *error = NULL;

    AtspiStateSet *states = atspi_accessible_get_state_set(accessible);
    gboolean focused = states && atspi_state_set_contains(states, ATSPI_STATE_FOCUSED);
    if (states) g_object_unref(states);

    if (focused) {
        int rank = focused_field_rank(accessible);
        if (rank > *best_rank) {
            if (*best) g_object_unref(*best);
            *best = g_object_ref(accessible);
            *best_rank = rank;
        }
    }

    /* Editable+usable is best; keep searching otherwise so an empty focused
     * entry does not hide a better sibling composer. */
    if (*best_rank >= 4) return;

    int count = atspi_accessible_get_child_count(accessible, &error);
    if (error) {
        g_error_free(error);
        return;
    }

    for (int i = 0; i < count; i++) {
        AtspiAccessible *child = atspi_accessible_get_child_at_index(accessible, i, &error);
        if (error) {
            g_error_free(error);
            error = NULL;
            continue;
        }
        if (!child) continue;

        find_best_focused(child, best, best_rank);
        g_object_unref(child);

        if (*best_rank >= 4) return;
    }
}

/* When focus sits on document chrome, prefer an editable descendant that
 * actually holds the draft (Chromium composers, Cursor Agents, t3code). */
static void find_best_editable_descendant(
    AtspiAccessible *node,
    AtspiAccessible **best,
    size_t *best_len,
    int depth
) {
    if (!node || depth > EFFECTIVE_TEXT_MAX_DEPTH) return;

    if (is_editable_field(node)) {
        char *text = read_effective_text(node, 0);
        size_t len = usable_content_len(text);
        g_free(text);
        if (!*best || len > *best_len) {
            if (*best) g_object_unref(*best);
            *best = g_object_ref(node);
            *best_len = len;
        }
    }

    GError *error = NULL;
    int count = atspi_accessible_get_child_count(node, &error);
    if (error) {
        g_error_free(error);
        return;
    }

    for (int i = 0; i < count; i++) {
        AtspiAccessible *child = atspi_accessible_get_child_at_index(node, i, &error);
        if (error) {
            g_error_free(error);
            error = NULL;
            continue;
        }
        if (!child) continue;
        find_best_editable_descendant(child, best, best_len, depth + 1);
        g_object_unref(child);
    }
}

static AtspiAccessible *resolve_monitor_target(AtspiAccessible *focused) {
    if (!focused) return NULL;
    if (is_editable_field(focused)) return g_object_ref(focused);

    AtspiAccessible *best = NULL;
    size_t best_len = 0;
    find_best_editable_descendant(focused, &best, &best_len, 0);
    if (best) return best;
    return g_object_ref(focused);
}

static gboolean dbus_get_a11y_bool(GDBusConnection *conn, const char *prop, gboolean *out) {
    GError *error = NULL;
    GVariant *result = g_dbus_connection_call_sync(
        conn,
        "org.a11y.Bus",
        "/org/a11y/bus",
        "org.freedesktop.DBus.Properties",
        "Get",
        g_variant_new("(ss)", "org.a11y.Status", prop),
        G_VARIANT_TYPE("(v)"),
        G_DBUS_CALL_FLAGS_NONE,
        1000,
        NULL,
        &error
    );
    if (error) {
        g_error_free(error);
        return FALSE;
    }

    GVariant *inner = NULL;
    g_variant_get(result, "(v)", &inner);
    g_variant_unref(result);
    if (!inner || !g_variant_is_of_type(inner, G_VARIANT_TYPE_BOOLEAN)) {
        if (inner) g_variant_unref(inner);
        return FALSE;
    }
    *out = g_variant_get_boolean(inner);
    g_variant_unref(inner);
    return TRUE;
}

static gboolean dbus_set_a11y_bool(GDBusConnection *conn, const char *prop, gboolean value) {
    GError *error = NULL;
    GVariant *result = g_dbus_connection_call_sync(
        conn,
        "org.a11y.Bus",
        "/org/a11y/bus",
        "org.freedesktop.DBus.Properties",
        "Set",
        g_variant_new("(ssv)", "org.a11y.Status", prop, g_variant_new_boolean(value)),
        NULL,
        G_DBUS_CALL_FLAGS_NONE,
        1000,
        NULL,
        &error
    );
    if (error) {
        g_error_free(error);
        return FALSE;
    }
    if (result) g_variant_unref(result);
    return TRUE;
}

static void restore_a11y_advertise(void) {
    if (!g_a11y_state.touched) return;

    GError *error = NULL;
    GDBusConnection *conn = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &error);
    if (error || !conn) {
        if (error) g_error_free(error);
        g_a11y_state.touched = 0;
        return;
    }

    if (g_a11y_state.set_screen_reader) {
        dbus_set_a11y_bool(conn, "ScreenReaderEnabled", g_a11y_state.prior_screen_reader);
    }
    if (g_a11y_state.set_is_enabled) {
        dbus_set_a11y_bool(conn, "IsEnabled", g_a11y_state.prior_is_enabled);
    }

    g_object_unref(conn);
    g_a11y_state.touched = 0;
}

/* Soft-advertise AT so Chromium/Electron enable their accessibility cache.
 * Restored via restore_a11y_advertise() — never leave ScreenReaderEnabled stuck on
 * if we were the ones who flipped it (same caution as macOS AXEnhancedUserInterface). */
static void ensure_a11y_advertised(void) {
    GError *error = NULL;
    GDBusConnection *conn = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &error);
    if (error || !conn) {
        if (error) g_error_free(error);
        return;
    }

    gboolean screen_reader = FALSE;
    gboolean is_enabled = FALSE;
    int have_sr = dbus_get_a11y_bool(conn, "ScreenReaderEnabled", &screen_reader);
    int have_en = dbus_get_a11y_bool(conn, "IsEnabled", &is_enabled);

    if (have_sr && !screen_reader) {
        if (dbus_set_a11y_bool(conn, "ScreenReaderEnabled", TRUE)) {
            g_a11y_state.prior_screen_reader = FALSE;
            g_a11y_state.set_screen_reader = 1;
            g_a11y_state.touched = 1;
        }
    }
    if (have_en && !is_enabled) {
        if (dbus_set_a11y_bool(conn, "IsEnabled", TRUE)) {
            g_a11y_state.prior_is_enabled = FALSE;
            g_a11y_state.set_is_enabled = 1;
            g_a11y_state.touched = 1;
        }
    }

    g_object_unref(conn);
}

/* Orca-style probes: Chromium EnableAXMode hooks on GetAttributes / RefRelationSet. */
static void wake_probe_node(AtspiAccessible *node, int depth) {
    if (!node || depth > WAKE_PROBE_MAX_DEPTH) return;

    GError *error = NULL;
    GHashTable *attrs = atspi_accessible_get_attributes(node, &error);
    if (error) {
        g_error_free(error);
        error = NULL;
    }
    if (attrs) g_hash_table_unref(attrs);

    GArray *rels = atspi_accessible_get_relation_set(node, &error);
    if (error) {
        g_error_free(error);
        error = NULL;
    }
    if (rels) {
        for (guint i = 0; i < rels->len; i++) {
            AtspiRelation *rel = g_array_index(rels, AtspiRelation *, i);
            if (rel) g_object_unref(rel);
        }
        g_array_free(rels, TRUE);
    }

    int count = atspi_accessible_get_child_count(node, &error);
    if (error) {
        g_error_free(error);
        return;
    }

    int limit = count;
    if (depth == 0 && limit > 8) limit = 8;
    if (depth > 0 && limit > 20) limit = 20;

    for (int i = 0; i < limit; i++) {
        AtspiAccessible *child = atspi_accessible_get_child_at_index(node, i, &error);
        if (error) {
            g_error_free(error);
            error = NULL;
            continue;
        }
        if (!child) continue;
        wake_probe_node(child, depth + 1);
        g_object_unref(child);
    }
}

static void wake_accessibility_trees(AtspiAccessible *desktop) {
    GError *error = NULL;
    int app_count = atspi_accessible_get_child_count(desktop, &error);
    if (error) {
        g_error_free(error);
        return;
    }

    for (int i = 0; i < app_count; i++) {
        AtspiAccessible *app = atspi_accessible_get_child_at_index(desktop, i, &error);
        if (error) {
            g_error_free(error);
            error = NULL;
            continue;
        }
        if (!app) continue;
        wake_probe_node(app, 0);
        g_object_unref(app);
    }
}

static AtspiAccessible *find_focused_on_desktop(AtspiAccessible *desktop) {
    AtspiAccessible *focused = NULL;
    int best_rank = -1;
    GError *error = NULL;
    int app_count = atspi_accessible_get_child_count(desktop, &error);
    if (error) {
        g_error_free(error);
        return NULL;
    }

    for (int i = 0; i < app_count; i++) {
        AtspiAccessible *app = atspi_accessible_get_child_at_index(desktop, i, &error);
        if (error) {
            g_error_free(error);
            error = NULL;
            continue;
        }
        if (!app) continue;

        find_best_focused(app, &focused, &best_rank);
        g_object_unref(app);
        if (best_rank >= 4) break;
    }

    if (!focused) return NULL;

    AtspiAccessible *target = resolve_monitor_target(focused);
    g_object_unref(focused);
    return target;
}

int main(void) {
    signal(SIGTERM, signal_handler);
    signal(SIGINT, signal_handler);
    atexit(restore_a11y_advertise);

    /* Read original text from stdin (consume but don't use) */
    char stdin_buf[4096];
    if (fgets(stdin_buf, sizeof(stdin_buf), stdin)) {
        /* consumed */
    }

    int init_result = atspi_init();
    if (init_result != 0 && init_result != 1) {
        printf("NO_ELEMENT\n");
        fflush(stdout);
        return 1;
    }

    ensure_a11y_advertised();

    AtspiAccessible *desktop = atspi_get_desktop(0);
    if (!desktop) {
        printf("NO_ELEMENT\n");
        fflush(stdout);
        return 1;
    }

    wake_accessibility_trees(desktop);
    usleep(WAKE_SETTLE_MS * 1000);

    AtspiAccessible *focused = NULL;
    for (int attempt = 0; attempt < FIND_RETRIES; attempt++) {
        focused = find_focused_on_desktop(desktop);
        if (focused) break;
        if (attempt + 1 < FIND_RETRIES) {
            wake_accessibility_trees(desktop);
            usleep(FIND_RETRY_DELAY_MS * 1000);
        }
    }

    g_object_unref(desktop);

    if (!focused) {
        printf("NO_ELEMENT\n");
        fflush(stdout);
        return 1;
    }

    /* Re-read effective text each poll — Chromium rebuilds descendant text nodes. */
    char *last_value = read_effective_text(focused, 0);
    if (!last_value) {
        printf("NO_VALUE\n");
        fflush(stdout);
        g_object_unref(focused);
        return 0;
    }

    print_text_output("INITIAL_VALUE", last_value);

    struct timespec start;
    clock_gettime(CLOCK_MONOTONIC, &start);

    while (running) {
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        long elapsed_ms = (now.tv_sec - start.tv_sec) * 1000 +
                          (now.tv_nsec - start.tv_nsec) / 1000000;
        if (elapsed_ms >= TIMEOUT_SECONDS * 1000) break;

        usleep(POLL_INTERVAL_MS * 1000);

        char *current_value = read_effective_text(focused, 0);
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
    g_object_unref(focused);

    return 0;
}
