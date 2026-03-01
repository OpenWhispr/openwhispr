/*
 * portal-paste.c — Simulate Ctrl+V (or Ctrl+Shift+V) via the
 * org.freedesktop.portal.RemoteDesktop D-Bus portal.
 *
 * This goes through the compositor's sanctioned input path (Mutter/libei on
 * GNOME, KWin on KDE) instead of bypassing it via /dev/uinput, which fixes
 * the issue of keystrokes not arriving at native Wayland windows on GNOME.
 *
 * Usage:
 *   portal-paste [--terminal] [--restore-token TOKEN]
 *
 * Exit codes:
 *   0  success
 *   1  D-Bus connection or call error
 *   2  session creation denied / device selection denied
 *   3  Start cancelled by user (dialog dismissed)
 *
 * Compile:
 *   gcc -O2 portal-paste.c -o portal-paste $(pkg-config --cflags --libs gio-2.0)
 */

#include <gio/gio.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define PORTAL_BUS   "org.freedesktop.portal.Desktop"
#define PORTAL_PATH  "/org/freedesktop/portal/desktop"
#define PORTAL_IFACE "org.freedesktop.portal.RemoteDesktop"
#define REQUEST_IFACE "org.freedesktop.portal.Request"

/* evdev keycodes (linux/input-event-codes.h) */
#define KEY_LEFTCTRL  29
#define KEY_LEFTSHIFT 42
#define KEY_V         47

static int exit_code = 0;

typedef struct {
    GDBusConnection *conn;
    GMainLoop       *loop;
    char            *session_handle;
    char            *restore_token;
    guint            signal_id;
    int              use_shift;
} AppData;

/* Get unique sender name as path component (":1.42" -> "1_42") */
static char *get_sender_path(GDBusConnection *conn)
{
    const char *name = g_dbus_connection_get_unique_name(conn);
    char *path = g_strdup(name + 1);
    for (char *p = path; *p; p++) {
        if (*p == '.') *p = '_';
    }
    return path;
}

static guint subscribe_response(AppData *app, const char *request_path,
                                GDBusSignalCallback callback)
{
    return g_dbus_connection_signal_subscribe(
        app->conn, PORTAL_BUS, REQUEST_IFACE, "Response",
        request_path, NULL, G_DBUS_SIGNAL_FLAGS_NO_MATCH_RULE,
        callback, app, NULL);
}

/* Send the actual keystrokes and quit */
static void send_paste(AppData *app)
{
    GError *err = NULL;
    GVariant *opts;

    /* Press Ctrl */
    opts = g_variant_new("a{sv}", NULL);
    g_dbus_connection_call_sync(app->conn, PORTAL_BUS, PORTAL_PATH,
        PORTAL_IFACE, "NotifyKeyboardKeycode",
        g_variant_new("(o@a{sv}iu)", app->session_handle, opts,
                       (gint32)KEY_LEFTCTRL, (guint32)1),
        NULL, G_DBUS_CALL_FLAGS_NONE, -1, NULL, &err);
    if (err) { fprintf(stderr, "Ctrl press: %s\n", err->message); g_clear_error(&err); }

    /* Press Shift (for terminals) */
    if (app->use_shift) {
        opts = g_variant_new("a{sv}", NULL);
        g_dbus_connection_call_sync(app->conn, PORTAL_BUS, PORTAL_PATH,
            PORTAL_IFACE, "NotifyKeyboardKeycode",
            g_variant_new("(o@a{sv}iu)", app->session_handle, opts,
                           (gint32)KEY_LEFTSHIFT, (guint32)1),
            NULL, G_DBUS_CALL_FLAGS_NONE, -1, NULL, &err);
        if (err) { fprintf(stderr, "Shift press: %s\n", err->message); g_clear_error(&err); }
    }

    /* Press V */
    opts = g_variant_new("a{sv}", NULL);
    g_dbus_connection_call_sync(app->conn, PORTAL_BUS, PORTAL_PATH,
        PORTAL_IFACE, "NotifyKeyboardKeycode",
        g_variant_new("(o@a{sv}iu)", app->session_handle, opts,
                       (gint32)KEY_V, (guint32)1),
        NULL, G_DBUS_CALL_FLAGS_NONE, -1, NULL, &err);
    if (err) { fprintf(stderr, "V press: %s\n", err->message); g_clear_error(&err); }

    /* Small delay for compositor to process */
    usleep(20000);

    /* Release V */
    opts = g_variant_new("a{sv}", NULL);
    g_dbus_connection_call_sync(app->conn, PORTAL_BUS, PORTAL_PATH,
        PORTAL_IFACE, "NotifyKeyboardKeycode",
        g_variant_new("(o@a{sv}iu)", app->session_handle, opts,
                       (gint32)KEY_V, (guint32)0),
        NULL, G_DBUS_CALL_FLAGS_NONE, -1, NULL, &err);
    if (err) { fprintf(stderr, "V release: %s\n", err->message); g_clear_error(&err); }

    /* Release Shift */
    if (app->use_shift) {
        opts = g_variant_new("a{sv}", NULL);
        g_dbus_connection_call_sync(app->conn, PORTAL_BUS, PORTAL_PATH,
            PORTAL_IFACE, "NotifyKeyboardKeycode",
            g_variant_new("(o@a{sv}iu)", app->session_handle, opts,
                           (gint32)KEY_LEFTSHIFT, (guint32)0),
            NULL, G_DBUS_CALL_FLAGS_NONE, -1, NULL, &err);
        if (err) { fprintf(stderr, "Shift release: %s\n", err->message); g_clear_error(&err); }
    }

    /* Release Ctrl */
    opts = g_variant_new("a{sv}", NULL);
    g_dbus_connection_call_sync(app->conn, PORTAL_BUS, PORTAL_PATH,
        PORTAL_IFACE, "NotifyKeyboardKeycode",
        g_variant_new("(o@a{sv}iu)", app->session_handle, opts,
                       (gint32)KEY_LEFTCTRL, (guint32)0),
        NULL, G_DBUS_CALL_FLAGS_NONE, -1, NULL, &err);
    if (err) { fprintf(stderr, "Ctrl release: %s\n", err->message); g_clear_error(&err); }

    g_main_loop_quit(app->loop);
}

