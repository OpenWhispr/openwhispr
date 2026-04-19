#define _GNU_SOURCE

#include <gio/gio.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define PORTAL_BUS "org.freedesktop.portal.Desktop"
#define PORTAL_PATH "/org/freedesktop/portal/desktop"
#define SCREENCAST_IFACE "org.freedesktop.portal.ScreenCast"
#define PROPERTIES_IFACE "org.freedesktop.DBus.Properties"
#define REQUEST_IFACE "org.freedesktop.portal.Request"

#define SCREENCAST_SOURCE_MONITOR 1u
#define SCREENCAST_PERSIST_PERMANENT 2u

typedef enum {
    MODE_PROBE = 0,
    MODE_GRANT = 1,
    MODE_START = 2,
} HelperMode;

typedef struct {
    GDBusConnection *conn;
    GMainLoop *loop;
    HelperMode mode;
    gchar *restore_token;
    gchar *session_handle;
    gchar *create_token;
    gchar *select_token;
    gchar *start_token;
    gchar *create_request_path;
    gchar *select_request_path;
    gchar *start_request_path;
    guint signal_id;
    guint portal_version;
    guint available_source_types;
    gboolean supports_persist_mode;
    gboolean supports_restore_token;
    gboolean supports_system_audio;
    gboolean probe_ok;
    gboolean requested_restore_token;
    gboolean result_printed;
    int exit_code;
} Helper;

static void json_print_escaped(FILE *stream, const char *value)
{
    const unsigned char *ptr = (const unsigned char *)value;

    fputc('"', stream);
    for (; ptr && *ptr; ptr++) {
        switch (*ptr) {
            case '\\':
                fputs("\\\\", stream);
                break;
            case '"':
                fputs("\\\"", stream);
                break;
            case '\b':
                fputs("\\b", stream);
                break;
            case '\f':
                fputs("\\f", stream);
                break;
            case '\n':
                fputs("\\n", stream);
                break;
            case '\r':
                fputs("\\r", stream);
                break;
            case '\t':
                fputs("\\t", stream);
                break;
            default:
                if (*ptr < 0x20) {
                    fprintf(stream, "\\u%04x", *ptr);
                } else {
                    fputc(*ptr, stream);
                }
                break;
        }
    }
    fputc('"', stream);
}

static void json_print_nullable_string(FILE *stream, const char *value)
{
    if (!value) {
        fputs("null", stream);
        return;
    }

    json_print_escaped(stream, value);
}

static void print_probe_json(const Helper *app)
{
    fputs("{\"ok\":", stdout);
    fputs(app->probe_ok ? "true" : "false", stdout);
    fprintf(stdout, ",\"portalVersion\":%u", app->portal_version);
    fputs(",\"supportsPersistMode\":", stdout);
    fputs(app->supports_persist_mode ? "true" : "false", stdout);
    fputs(",\"supportsRestoreToken\":", stdout);
    fputs(app->supports_restore_token ? "true" : "false", stdout);
    fputs(",\"supportsSystemAudio\":", stdout);
    fputs(app->supports_system_audio ? "true" : "false", stdout);
    fputs(",\"supportsNativeCapture\":false", stdout);

    if (!app->probe_ok) {
        const char *message = "portal_unavailable";
        fputs(",\"error\":", stdout);
        json_print_escaped(stdout, message);
    }

    fputs("}\n", stdout);
    fflush(stdout);
}

static void print_grant_json(gboolean granted, const char *restore_token, guint portal_version,
                             const char *source, const char *error)
{
    fputs("{\"granted\":", stdout);
    fputs(granted ? "true" : "false", stdout);
    fputs(",\"restoreToken\":", stdout);
    json_print_nullable_string(stdout, restore_token);
    fprintf(stdout, ",\"portalVersion\":%u", portal_version);
    fputs(",\"source\":", stdout);
    json_print_escaped(stdout, source);

    if (error) {
        fputs(",\"error\":", stdout);
        json_print_escaped(stdout, error);
    }

    fputs("}\n", stdout);
    fflush(stdout);
}

