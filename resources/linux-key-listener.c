/**
 * Linux Key Listener for Push-to-Talk
 *
 * Uses the evdev subsystem to detect key up/down events across all keyboards.
 * Accepts a hotkey string as command line argument (same format as Windows variant).
 * Outputs "KEY_DOWN" and "KEY_UP" to stdout.
 */

#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/input.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <sys/epoll.h>
#include <sys/inotify.h>
#include <sys/ioctl.h>
#include <unistd.h>

#define MAX_DEVICES    64
#define MAX_EVENTS     16
#define INPUT_DIR      "/dev/input"
#define KEY_BITS_SIZE  (KEY_MAX / 8 + 1)

static volatile sig_atomic_t running = 1;
static int hotkey_active = 0;

static int require_ctrl = 0;
static int require_alt = 0;
static int require_shift = 0;
static int require_super = 0;
static int use_modifiers_only = 0;
static int target_key = 0;

static unsigned char held_keys[KEY_BITS_SIZE];

static int device_fds[MAX_DEVICES];
static int device_count = 0;
static int permission_denied_count = 0;
static int epoll_fd = -1;

static void signal_handler(int sig) {
    (void)sig;
    running = 0;
}

static int is_key_held(int code) {
    return (held_keys[code / 8] >> (code % 8)) & 1;
}

static void set_key(int code, int pressed) {
    if (pressed)
        held_keys[code / 8] |= (1 << (code % 8));
    else
        held_keys[code / 8] &= ~(1 << (code % 8));
}

static int is_ctrl_held(void) {
    return is_key_held(KEY_LEFTCTRL) || is_key_held(KEY_RIGHTCTRL);
}

static int is_alt_held(void) {
    return is_key_held(KEY_LEFTALT) || is_key_held(KEY_RIGHTALT);
}

static int is_shift_held(void) {
    return is_key_held(KEY_LEFTSHIFT) || is_key_held(KEY_RIGHTSHIFT);
}

static int is_super_held(void) {
    return is_key_held(KEY_LEFTMETA) || is_key_held(KEY_RIGHTMETA);
}

static int modifiers_satisfied(void) {
    if (require_ctrl && !is_ctrl_held()) return 0;
    if (require_alt && !is_alt_held()) return 0;
    if (require_shift && !is_shift_held()) return 0;
    if (require_super && !is_super_held()) return 0;
    return 1;
}

static int is_modifier_code(int code) {
    return code == KEY_LEFTCTRL  || code == KEY_RIGHTCTRL  ||
           code == KEY_LEFTALT   || code == KEY_RIGHTALT   ||
           code == KEY_LEFTSHIFT || code == KEY_RIGHTSHIFT ||
           code == KEY_LEFTMETA  || code == KEY_RIGHTMETA;
}

static int is_required_modifier(int code) {
    if (require_ctrl && (code == KEY_LEFTCTRL || code == KEY_RIGHTCTRL)) return 1;
    if (require_alt && (code == KEY_LEFTALT || code == KEY_RIGHTALT)) return 1;
    if (require_shift && (code == KEY_LEFTSHIFT || code == KEY_RIGHTSHIFT)) return 1;
    if (require_super && (code == KEY_LEFTMETA || code == KEY_RIGHTMETA)) return 1;
    return 0;
}

static void emit_key_down(void) {
    if (!hotkey_active) {
        hotkey_active = 1;
        printf("KEY_DOWN\n");
        fflush(stdout);
    }
}

static void emit_key_up(void) {
    if (hotkey_active) {
        hotkey_active = 0;
        printf("KEY_UP\n");
        fflush(stdout);
    }
}

// BEGIN hotkey-parser
// Contract-tested: test/helpers/nativeListenerKeyVocabulary.test.js compiles
// exactly this block (BEGIN to END) with the host cc and runs every key name
// the Settings capture screen can emit through parse_hotkey_spec. Keep it
// self-contained: libc and the KEY_* codes from <linux/input-event-codes.h>
// only — no listener globals.
//
// The vocabulary must match CODE_TO_KEY in src/utils/hotkeyKeyNames.ts. A name
// missing here used to leave the key at 0 and be read as "modifiers only", so
// "Control+Alt+Up" silently became a bare Control+Alt listener that fired on
// the modifiers alone. An unknown name now refuses the whole spec instead.