/* Handle Start response */
static void on_start_response(GDBusConnection *conn, const char *sender,
    const char *object_path, const char *interface_name,
    const char *signal_name, GVariant *parameters, gpointer user_data)
{
    AppData *app = user_data;
    guint32 response;
    GVariant *results;

    g_variant_get(parameters, "(u@a{sv})", &response, &results);
    g_dbus_connection_signal_unsubscribe(app->conn, app->signal_id);

    if (response != 0) {
        fprintf(stderr, "Start cancelled (response=%u)\n", response);
        exit_code = 3;
        g_variant_unref(results);
        g_main_loop_quit(app->loop);
        return;
    }

    /* Extract and print restore_token for the caller to persist */
    GVariant *token_v = g_variant_lookup_value(results, "restore_token",
                                                G_VARIANT_TYPE_STRING);
    if (token_v) {
        const char *token = g_variant_get_string(token_v, NULL);
        /* Print to stdout so the parent process can capture it */
        printf("%s\n", token);
        fflush(stdout);
        g_variant_unref(token_v);
    }

    g_variant_unref(results);
    send_paste(app);
}

/* Handle SelectDevices response, then call Start */
static void on_select_devices_response(GDBusConnection *conn, const char *sender,
    const char *object_path, const char *interface_name,
    const char *signal_name, GVariant *parameters, gpointer user_data)
{
    AppData *app = user_data;
    guint32 response;
    GVariant *results;

    g_variant_get(parameters, "(u@a{sv})", &response, &results);
    g_dbus_connection_signal_unsubscribe(app->conn, app->signal_id);
    g_variant_unref(results);

    if (response != 0) {
        fprintf(stderr, "SelectDevices denied (response=%u)\n", response);
        exit_code = 2;
        g_main_loop_quit(app->loop);
        return;
    }

    char *sender_path = get_sender_path(app->conn);
    char *request_path = g_strdup_printf(
        "/org/freedesktop/portal/desktop/request/%s/start", sender_path);
    g_free(sender_path);

    app->signal_id = subscribe_response(app, request_path, on_start_response);

    GVariantBuilder opts;
    g_variant_builder_init(&opts, G_VARIANT_TYPE("a{sv}"));
    g_variant_builder_add(&opts, "{sv}", "handle_token",
                          g_variant_new_string("start"));

    GError *err = NULL;
    g_dbus_connection_call_sync(app->conn, PORTAL_BUS, PORTAL_PATH,
        PORTAL_IFACE, "Start",
        g_variant_new("(os@a{sv})", app->session_handle, "",
                       g_variant_builder_end(&opts)),
        NULL, G_DBUS_CALL_FLAGS_NONE, -1, NULL, &err);

    g_free(request_path);
    if (err) {
        fprintf(stderr, "Start call failed: %s\n", err->message);
        g_error_free(err);
        exit_code = 1;
        g_main_loop_quit(app->loop);
    }
}