static void emit_event(const char *type, const char *code, const char *message,
                       const char *restore_token)
{
    fputs("{\"type\":", stderr);
    json_print_escaped(stderr, type);

    if (code) {
        fputs(",\"code\":", stderr);
        json_print_escaped(stderr, code);
    }

    if (message) {
        fputs(",\"message\":", stderr);
        json_print_escaped(stderr, message);
    }

    if (restore_token || strcmp(type, "start") == 0) {
        fputs(",\"restoreToken\":", stderr);
        json_print_nullable_string(stderr, restore_token);
    }

    fputs("}\n", stderr);
    fflush(stderr);
}

static gchar *make_token(const char *suffix)
{
    return g_strdup_printf("ow_%d_%s", (int)getpid(), suffix);
}

static gchar *get_sender_path(GDBusConnection *conn)
{
    const char *name = g_dbus_connection_get_unique_name(conn);
    gchar *path = g_strdup(name + 1);

    for (char *ptr = path; ptr && *ptr; ptr++) {
        if (*ptr == '.') {
            *ptr = '_';
        }
    }

    return path;
}

static gchar *make_request_path(GDBusConnection *conn, const char *token)
{
    gchar *sender_path = get_sender_path(conn);
    gchar *request_path = g_strdup_printf(
        "/org/freedesktop/portal/desktop/request/%s/%s", sender_path, token);
    g_free(sender_path);
    return request_path;
}

static guint subscribe_response(Helper *app, const char *request_path, GDBusSignalCallback callback)
{
    return g_dbus_connection_signal_subscribe(
        app->conn, PORTAL_BUS, REQUEST_IFACE, "Response",
        request_path, NULL, G_DBUS_SIGNAL_FLAGS_NO_MATCH_RULE, callback, app, NULL);
}

static gboolean get_portal_uint_property(GDBusConnection *conn, const char *property_name,
                                         guint *value_out)
{
    GError *error = NULL;
    GVariant *result = g_dbus_connection_call_sync(
        conn, PORTAL_BUS, PORTAL_PATH, PROPERTIES_IFACE, "Get",
        g_variant_new("(ss)", SCREENCAST_IFACE, property_name), G_VARIANT_TYPE("(v)"),
        G_DBUS_CALL_FLAGS_NONE, -1, NULL, &error);

    if (!result) {
        g_clear_error(&error);
        return FALSE;
    }

    GVariant *value = NULL;
    g_variant_get(result, "(@v)", &value);

    if (!value || !g_variant_is_of_type(value, G_VARIANT_TYPE_UINT32)) {
        if (value) {
            g_variant_unref(value);
        }
        g_variant_unref(result);
        return FALSE;
    }

    *value_out = g_variant_get_uint32(value);
    g_variant_unref(value);
    g_variant_unref(result);
    return TRUE;
}

static gboolean load_portal_capabilities(Helper *app)
{
    GError *error = NULL;
    app->conn = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &error);
    if (!app->conn) {
        g_clear_error(&error);
        return FALSE;
    }

    gboolean got_version = get_portal_uint_property(app->conn, "version", &app->portal_version);
    gboolean got_sources = get_portal_uint_property(app->conn, "AvailableSourceTypes",
                                                    &app->available_source_types);

    app->supports_persist_mode = app->portal_version >= 4;
    app->supports_restore_token = app->portal_version >= 4;
    app->supports_system_audio = (app->available_source_types & SCREENCAST_SOURCE_MONITOR) != 0;
    app->probe_ok = got_version && got_sources;

    return app->probe_ok;
}

static void finish_grant(Helper *app, gboolean granted, const char *restore_token,
                         const char *error)
{
    if (app->result_printed) {
        return;
    }

    app->result_printed = TRUE;
    print_grant_json(granted, restore_token, app->portal_version, "screen-cast", error);
    if (app->loop) {
        g_main_loop_quit(app->loop);
    }
}

static void finish_start(Helper *app, int exit_code)
{
    app->exit_code = exit_code;
    if (app->loop) {
        g_main_loop_quit(app->loop);
    }
}

static void on_start_response(GDBusConnection *conn, const char *sender, const char *object_path,
                              const char *interface_name, const char *signal_name,
                              GVariant *parameters, gpointer user_data);

