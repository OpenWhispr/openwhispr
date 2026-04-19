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
 *   gcc -O2 linux-text-monitor.c -o linux-text-monitor $(pkg-config --cflags --libs atspi-2)
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

int main(void) {
    signal(SIGTERM, signal_handler);
    signal(SIGINT, signal_handler);

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

    GError *error = NULL;
    AtspiAccessible *desktop = atspi_get_desktop(0);
    if (!desktop) {
        printf("NO_ELEMENT\n");
        fflush(stdout);
        return 1;
    }

    /* Search for focused element across all applications */
    AtspiAccessible *focused = NULL;
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

    g_object_unref(desktop);

    if (!focused) {
        printf("NO_ELEMENT\n");
        fflush(stdout);
        return 1;
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