/* Handle CreateSession response, then call SelectDevices */
static void on_create_session_response(GDBusConnection *conn, const char *sender,
    const char *object_path, const char *interface_name,
    const char *signal_name, GVariant *parameters, gpointer user_data)
{
    AppData *app = user_data;
    guint32 response;
    GVariant *results;

    g_variant_get(parameters, "(u@a{sv})", &response, &results);
    g_dbus_connection_signal_unsubscribe(app->conn, app->signal_id);

    if (response != 0) {
        fprintf(stderr, "CreateSession denied (response=%u)\n", response);
        exit_code = 2;
        g_variant_unref(results);
        g_main_loop_quit(app->loop);
        return;
    }

    GVariant *handle_v = g_variant_lookup_value(results, "session_handle",
                                                 G_VARIANT_TYPE_STRING);
    app->session_handle = g_variant_dup_string(handle_v, NULL);
    g_variant_unref(handle_v);
    g_variant_unref(results);

    char *sender_path = get_sender_path(app->conn);
    char *request_path = g_strdup_printf(
        "/org/freedesktop/portal/desktop/request/%s/selectdevices",
        sender_path);
    g_free(sender_path);

    app->signal_id = subscribe_response(app, request_path,
                                        on_select_devices_response);

    GVariantBuilder opts;
    g_variant_builder_init(&opts, G_VARIANT_TYPE("a{sv}"));
    g_variant_builder_add(&opts, "{sv}", "handle_token",
                          g_variant_new_string("selectdevices"));
    g_variant_builder_add(&opts, "{sv}", "types",
                          g_variant_new_uint32(1)); /* KEYBOARD only */
    g_variant_builder_add(&opts, "{sv}", "persist_mode",
                          g_variant_new_uint32(2)); /* persistent */

    if (app->restore_token) {
        g_variant_builder_add(&opts, "{sv}", "restore_token",
                              g_variant_new_string(app->restore_token));
    }

    GError *err = NULL;
    g_dbus_connection_call_sync(app->conn, PORTAL_BUS, PORTAL_PATH,
        PORTAL_IFACE, "SelectDevices",
        g_variant_new("(o@a{sv})", app->session_handle,
                       g_variant_builder_end(&opts)),
        NULL, G_DBUS_CALL_FLAGS_NONE, -1, NULL, &err);

    g_free(request_path);
    if (err) {
        fprintf(stderr, "SelectDevices call failed: %s\n", err->message);
        g_error_free(err);
        exit_code = 1;
        g_main_loop_quit(app->loop);
    }
}

/* Add a timeout so the binary never hangs */
static gboolean on_timeout(gpointer user_data)
{
    AppData *app = user_data;
    fprintf(stderr, "Timeout waiting for portal response\n");
    exit_code = 1;
    g_main_loop_quit(app->loop);
    return G_SOURCE_REMOVE;
}

int main(int argc, char *argv[])
{
    AppData app = { 0 };

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--terminal") == 0) {
            app.use_shift = 1;
        } else if (strcmp(argv[i], "--restore-token") == 0 && i + 1 < argc) {
            app.restore_token = g_strdup(argv[++i]);
        }
    }

    GError *err = NULL;
    app.conn = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &err);
    if (!app.conn) {
        fprintf(stderr, "D-Bus connection failed: %s\n", err->message);
        g_error_free(err);
        return 1;
    }

    app.loop = g_main_loop_new(NULL, FALSE);

    /* 10 second timeout to prevent hanging */
    g_timeout_add_seconds(10, on_timeout, &app);

    char *sender_path = get_sender_path(app.conn);
    char *request_path = g_strdup_printf(
        "/org/freedesktop/portal/desktop/request/%s/createsession",
        sender_path);
    g_free(sender_path);

    app.signal_id = subscribe_response(&app, request_path,
                                       on_create_session_response);

    GVariantBuilder opts;
    g_variant_builder_init(&opts, G_VARIANT_TYPE("a{sv}"));
    g_variant_builder_add(&opts, "{sv}", "handle_token",
                          g_variant_new_string("createsession"));
    g_variant_builder_add(&opts, "{sv}", "session_handle_token",
                          g_variant_new_string("openwhispr"));

    g_dbus_connection_call_sync(app.conn, PORTAL_BUS, PORTAL_PATH,
        PORTAL_IFACE, "CreateSession",
        g_variant_new("(@a{sv})", g_variant_builder_end(&opts)),
        NULL, G_DBUS_CALL_FLAGS_NONE, -1, NULL, &err);

    g_free(request_path);
    if (err) {
        fprintf(stderr, "CreateSession failed: %s\n", err->message);
        g_error_free(err);
        return 1;
    }

    g_main_loop_run(app.loop);

    g_main_loop_unref(app.loop);
    g_free(app.session_handle);
    g_free(app.restore_token);
    g_object_unref(app.conn);

    return exit_code;
}