static void on_select_sources_response(GDBusConnection *conn, const char *sender,
                                       const char *object_path, const char *interface_name,
                                       const char *signal_name, GVariant *parameters,
                                       gpointer user_data)
{
    Helper *app = user_data;
    guint32 response = 0;
    GVariant *results = NULL;

    g_variant_get(parameters, "(u@a{sv})", &response, &results);
    g_dbus_connection_signal_unsubscribe(app->conn, app->signal_id);

    if (response != 0) {
        g_variant_unref(results);
        if (app->mode == MODE_GRANT) {
            finish_grant(app, FALSE, NULL, "permission_denied");
        } else {
            emit_event("error", "permission_denied", "Portal denied system audio capture", NULL);
            finish_start(app, 2);
        }
        return;
    }

    g_variant_unref(results);

    app->signal_id = subscribe_response(app, app->start_request_path, on_start_response);

    GVariantBuilder opts;
    g_variant_builder_init(&opts, G_VARIANT_TYPE("a{sv}"));
    g_variant_builder_add(&opts, "{sv}", "handle_token", g_variant_new_string(app->start_token));

    GError *error = NULL;
    g_dbus_connection_call_sync(
        app->conn, PORTAL_BUS, PORTAL_PATH, SCREENCAST_IFACE, "Start",
        g_variant_new("(os@a{sv})", app->session_handle, "", g_variant_builder_end(&opts)),
        NULL, G_DBUS_CALL_FLAGS_NONE, -1, NULL, &error);

    if (error) {
        g_dbus_connection_signal_unsubscribe(app->conn, app->signal_id);
        if (app->mode == MODE_GRANT) {
            finish_grant(app, FALSE, NULL, error->message);
        } else {
            emit_event("error", "portal_error", error->message, NULL);
            finish_start(app, 2);
        }
        g_error_free(error);
    }
}

static void on_create_session_response(GDBusConnection *conn, const char *sender,
                                       const char *object_path, const char *interface_name,
                                       const char *signal_name, GVariant *parameters,
                                       gpointer user_data)
{
    Helper *app = user_data;
    guint32 response = 0;
    GVariant *results = NULL;

    g_variant_get(parameters, "(u@a{sv})", &response, &results);
    g_dbus_connection_signal_unsubscribe(app->conn, app->signal_id);

    if (response != 0) {
        g_variant_unref(results);
        if (app->mode == MODE_GRANT) {
            finish_grant(app, FALSE, NULL, "permission_denied");
        } else {
            emit_event("error", "permission_denied", "Portal denied system audio capture", NULL);
            finish_start(app, 2);
        }
        return;
    }

    GVariant *handle_value = g_variant_lookup_value(results, "session_handle", G_VARIANT_TYPE_STRING);
    if (!handle_value) {
        g_variant_unref(results);
        if (app->mode == MODE_GRANT) {
            finish_grant(app, FALSE, NULL, "portal_error");
        } else {
            emit_event("error", "portal_error", "Missing session handle in portal response", NULL);
            finish_start(app, 2);
        }
        return;
    }

    g_free(app->session_handle);
    app->session_handle = g_variant_dup_string(handle_value, NULL);
    g_variant_unref(handle_value);
    g_variant_unref(results);

    app->select_request_path = make_request_path(app->conn, app->select_token);
    app->signal_id = subscribe_response(app, app->select_request_path, on_select_sources_response);

    GVariantBuilder opts;
    g_variant_builder_init(&opts, G_VARIANT_TYPE("a{sv}"));
    g_variant_builder_add(&opts, "{sv}", "handle_token", g_variant_new_string(app->select_token));
    g_variant_builder_add(&opts, "{sv}", "types",
                          g_variant_new_uint32(SCREENCAST_SOURCE_MONITOR));

    if (app->supports_persist_mode) {
        g_variant_builder_add(&opts, "{sv}", "persist_mode",
                              g_variant_new_uint32(SCREENCAST_PERSIST_PERMANENT));
    }

    if (app->supports_restore_token && app->restore_token) {
        g_variant_builder_add(&opts, "{sv}", "restore_token",
                              g_variant_new_string(app->restore_token));
    }

    GError *error = NULL;
    g_dbus_connection_call_sync(
        app->conn, PORTAL_BUS, PORTAL_PATH, SCREENCAST_IFACE, "SelectSources",
        g_variant_new("(o@a{sv})", app->session_handle, g_variant_builder_end(&opts)),
        NULL, G_DBUS_CALL_FLAGS_NONE, -1, NULL, &error);

    if (error) {
        g_dbus_connection_signal_unsubscribe(app->conn, app->signal_id);
        if (app->mode == MODE_GRANT) {
            finish_grant(app, FALSE, NULL, error->message);
        } else {
            emit_event("error", "portal_error", error->message, NULL);
            finish_start(app, 2);
        }
        g_error_free(error);
    }
}