struct hotkey_spec {
    int require_ctrl;
    int require_alt;
    int require_shift;
    int require_super;
    int modifiers_only;      /* modifiers named and no regular key (e.g. Control+Super) */
    int key;                 /* the regular key's KEY_* code; 0 when modifiers_only */
    char unknown_token[64];  /* the offending token when parse_hotkey_spec returns 0 */
};

struct key_name_entry {
    const char *name;
    int code;
};

/* Case-insensitive names. Single characters are handled in map_key_name. */
static const struct key_name_entry KEY_NAMES[] = {
    /* Function keys */
    {"F1", KEY_F1},   {"F2", KEY_F2},   {"F3", KEY_F3},   {"F4", KEY_F4},   {"F5", KEY_F5},
    {"F6", KEY_F6},   {"F7", KEY_F7},   {"F8", KEY_F8},   {"F9", KEY_F9},   {"F10", KEY_F10},
    {"F11", KEY_F11}, {"F12", KEY_F12}, {"F13", KEY_F13}, {"F14", KEY_F14}, {"F15", KEY_F15},
    {"F16", KEY_F16}, {"F17", KEY_F17}, {"F18", KEY_F18}, {"F19", KEY_F19}, {"F20", KEY_F20},
    {"F21", KEY_F21}, {"F22", KEY_F22}, {"F23", KEY_F23}, {"F24", KEY_F24},
    /* Whitespace, editing and navigation */
    {"Space", KEY_SPACE},
    {"Escape", KEY_ESC},        {"Esc", KEY_ESC},
    {"Tab", KEY_TAB},
    {"Enter", KEY_ENTER},       {"Return", KEY_ENTER},
    {"Backspace", KEY_BACKSPACE},
    {"Delete", KEY_DELETE},     {"Del", KEY_DELETE},
    {"Insert", KEY_INSERT},
    {"Home", KEY_HOME},         {"End", KEY_END},
    {"PageUp", KEY_PAGEUP},     {"PageDown", KEY_PAGEDOWN},
    {"Up", KEY_UP},             {"Down", KEY_DOWN},
    {"Left", KEY_LEFT},         {"Right", KEY_RIGHT},
    /* Lock and system keys */
    {"CapsLock", KEY_CAPSLOCK}, {"NumLock", KEY_NUMLOCK},
    {"ScrollLock", KEY_SCROLLLOCK}, {"Pause", KEY_PAUSE},
    {"PrintScreen", KEY_SYSRQ},
    /* Numpad — evdev reports the physical key regardless of NumLock */
    {"num0", KEY_KP0}, {"num1", KEY_KP1}, {"num2", KEY_KP2}, {"num3", KEY_KP3},
    {"num4", KEY_KP4}, {"num5", KEY_KP5}, {"num6", KEY_KP6}, {"num7", KEY_KP7},
    {"num8", KEY_KP8}, {"num9", KEY_KP9},
    {"numadd", KEY_KPPLUS}, {"numsub", KEY_KPMINUS}, {"nummult", KEY_KPASTERISK},
    {"numdiv", KEY_KPSLASH}, {"numdec", KEY_KPDOT},
    /* Media keys */
    {"MediaPlayPause", KEY_PLAYPAUSE}, {"MediaStop", KEY_STOPCD},
    {"MediaNextTrack", KEY_NEXTSONG}, {"MediaPreviousTrack", KEY_PREVIOUSSONG},
    /* Right-side modifiers bound on their own as single-key hotkeys */
    {"RightAlt", KEY_RIGHTALT},      {"RightOption", KEY_RIGHTALT},
    {"RightControl", KEY_RIGHTCTRL}, {"RightCtrl", KEY_RIGHTCTRL},
    {"RightShift", KEY_RIGHTSHIFT},
    {"RightSuper", KEY_RIGHTMETA}, {"RightWin", KEY_RIGHTMETA}, {"RightMeta", KEY_RIGHTMETA},
    {"RightCommand", KEY_RIGHTMETA}, {"RightCmd", KEY_RIGHTMETA},
    /* Named punctuation */
    {"Backquote", KEY_GRAVE}, {"Minus", KEY_MINUS}, {"Equal", KEY_EQUAL},
};

