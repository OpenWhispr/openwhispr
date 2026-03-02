#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/Xutil.h>
#include <X11/extensions/XTest.h>
#include <X11/keysym.h>
#include <unistd.h>

#ifdef HAVE_UINPUT
#include <linux/uinput.h>
#include <linux/input.h>
#include <fcntl.h>
#include <errno.h>
#endif

#ifdef HAVE_GIO
#include <gio/gio.h>

#define PORTAL_BUS   "org.freedesktop.portal.Desktop"
#define PORTAL_PATH  "/org/freedesktop/portal/desktop"
#define PORTAL_IFACE "org.freedesktop.portal.RemoteDesktop"
#define REQUEST_IFACE "org.freedesktop.portal.Request"

/* evdev keycodes for portal mode */
#define PORTAL_KEY_LEFTCTRL  29
#define PORTAL_KEY_LEFTSHIFT 42
#define PORTAL_KEY_V         47

static int portal_exit_code = 0;

typedef struct {
    GDBusConnection *conn;
    GMainLoop       *loop;
    char            *session_handle;
    char            *restore_token;
    guint            signal_id;
    int              use_shift;
} PortalData;

static char *get_sender_path(GDBusConnection *conn)
{
    const char *name = g_dbus_connection_get_unique_name(conn);
    char *path = g_strdup(name + 1);
    for (char *p = path; *p; p++) {
        if (*p == '.') *p = '_';
    }
    return path;
}

static guint subscribe_response(PortalData *app, const char *request_path,
                                GDBusSignalCallback callback)
{
    return g_dbus_connection_signal_subscribe(
        app->conn, PORTAL_BUS, REQUEST_IFACE, "Response",
        request_path, NULL, G_DBUS_SIGNAL_FLAGS_NO_MATCH_RULE,
        callback, app, NULL);
}

static void portal_send_paste(PortalData *app)
{
    GError *err = NULL;
    GVariant *opts;

    opts = g_variant_new("a{sv}", NULL);
    g_dbus_connection_call_sync(app->conn, PORTAL_BUS, PORTAL_PATH,
        PORTAL_IFACE, "NotifyKeyboardKeycode",
        g_variant_new("(o@a{sv}iu)", app->session_handle, opts,
                       (gint32)PORTAL_KEY_LEFTCTRL, (guint32)1),
        NULL, G_DBUS_CALL_FLAGS_NONE, -1, NULL, &err);
    if (err) { fprintf(stderr, "Ctrl press: %s\n", err->message); g_clear_error(&err); }

    if (app->use_shift) {
        opts = g_variant_new("a{sv}", NULL);
        g_dbus_connection_call_sync(app->conn, PORTAL_BUS, PORTAL_PATH,
            PORTAL_IFACE, "NotifyKeyboardKeycode",
            g_variant_new("(o@a{sv}iu)", app->session_handle, opts,
                           (gint32)PORTAL_KEY_LEFTSHIFT, (guint32)1),
            NULL, G_DBUS_CALL_FLAGS_NONE, -1, NULL, &err);
        if (err) { fprintf(stderr, "Shift press: %s\n", err->message); g_clear_error(&err); }
    }

    opts = g_variant_new("a{sv}", NULL);
    g_dbus_connection_call_sync(app->conn, PORTAL_BUS, PORTAL_PATH,
        PORTAL_IFACE, "NotifyKeyboardKeycode",
        g_variant_new("(o@a{sv}iu)", app->session_handle, opts,
                       (gint32)PORTAL_KEY_V, (guint32)1),
        NULL, G_DBUS_CALL_FLAGS_NONE, -1, NULL, &err);
    if (err) { fprintf(stderr, "V press: %s\n", err->message); g_clear_error(&err); }

    usleep(20000);

    opts = g_variant_new("a{sv}", NULL);
    g_dbus_connection_call_sync(app->conn, PORTAL_BUS, PORTAL_PATH,
        PORTAL_IFACE, "NotifyKeyboardKeycode",
        g_variant_new("(o@a{sv}iu)", app->session_handle, opts,
                       (gint32)PORTAL_KEY_V, (guint32)0),
        NULL, G_DBUS_CALL_FLAGS_NONE, -1, NULL, &err);
    if (err) { fprintf(stderr, "V release: %s\n", err->message); g_clear_error(&err); }

    if (app->use_shift) {
        opts = g_variant_new("a{sv}", NULL);
        g_dbus_connection_call_sync(app->conn, PORTAL_BUS, PORTAL_PATH,
            PORTAL_IFACE, "NotifyKeyboardKeycode",
            g_variant_new("(o@a{sv}iu)", app->session_handle, opts,
                           (gint32)PORTAL_KEY_LEFTSHIFT, (guint32)0),
            NULL, G_DBUS_CALL_FLAGS_NONE, -1, NULL, &err);
        if (err) { fprintf(stderr, "Shift release: %s\n", err->message); g_clear_error(&err); }
    }

    opts = g_variant_new("a{sv}", NULL);
    g_dbus_connection_call_sync(app->conn, PORTAL_BUS, PORTAL_PATH,
        PORTAL_IFACE, "NotifyKeyboardKeycode",
        g_variant_new("(o@a{sv}iu)", app->session_handle, opts,
                       (gint32)PORTAL_KEY_LEFTCTRL, (guint32)0),
        NULL, G_DBUS_CALL_FLAGS_NONE, -1, NULL, &err);
    if (err) { fprintf(stderr, "Ctrl release: %s\n", err->message); g_clear_error(&err); }

    g_main_loop_quit(app->loop);
}