static void on_start_response(GDBusConnection *conn, const char *sender, const char *object_path,
                              const char *interface_name, const char *signal_name,
                              GVariant *parameters, gpointer user_data)
{
    Helper *app = user_data;
    guint32 response = 0;
    GVariant *results = NULL;

    g_variant_get(parameters, "(u@a{sv})", &response, &results);
    g_dbus_connection_signal_unsubscribe(app->conn, app->signal_id);

    if (response != 0) {
        g_variant_unref(results);
        if (app->mode == MODE_GRANT) {
            finish_grant(app, FALSE, NULL, "permission_denied");
        } else {
            emit_event("error", "permission_denied", "Portal denied system audio capture", NULL);
            finish_start(app, 2);
        }
        return;
    }

    const gchar *restore_token = NULL;
    GVariant *restore_value = g_variant_lookup_value(results, "restore_token", G_VARIANT_TYPE_STRING);
    if (restore_value) {
        restore_token = g_variant_get_string(restore_value, NULL);
    }

    if (app->mode == MODE_GRANT) {
        gchar *restore_copy = restore_token ? g_strdup(restore_token) : NULL;
        if (restore_value) {
            g_variant_unref(restore_value);
        }
        g_variant_unref(results);
        finish_grant(app, TRUE, restore_copy, NULL);
        g_free(restore_copy);
        return;
    }

    emit_event("start", NULL, NULL, restore_token);

    if (app->requested_restore_token && !restore_token) {
        emit_event("warning", "restore_failed",
                   "Restore token was supplied but the portal did not return a replacement token",
                   NULL);
    }

    emit_event("warning", "capture_unimplemented",
               "Native PipeWire PCM capture is not implemented in this helper yet", NULL);

    if (restore_value) {
        g_variant_unref(restore_value);
    }
    g_variant_unref(results);
    finish_start(app, 2);
}

static gboolean run_probe(void)
{
    Helper app = {0};
    app.mode = MODE_PROBE;
    app.probe_ok = load_portal_capabilities(&app);
    print_probe_json(&app);
    g_clear_object(&app.conn);
    return TRUE;
}

static gboolean run_grant(void)
{
    Helper app = {0};
    app.mode = MODE_GRANT;
    app.loop = g_main_loop_new(NULL, FALSE);

    if (!load_portal_capabilities(&app) || !app.supports_system_audio) {
        print_grant_json(FALSE, NULL, app.portal_version, "screen-cast",
                         app.probe_ok ? "unsupported" : "portal_unavailable");
        g_clear_object(&app.conn);
        g_main_loop_unref(app.loop);
        return TRUE;
    }

    app.create_token = make_token("create");
    app.select_token = make_token("select");
    app.start_token = make_token("start");
    app.create_request_path = make_request_path(app.conn, app.create_token);
    app.select_request_path = make_request_path(app.conn, app.select_token);
    app.start_request_path = make_request_path(app.conn, app.start_token);

    app.signal_id = subscribe_response(&app, app.create_request_path, on_create_session_response);

    GVariantBuilder opts;
    g_variant_builder_init(&opts, G_VARIANT_TYPE("a{sv}"));
    g_variant_builder_add(&opts, "{sv}", "handle_token", g_variant_new_string(app.create_token));
    g_variant_builder_add(&opts, "{sv}", "session_handle_token",
                          g_variant_new_string(app.create_token));

    GError *error = NULL;
    g_dbus_connection_call_sync(
        app.conn, PORTAL_BUS, PORTAL_PATH, SCREENCAST_IFACE, "CreateSession",
        g_variant_new("(a{sv})", g_variant_builder_end(&opts)),
        NULL, G_DBUS_CALL_FLAGS_NONE, -1, NULL, &error);

    if (error) {
        g_dbus_connection_signal_unsubscribe(app.conn, app.signal_id);
        print_grant_json(FALSE, NULL, app.portal_version, "screen-cast", error->message);
        g_error_free(error);
    } else {
        g_main_loop_run(app.loop);
    }

    g_clear_object(&app.conn);
    g_main_loop_unref(app.loop);
    g_free(app.restore_token);
    g_free(app.session_handle);
    g_free(app.create_token);
    g_free(app.select_token);
    g_free(app.start_token);
    g_free(app.create_request_path);
    g_free(app.select_request_path);
    g_free(app.start_request_path);
    return TRUE;
}