/* Map a key name to its KEY_* code; -1 when the name is unknown. */
static int map_key_name(const char *name) {
    size_t i;
    for (i = 0; i < sizeof(KEY_NAMES) / sizeof(KEY_NAMES[0]); i++) {
        if (strcasecmp(name, KEY_NAMES[i].name) == 0) return KEY_NAMES[i].code;
    }

    if (strlen(name) == 1) {
        char c = name[0];
        if (c >= 'a' && c <= 'z') c = c - 'a' + 'A';
        switch (c) {
        case 'A': return KEY_A; case 'B': return KEY_B; case 'C': return KEY_C;
        case 'D': return KEY_D; case 'E': return KEY_E; case 'F': return KEY_F;
        case 'G': return KEY_G; case 'H': return KEY_H; case 'I': return KEY_I;
        case 'J': return KEY_J; case 'K': return KEY_K; case 'L': return KEY_L;
        case 'M': return KEY_M; case 'N': return KEY_N; case 'O': return KEY_O;
        case 'P': return KEY_P; case 'Q': return KEY_Q; case 'R': return KEY_R;
        case 'S': return KEY_S; case 'T': return KEY_T; case 'U': return KEY_U;
        case 'V': return KEY_V; case 'W': return KEY_W; case 'X': return KEY_X;
        case 'Y': return KEY_Y; case 'Z': return KEY_Z;
        case '0': return KEY_0; case '1': return KEY_1; case '2': return KEY_2;
        case '3': return KEY_3; case '4': return KEY_4; case '5': return KEY_5;
        case '6': return KEY_6; case '7': return KEY_7; case '8': return KEY_8;
        case '9': return KEY_9;
        case '`': return KEY_GRAVE;  case '-': return KEY_MINUS;   case '=': return KEY_EQUAL;
        case '[': return KEY_LEFTBRACE;  case ']': return KEY_RIGHTBRACE;
        case '\\': return KEY_BACKSLASH; case ';': return KEY_SEMICOLON;
        case '\'': return KEY_APOSTROPHE; case ',': return KEY_COMMA;
        case '.': return KEY_DOT;    case '/': return KEY_SLASH;
        }
    }

    return -1;
}

/* Consume a modifier token into the spec; 0 when the token is not a modifier. */
static int parse_modifier_token(const char *token, struct hotkey_spec *spec) {
    if (strcasecmp(token, "CommandOrControl") == 0 || strcasecmp(token, "Control") == 0 ||
        strcasecmp(token, "Ctrl") == 0 || strcasecmp(token, "CmdOrCtrl") == 0) {
        spec->require_ctrl = 1;
    } else if (strcasecmp(token, "Alt") == 0 || strcasecmp(token, "Option") == 0) {
        spec->require_alt = 1;
    } else if (strcasecmp(token, "Shift") == 0) {
        spec->require_shift = 1;
    } else if (strcasecmp(token, "Super") == 0 || strcasecmp(token, "Meta") == 0 ||
               strcasecmp(token, "Win") == 0 || strcasecmp(token, "Command") == 0 ||
               strcasecmp(token, "Cmd") == 0) {
        spec->require_super = 1;
    } else {
        return 0;
    }
    return 1;
}

static void record_unknown_token(struct hotkey_spec *spec, const char *token) {
    strncpy(spec->unknown_token, token, sizeof(spec->unknown_token) - 1);
    spec->unknown_token[sizeof(spec->unknown_token) - 1] = '\0';
}

/* Parse a hotkey like "CommandOrControl+Shift+F11", "Control+Super" or "F8"
 * into `out`. Returns 0 — with `out->unknown_token` set when a token is the
 * cause — for an unknown key name, two regular keys, a dangling "+", or an
 * empty string. A failed parse never yields a modifiers-only spec. */
