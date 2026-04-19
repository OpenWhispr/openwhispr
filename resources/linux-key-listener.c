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

static int map_key_name(const char *name) {
    if (strcasecmp(name, "F1") == 0) return KEY_F1;
    if (strcasecmp(name, "F2") == 0) return KEY_F2;
    if (strcasecmp(name, "F3") == 0) return KEY_F3;
    if (strcasecmp(name, "F4") == 0) return KEY_F4;
    if (strcasecmp(name, "F5") == 0) return KEY_F5;
    if (strcasecmp(name, "F6") == 0) return KEY_F6;
    if (strcasecmp(name, "F7") == 0) return KEY_F7;
    if (strcasecmp(name, "F8") == 0) return KEY_F8;
    if (strcasecmp(name, "F9") == 0) return KEY_F9;
    if (strcasecmp(name, "F10") == 0) return KEY_F10;
    if (strcasecmp(name, "F11") == 0) return KEY_F11;
    if (strcasecmp(name, "F12") == 0) return KEY_F12;

    if (strcasecmp(name, "F13") == 0) return KEY_F13;
    if (strcasecmp(name, "F14") == 0) return KEY_F14;
    if (strcasecmp(name, "F15") == 0) return KEY_F15;
    if (strcasecmp(name, "F16") == 0) return KEY_F16;
    if (strcasecmp(name, "F17") == 0) return KEY_F17;
    if (strcasecmp(name, "F18") == 0) return KEY_F18;
    if (strcasecmp(name, "F19") == 0) return KEY_F19;
    if (strcasecmp(name, "F20") == 0) return KEY_F20;
    if (strcasecmp(name, "F21") == 0) return KEY_F21;
    if (strcasecmp(name, "F22") == 0) return KEY_F22;
    if (strcasecmp(name, "F23") == 0) return KEY_F23;
    if (strcasecmp(name, "F24") == 0) return KEY_F24;

    if (strcasecmp(name, "Space") == 0) return KEY_SPACE;
    if (strcasecmp(name, "Escape") == 0 || strcasecmp(name, "Esc") == 0) return KEY_ESC;
    if (strcasecmp(name, "Tab") == 0) return KEY_TAB;
    if (strcasecmp(name, "Pause") == 0) return KEY_PAUSE;
    if (strcasecmp(name, "ScrollLock") == 0) return KEY_SCROLLLOCK;
    if (strcasecmp(name, "Insert") == 0) return KEY_INSERT;
    if (strcasecmp(name, "Home") == 0) return KEY_HOME;
    if (strcasecmp(name, "End") == 0) return KEY_END;
    if (strcasecmp(name, "PageUp") == 0) return KEY_PAGEUP;
    if (strcasecmp(name, "PageDown") == 0) return KEY_PAGEDOWN;

    if (strcmp(name, "`") == 0 || strcasecmp(name, "Backquote") == 0) return KEY_GRAVE;

    if (strcasecmp(name, "RightAlt") == 0 || strcasecmp(name, "RightOption") == 0) return KEY_RIGHTALT;
    if (strcasecmp(name, "RightControl") == 0 || strcasecmp(name, "RightCtrl") == 0) return KEY_RIGHTCTRL;
    if (strcasecmp(name, "RightShift") == 0) return KEY_RIGHTSHIFT;
    if (strcasecmp(name, "RightSuper") == 0 || strcasecmp(name, "RightWin") == 0 ||
        strcasecmp(name, "RightMeta") == 0 || strcasecmp(name, "RightCommand") == 0 ||
        strcasecmp(name, "RightCmd") == 0) return KEY_RIGHTMETA;

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
        case '-': return KEY_MINUS;   case '=': return KEY_EQUAL;
        case '[': return KEY_LEFTBRACE;  case ']': return KEY_RIGHTBRACE;
        case '\\': return KEY_BACKSLASH; case ';': return KEY_SEMICOLON;
        case '\'': return KEY_APOSTROPHE; case ',': return KEY_COMMA;
        case '.': return KEY_DOT;    case '/': return KEY_SLASH;
        }
    }

    return -1;
}

static void parse_hotkey(const char *hotkey) {
    char buf[256];
    strncpy(buf, hotkey, sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = '\0';

    require_ctrl = 0;
    require_alt = 0;
    require_shift = 0;
    require_super = 0;
    use_modifiers_only = 0;
    target_key = 0;

    char *token = strtok(buf, "+");
    while (token) {
        while (*token == ' ') token++;
        char *end = token + strlen(token) - 1;
        while (end > token && *end == ' ') *end-- = '\0';

        if (strcasecmp(token, "CommandOrControl") == 0 ||
            strcasecmp(token, "Control") == 0 ||
            strcasecmp(token, "Ctrl") == 0 ||
            strcasecmp(token, "CmdOrCtrl") == 0) {
            require_ctrl = 1;
        } else if (strcasecmp(token, "Alt") == 0 ||
                   strcasecmp(token, "Option") == 0) {
            require_alt = 1;
        } else if (strcasecmp(token, "Shift") == 0) {
            require_shift = 1;
        } else if (strcasecmp(token, "Super") == 0 ||
                   strcasecmp(token, "Meta") == 0 ||
                   strcasecmp(token, "Win") == 0 ||
                   strcasecmp(token, "Command") == 0 ||
                   strcasecmp(token, "Cmd") == 0) {
            require_super = 1;
        } else {
            int code = map_key_name(token);
            if (code >= 0)
                target_key = code;
        }

        token = strtok(NULL, "+");
    }

    if (target_key == 0 && (require_ctrl || require_alt || require_shift || require_super))
        use_modifiers_only = 1;
}

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

    parse_hotkey(argv[1]);

    if (target_key == 0 && !use_modifiers_only) {
        fprintf(stderr, "Error: unrecognized key in '%s'\n", argv[1]);
        return 1;
    }

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