static void on_start_response(GDBusConnection *conn, const char *sender,
    const char *object_path, const char *interface_name,
    const char *signal_name, GVariant *parameters, gpointer user_data)
{
    PortalData *app = user_data;
    guint32 response;
    GVariant *results;

    g_variant_get(parameters, "(u@a{sv})", &response, &results);
    g_dbus_connection_signal_unsubscribe(app->conn, app->signal_id);

    if (response != 0) {
        fprintf(stderr, "Start cancelled (response=%u)\n", response);
        portal_exit_code = 3;
        g_variant_unref(results);
        g_main_loop_quit(app->loop);
        return;
    }

    GVariant *token_v = g_variant_lookup_value(results, "restore_token",
                                                G_VARIANT_TYPE_STRING);
    if (token_v) {
        const char *token = g_variant_get_string(token_v, NULL);
        printf("%s\n", token);
        fflush(stdout);
        g_variant_unref(token_v);
    }

    g_variant_unref(results);
    portal_send_paste(app);
}

static void on_select_devices_response(GDBusConnection *conn, const char *sender,
    const char *object_path, const char *interface_name,
    const char *signal_name, GVariant *parameters, gpointer user_data)
{
    PortalData *app = user_data;
    guint32 response;
    GVariant *results;

    g_variant_get(parameters, "(u@a{sv})", &response, &results);
    g_dbus_connection_signal_unsubscribe(app->conn, app->signal_id);
    g_variant_unref(results);

    if (response != 0) {
        fprintf(stderr, "SelectDevices denied (response=%u)\n", response);
        portal_exit_code = 2;
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
        portal_exit_code = 1;
        g_main_loop_quit(app->loop);
    }
}

static void on_create_session_response(GDBusConnection *conn, const char *sender,
    const char *object_path, const char *interface_name,
    const char *signal_name, GVariant *parameters, gpointer user_data)
{
    PortalData *app = user_data;
    guint32 response;
    GVariant *results;

    g_variant_get(parameters, "(u@a{sv})", &response, &results);
    g_dbus_connection_signal_unsubscribe(app->conn, app->signal_id);

    if (response != 0) {
        fprintf(stderr, "CreateSession denied (response=%u)\n", response);
        portal_exit_code = 2;
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
        portal_exit_code = 1;
        g_main_loop_quit(app->loop);
    }
}

static gboolean on_portal_timeout(gpointer user_data)
{
    PortalData *app = user_data;
    fprintf(stderr, "Timeout waiting for portal response\n");
    portal_exit_code = 1;
    g_main_loop_quit(app->loop);
    return G_SOURCE_REMOVE;
}