static int parse_hotkey_spec(const char *hotkey, struct hotkey_spec *out) {
    char buf[256];
    char *token;
    size_t len;

    memset(out, 0, sizeof(*out));
    if (hotkey == NULL) return 0;

    strncpy(buf, hotkey, sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = '\0';

    /* Trim the whole string, then refuse a leading or trailing "+": strtok
     * would drop the empty token and read "Control+Alt+" as modifiers-only. */
    len = strlen(buf);
    while (len > 0 && buf[len - 1] == ' ') buf[--len] = '\0';
    if (len == 0) return 0;
    if (buf[0] == '+' || buf[len - 1] == '+') return 0;

    token = strtok(buf, "+");
    while (token) {
        char *end;
        while (*token == ' ') token++;
        end = token + strlen(token) - 1;
        while (end > token && *end == ' ') *end-- = '\0';

        if (!parse_modifier_token(token, out)) {
            int code = map_key_name(token);
            if (code <= 0 || out->key != 0) {
                record_unknown_token(out, token);
                out->key = 0;
                return 0;
            }
            out->key = code;
        }

        token = strtok(NULL, "+");
    }

    if (out->key == 0) {
        if (!(out->require_ctrl || out->require_alt || out->require_shift || out->require_super))
            return 0;
        out->modifiers_only = 1;
    }
    return 1;
}
// END hotkey-parser

static int is_keyboard_device(int fd) {
    unsigned long ev_bits = 0;
    if (ioctl(fd, EVIOCGBIT(0, sizeof(ev_bits)), &ev_bits) < 0)
        return 0;
    if (!(ev_bits & (1UL << EV_KEY)))
        return 0;

    unsigned char key_bits[KEY_BITS_SIZE];
    memset(key_bits, 0, sizeof(key_bits));
    if (ioctl(fd, EVIOCGBIT(EV_KEY, sizeof(key_bits)), key_bits) < 0)
        return 0;

    return (key_bits[KEY_A / 8] >> (KEY_A % 8)) & 1;
}

static int add_device(const char *path) {
    if (device_count >= MAX_DEVICES)
        return -1;

    int fd = open(path, O_RDONLY | O_NONBLOCK);
    if (fd < 0) {
        if (errno == EACCES) {
            permission_denied_count++;
            fprintf(stderr, "Permission denied: %s\n", path);
        }
        return -1;
    }

    if (!is_keyboard_device(fd)) {
        close(fd);
        return -1;
    }

    struct epoll_event ev = { .events = EPOLLIN, .data.fd = fd };
    if (epoll_ctl(epoll_fd, EPOLL_CTL_ADD, fd, &ev) < 0) {
        close(fd);
        return -1;
    }

    device_fds[device_count++] = fd;

    char name[256] = "Unknown";
    ioctl(fd, EVIOCGNAME(sizeof(name)), name);
    fprintf(stderr, "Monitoring keyboard: %s (%s)\n", name, path);
    return fd;
}

static void remove_device(int fd) {
    epoll_ctl(epoll_fd, EPOLL_CTL_DEL, fd, NULL);
    close(fd);

    for (int i = 0; i < device_count; i++) {
        if (device_fds[i] == fd) {
            device_fds[i] = device_fds[--device_count];
            break;
        }
    }
}

static void scan_devices(void) {
    DIR *dir = opendir(INPUT_DIR);
    if (!dir) return;

    struct dirent *ent;
    while ((ent = readdir(dir))) {
        if (strncmp(ent->d_name, "event", 5) != 0)
            continue;

        char path[512];
        snprintf(path, sizeof(path), "%s/%s", INPUT_DIR, ent->d_name);

        int already_open = 0;
        for (int i = 0; i < device_count; i++) {
            char fd_path[64], real_path[512];
            snprintf(fd_path, sizeof(fd_path), "/proc/self/fd/%d", device_fds[i]);
            ssize_t len = readlink(fd_path, real_path, sizeof(real_path) - 1);
            if (len > 0) {
                real_path[len] = '\0';
                if (strcmp(real_path, path) == 0) {
                    already_open = 1;
                    break;
                }
            }
        }
        if (!already_open)
            add_device(path);
    }
    closedir(dir);
}

static void reset_held_keys(void) {
    memset(held_keys, 0, sizeof(held_keys));

    for (int i = 0; i < device_count; i++) {
        unsigned char keys[KEY_BITS_SIZE];
        memset(keys, 0, sizeof(keys));
        if (ioctl(device_fds[i], EVIOCGKEY(sizeof(keys)), keys) == 0) {
            for (int b = 0; b < KEY_BITS_SIZE; b++)
                held_keys[b] |= keys[b];
        }
    }
}

static void handle_key_event(int code, int value) {
    if (value == 2)
        return;

    int pressed = (value == 1);
    set_key(code, pressed);

    if (hotkey_active && !pressed && is_required_modifier(code) && !modifiers_satisfied()) {
        emit_key_up();
        return;
    }

    if (use_modifiers_only) {
        if (pressed && is_modifier_code(code) && modifiers_satisfied())
            emit_key_down();
        else if (!pressed && hotkey_active && !modifiers_satisfied())
            emit_key_up();
        return;
    }

    if (code == target_key) {
        if (pressed && !hotkey_active && modifiers_satisfied())
            emit_key_down();
        else if (!pressed && hotkey_active)
            emit_key_up();
    }
}

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <key>\n", argv[0]);
        fprintf(stderr, "Examples:\n");
        fprintf(stderr, "  %s `                        (backtick)\n", argv[0]);
        fprintf(stderr, "  %s F8                       (function key)\n", argv[0]);
        fprintf(stderr, "  %s CommandOrControl+F11     (with modifier)\n", argv[0]);
        fprintf(stderr, "  %s Ctrl+Shift+Space         (multiple modifiers)\n", argv[0]);
        fprintf(stderr, "  %s Control+Super             (modifier-only combo)\n", argv[0]);
        return 1;
    }

    struct hotkey_spec spec;
    if (!parse_hotkey_spec(argv[1], &spec)) {
        if (spec.unknown_token[0] != '\0')
            fprintf(stderr, "Error: unrecognized key '%s' in hotkey '%s'\n", spec.unknown_token, argv[1]);
        else
            fprintf(stderr, "Error: invalid hotkey '%s'\n", argv[1]);
        return 1;
    }
    target_key = spec.key;
    require_ctrl = spec.require_ctrl;
    require_alt = spec.require_alt;
    require_shift = spec.require_shift;
    require_super = spec.require_super;
    use_modifiers_only = spec.modifiers_only;

    fprintf(stderr, "Listening for: %s (code=%d, ctrl=%d, alt=%d, shift=%d, super=%d, mod_only=%d)\n",
            argv[1], target_key, require_ctrl, require_alt, require_shift, require_super, use_modifiers_only);

    struct sigaction sa = { .sa_handler = signal_handler, .sa_flags = 0 };
    sigemptyset(&sa.sa_mask);
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);
    signal(SIGPIPE, SIG_IGN);

    epoll_fd = epoll_create1(0);
    if (epoll_fd < 0) {
        fprintf(stderr, "Error: epoll_create1 failed: %s\n", strerror(errno));
        return 1;
    }

    int inotify_fd = inotify_init1(IN_NONBLOCK);
    if (inotify_fd < 0) {
        fprintf(stderr, "Warning: inotify_init1 failed, hotplug detection disabled\n");
    } else {
        inotify_add_watch(inotify_fd, INPUT_DIR, IN_CREATE | IN_DELETE);
        struct epoll_event ev = { .events = EPOLLIN, .data.fd = inotify_fd };
        epoll_ctl(epoll_fd, EPOLL_CTL_ADD, inotify_fd, &ev);
    }

    scan_devices();

    if (device_count == 0 && permission_denied_count > 0) {
        printf("NO_PERMISSION\n");
        fflush(stdout);
    } else if (device_count == 0) {
        fprintf(stderr, "Warning: no keyboard devices found, waiting for hotplug\n");
    }

    printf("READY\n");
    fflush(stdout);

    struct epoll_event events[MAX_EVENTS];

    while (running) {
        int nfds = epoll_wait(epoll_fd, events, MAX_EVENTS, 500);
        if (nfds < 0) {
            if (errno == EINTR) continue;
            break;
        }

        for (int i = 0; i < nfds; i++) {
            int fd = events[i].data.fd;

            if (fd == inotify_fd) {
                char inbuf[4096] __attribute__((aligned(__alignof__(struct inotify_event))));
                ssize_t len = read(inotify_fd, inbuf, sizeof(inbuf));
                if (len > 0)
                    scan_devices();
                continue;
            }

            struct input_event ev;
            while (1) {
                ssize_t n = read(fd, &ev, sizeof(ev));
                if (n < 0) {
                    if (errno == EAGAIN)
                        break;
                    if (errno == ENODEV) {
                        remove_device(fd);
                        reset_held_keys();
                        if (!modifiers_satisfied())
                            emit_key_up();
                    }
                    break;
                }
                if (n < (ssize_t)sizeof(ev))
                    break;

                if (ev.type == EV_SYN && ev.code == SYN_DROPPED) {
                    reset_held_keys();
                    if (hotkey_active && !modifiers_satisfied())
                        emit_key_up();
                    continue;
                }

                if (ev.type == EV_KEY)
                    handle_key_event(ev.code, ev.value);
            }
        }
    }

    emit_key_up();

    for (int i = 0; i < device_count; i++)
        close(device_fds[i]);
    if (inotify_fd >= 0)
        close(inotify_fd);
    close(epoll_fd);

    return 0;
}