static gboolean run_start(const char *restore_token)
{
    Helper app = {0};
    app.mode = MODE_START;
    app.loop = g_main_loop_new(NULL, FALSE);
    app.restore_token = restore_token ? g_strdup(restore_token) : NULL;
    app.requested_restore_token = restore_token != NULL;

    if (!load_portal_capabilities(&app) || !app.supports_system_audio) {
        emit_event("error", "unsupported",
                   "Linux portal system audio capture is not available on this desktop", NULL);
        g_clear_object(&app.conn);
        g_main_loop_unref(app.loop);
        g_free(app.restore_token);
        return FALSE;
    }

    app.create_token = make_token("create");
    app.select_token = make_token("select");
    app.start_token = make_token("start");
    app.create_request_path = make_request_path(app.conn, app.create_token);
    app.select_request_path = make_request_path(app.conn, app.select_token);
    app.start_request_path = make_request_path(app.conn, app.start_token);

    app.signal_id = subscribe_response(&app, app.create_request_path, on_create_session_response);

    GVariantBuilder opts;
    g_variant_builder_init(&opts, G_VARIANT_TYPE("a{sv}"));
    g_variant_builder_add(&opts, "{sv}", "handle_token", g_variant_new_string(app.create_token));
    g_variant_builder_add(&opts, "{sv}", "session_handle_token",
                          g_variant_new_string(app.create_token));

    GError *error = NULL;
    g_dbus_connection_call_sync(
        app.conn, PORTAL_BUS, PORTAL_PATH, SCREENCAST_IFACE, "CreateSession",
        g_variant_new("(a{sv})", g_variant_builder_end(&opts)),
        NULL, G_DBUS_CALL_FLAGS_NONE, -1, NULL, &error);

    if (error) {
        g_dbus_connection_signal_unsubscribe(app.conn, app.signal_id);
        emit_event("error", "portal_error", error->message, NULL);
        g_error_free(error);
        app.exit_code = 2;
    } else {
        g_main_loop_run(app.loop);
    }

    g_clear_object(&app.conn);
    g_main_loop_unref(app.loop);
    g_free(app.restore_token);
    g_free(app.session_handle);
    g_free(app.create_token);
    g_free(app.select_token);
    g_free(app.start_token);
    g_free(app.create_request_path);
    g_free(app.select_request_path);
    g_free(app.start_request_path);
    return app.exit_code == 0;
}

static void print_usage(void)
{
    fprintf(stderr, "Usage: linux-system-audio-helper <probe|grant|start> [--restore-token TOKEN]\n");
}

int main(int argc, char *argv[])
{
    if (argc < 2) {
        print_usage();
        return 1;
    }

    if (strcmp(argv[1], "probe") == 0) {
        run_probe();
        return 0;
    }

    if (strcmp(argv[1], "grant") == 0) {
        run_grant();
        return 0;
    }

    if (strcmp(argv[1], "start") == 0) {
        const char *restore_token = NULL;
        for (int i = 2; i < argc; i++) {
            if (strcmp(argv[i], "--restore-token") == 0 && i + 1 < argc) {
                restore_token = argv[++i];
                continue;
            }
            print_usage();
            return 1;
        }

        return run_start(restore_token) ? 0 : 2;
    }

    print_usage();
    return 1;
}