static int paste_via_portal(int use_shift, const char *restore_token)
{
    PortalData app = { 0 };
    app.use_shift = use_shift;
    if (restore_token) app.restore_token = g_strdup(restore_token);

    GError *err = NULL;
    app.conn = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &err);
    if (!app.conn) {
        fprintf(stderr, "D-Bus connection failed: %s\n", err->message);
        g_error_free(err);
        g_free(app.restore_token);
        return 1;
    }

    app.loop = g_main_loop_new(NULL, FALSE);
    g_timeout_add_seconds(10, on_portal_timeout, &app);

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
        g_main_loop_unref(app.loop);
        g_free(app.restore_token);
        g_object_unref(app.conn);
        return 1;
    }

    g_main_loop_run(app.loop);

    g_main_loop_unref(app.loop);
    g_free(app.session_handle);
    g_free(app.restore_token);
    g_object_unref(app.conn);

    return portal_exit_code;
}
#endif /* HAVE_GIO */

static const char *terminal_classes[] = {
    "konsole", "gnome-terminal", "terminal", "kitty", "alacritty",
    "terminator", "xterm", "urxvt", "rxvt", "tilix", "terminology",
    "wezterm", "foot", "st", "yakuake", "ghostty", "guake", "tilda",
    "hyper", "tabby", "sakura", "warp", "termius", NULL
};

static int is_terminal(const char *wm_class) {
    if (!wm_class) return 0;
    for (int i = 0; terminal_classes[i]; i++) {
        if (strcasestr(wm_class, terminal_classes[i]))
            return 1;
    }
    return 0;
}

static Window get_active_window(Display *dpy) {
    Atom prop = XInternAtom(dpy, "_NET_ACTIVE_WINDOW", True);
    if (prop != None) {
        Atom actual_type;
        int actual_format;
        unsigned long nitems, bytes_after;
        unsigned char *data = NULL;

        if (XGetWindowProperty(dpy, DefaultRootWindow(dpy), prop, 0, 1, False,
                               XA_WINDOW, &actual_type, &actual_format,
                               &nitems, &bytes_after, &data) == Success && data) {
            Window win = nitems > 0 ? *(Window *)data : None;
            XFree(data);
            if (win != None) return win;
        }
    }

    Window focused;
    int revert;
    XGetInputFocus(dpy, &focused, &revert);
    return focused;
}

static void activate_window(Display *dpy, Window win) {
    Atom net_active = XInternAtom(dpy, "_NET_ACTIVE_WINDOW", False);
    XEvent ev;
    memset(&ev, 0, sizeof(ev));
    ev.xclient.type         = ClientMessage;
    ev.xclient.window       = win;
    ev.xclient.message_type = net_active;
    ev.xclient.format       = 32;
    ev.xclient.data.l[0]    = 2; /* source: pager */
    ev.xclient.data.l[1]    = CurrentTime;
    ev.xclient.data.l[2]    = 0;

    XSendEvent(dpy, DefaultRootWindow(dpy), False,
               SubstructureNotifyMask | SubstructureRedirectMask, &ev);
    XFlush(dpy);

    usleep(50000);

    XSetInputFocus(dpy, win, RevertToParent, CurrentTime);
    XFlush(dpy);
    usleep(20000);
}

#ifdef HAVE_UINPUT
static void emit(int fd, int type, int code, int val) {
    struct input_event ie;
    memset(&ie, 0, sizeof(ie));
    ie.type = type;
    ie.code = code;
    ie.value = val;
    if (write(fd, &ie, sizeof(ie)) < 0) {
        /* best-effort */
    }
}

