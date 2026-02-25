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

/* Send _NET_ACTIVE_WINDOW client message then fall back to XSetInputFocus */
static void activate_window(Display *dpy, Window win) {
    Atom net_active = XInternAtom(dpy, "_NET_ACTIVE_WINDOW", False);
    XEvent ev;
    memset(&ev, 0, sizeof(ev));
    ev.xclient.type         = ClientMessage;
    ev.xclient.window       = win;
    ev.xclient.message_type = net_active;
    ev.xclient.format       = 32;
    ev.xclient.data.l[0]    = 2; /* source: pager / direct call */
    ev.xclient.data.l[1]    = CurrentTime;
    ev.xclient.data.l[2]    = 0;

    XSendEvent(dpy, DefaultRootWindow(dpy), False,
               SubstructureNotifyMask | SubstructureRedirectMask, &ev);
    XFlush(dpy);

    /* Give the WM time to process the activation request */
    usleep(50000);

    /* Fallback: also set X input focus directly */
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
        /* best-effort: logged by caller via exit code */
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

    /* Let the kernel register the virtual device */
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
    Window target_window = None;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--terminal") == 0) {
            force_terminal = 1;
        } else if (strcmp(argv[i], "--uinput") == 0) {
            use_uinput = 1;
        } else if (strcmp(argv[i], "--window") == 0 && i + 1 < argc) {
            target_window = (Window)strtoul(argv[++i], NULL, 0);
        }
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