static int paste_via_uinput(int use_shift) {
    int fd = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
    if (fd < 0) {
        fprintf(stderr, "Cannot open /dev/uinput: %s\n", strerror(errno));
        return 3;
    }

    if (ioctl(fd, UI_SET_EVBIT, EV_KEY) < 0 ||
        ioctl(fd, UI_SET_KEYBIT, KEY_LEFTCTRL) < 0 ||
        ioctl(fd, UI_SET_KEYBIT, KEY_LEFTSHIFT) < 0 ||
        ioctl(fd, UI_SET_KEYBIT, KEY_V) < 0) {
        close(fd);
        return 4;
    }

    struct uinput_setup usetup;
    memset(&usetup, 0, sizeof(usetup));
    usetup.id.bustype = BUS_USB;
    usetup.id.vendor  = 0x1234;
    usetup.id.product = 0x5678;
    snprintf(usetup.name, UINPUT_MAX_NAME_SIZE, "openwhispr-paste");

    if (ioctl(fd, UI_DEV_SETUP, &usetup) < 0 ||
        ioctl(fd, UI_DEV_CREATE) < 0) {
        close(fd);
        return 4;
    }

    usleep(50000);

    emit(fd, EV_KEY, KEY_LEFTCTRL, 1);
    emit(fd, EV_SYN, SYN_REPORT, 0);

    if (use_shift) {
        emit(fd, EV_KEY, KEY_LEFTSHIFT, 1);
        emit(fd, EV_SYN, SYN_REPORT, 0);
    }

    usleep(8000);

    emit(fd, EV_KEY, KEY_V, 1);
    emit(fd, EV_SYN, SYN_REPORT, 0);
    usleep(8000);

    emit(fd, EV_KEY, KEY_V, 0);
    emit(fd, EV_SYN, SYN_REPORT, 0);

    usleep(8000);

    if (use_shift) {
        emit(fd, EV_KEY, KEY_LEFTSHIFT, 0);
        emit(fd, EV_SYN, SYN_REPORT, 0);
    }

    emit(fd, EV_KEY, KEY_LEFTCTRL, 0);
    emit(fd, EV_SYN, SYN_REPORT, 0);

    usleep(20000);

    ioctl(fd, UI_DEV_DESTROY);
    close(fd);
    return 0;
}
#endif

int main(int argc, char *argv[]) {
    int force_terminal = 0;
    int use_uinput = 0;
    int use_portal = 0;
    const char *restore_token = NULL;
    Window target_window = None;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--terminal") == 0) {
            force_terminal = 1;
        } else if (strcmp(argv[i], "--uinput") == 0) {
            use_uinput = 1;
        } else if (strcmp(argv[i], "--portal") == 0) {
            use_portal = 1;
        } else if (strcmp(argv[i], "--restore-token") == 0 && i + 1 < argc) {
            restore_token = argv[++i];
        } else if (strcmp(argv[i], "--window") == 0 && i + 1 < argc) {
            target_window = (Window)strtoul(argv[++i], NULL, 0);
        }
    }

    if (use_portal) {
#ifdef HAVE_GIO
        return paste_via_portal(force_terminal, restore_token);
#else
        fprintf(stderr, "portal support not compiled in\n");
        return 5;
#endif
    }

    if (use_uinput) {
#ifdef HAVE_UINPUT
        return paste_via_uinput(force_terminal);
#else
        fprintf(stderr, "uinput support not compiled in\n");
        return 3;
#endif
    }

    Display *dpy = XOpenDisplay(NULL);
    if (!dpy) return 1;

    int event_base, error_base, major, minor;
    if (!XTestQueryExtension(dpy, &event_base, &error_base, &major, &minor)) {
        XCloseDisplay(dpy);
        return 2;
    }

    if (target_window != None) {
        activate_window(dpy, target_window);
    }

    Window win = (target_window != None) ? target_window : get_active_window(dpy);

    int use_shift = force_terminal;
    if (!use_shift && win != None) {
        XClassHint hint;
        if (XGetClassHint(dpy, win, &hint)) {
            use_shift = is_terminal(hint.res_class) || is_terminal(hint.res_name);
            XFree(hint.res_name);
            XFree(hint.res_class);
        }
    }

    KeyCode ctrl = XKeysymToKeycode(dpy, XK_Control_L);
    KeyCode shift = XKeysymToKeycode(dpy, XK_Shift_L);
    KeyCode v = XKeysymToKeycode(dpy, XK_v);

    XTestFakeKeyEvent(dpy, ctrl, True, CurrentTime);
    if (use_shift)
        XTestFakeKeyEvent(dpy, shift, True, CurrentTime);
    usleep(8000);

    XTestFakeKeyEvent(dpy, v, True, CurrentTime);
    usleep(8000);
    XTestFakeKeyEvent(dpy, v, False, CurrentTime);

    usleep(8000);
    if (use_shift)
        XTestFakeKeyEvent(dpy, shift, False, CurrentTime);
    XTestFakeKeyEvent(dpy, ctrl, False, CurrentTime);

    XFlush(dpy);
    usleep(20000);
    XCloseDisplay(dpy);
    return 0;
}
