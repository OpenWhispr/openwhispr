#include <dirent.h>
#include <fcntl.h>
#include <linux/uinput.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <unistd.h>

/* Drives the Wayland (evdev) side of --await-modifier-release with uinput
 * keyboards, which the helper reads exactly like physical ones. */
static char command[1024];
static const char *helper;

typedef struct {
  int fd;
  char node[64];
  int created_node;
} keyboard_t;

static void require(int condition, const char *message)
{
  if (condition) return;
  fprintf(stderr, "%s\n", message);
  exit(1);
}

/* Without udev (containers), a new device's event node never appears under
 * /dev/input, so create it from sysfs when it is missing. */
static void ensure_event_node(keyboard_t *keyboard)
{
  char sysname[64];
  require(ioctl(keyboard->fd, UI_GET_SYSNAME(sizeof(sysname)), sysname) >= 0,
          "UI_GET_SYSNAME failed");
  char class_path[128];
  snprintf(class_path, sizeof(class_path), "/sys/class/input/%s", sysname);
  DIR *dir = opendir(class_path);
  require(dir != NULL, "cannot read the device's sysfs entry");
  char event[32] = "";
  struct dirent *ent;
  while ((ent = readdir(dir))) {
    if (strncmp(ent->d_name, "event", 5) == 0) {
      snprintf(event, sizeof(event), "%s", ent->d_name);
      break;
    }
  }
  closedir(dir);
  require(event[0] != '\0', "device has no event node");
  snprintf(keyboard->node, sizeof(keyboard->node), "/dev/input/%s", event);
  if (access(keyboard->node, F_OK) == 0) return;

  char dev_path[192];
  snprintf(dev_path, sizeof(dev_path), "%s/%s/dev", class_path, event);
  FILE *dev = fopen(dev_path, "r");
  require(dev != NULL, "cannot read the event node's device numbers");
  unsigned int major_number, minor_number;
  require(fscanf(dev, "%u:%u", &major_number, &minor_number) == 2, "malformed device numbers");
  fclose(dev);
  mkdir("/dev/input", 0755);
  require(mknod(keyboard->node, S_IFCHR | 0600, makedev(major_number, minor_number)) == 0,
          "cannot create the event node");
  keyboard->created_node = 1;
}

static keyboard_t create_keyboard(const char *name)
{
  keyboard_t keyboard = { .fd = open("/dev/uinput", O_WRONLY | O_NONBLOCK) };
  require(keyboard.fd >= 0, "cannot open /dev/uinput");
  ioctl(keyboard.fd, UI_SET_EVBIT, EV_KEY);
  ioctl(keyboard.fd, UI_SET_KEYBIT, KEY_A);
  ioctl(keyboard.fd, UI_SET_KEYBIT, KEY_LEFTCTRL);
  struct uinput_setup setup;
  memset(&setup, 0, sizeof(setup));
  setup.id.bustype = BUS_VIRTUAL;
  snprintf(setup.name, sizeof(setup.name), "%s", name);
  require(ioctl(keyboard.fd, UI_DEV_SETUP, &setup) == 0, "UI_DEV_SETUP failed");
  require(ioctl(keyboard.fd, UI_DEV_CREATE) == 0, "UI_DEV_CREATE failed");
  usleep(100000);
  ensure_event_node(&keyboard);
  return keyboard;
}

static void destroy_keyboard(keyboard_t *keyboard)
{
  ioctl(keyboard->fd, UI_DEV_DESTROY);
  close(keyboard->fd);
  if (keyboard->created_node) unlink(keyboard->node);
}

static void set_ctrl(const keyboard_t *keyboard, int pressed)
{
  struct input_event events[2];
  memset(events, 0, sizeof(events));
  events[0].type = EV_KEY;
  events[0].code = KEY_LEFTCTRL;
  events[0].value = pressed;
  events[1].type = EV_SYN;
  events[1].code = SYN_REPORT;
  require(write(keyboard->fd, events, sizeof(events)) == sizeof(events), "cannot write key event");
  usleep(50000);
}

static FILE *start_wait(int timeout_ms)
{
  snprintf(command, sizeof(command), "'%s' --capabilities --await-modifier-release %d",
           helper, timeout_ms);
  FILE *output = popen(command, "r");
  require(output != NULL, "cannot start helper");
  return output;
}

static void finish_wait(FILE *output, const char *expected_state, int min_waited_ms,
                        int max_waited_ms)
{
  char state[32];
  int waited_ms = -1;
  int fields = fscanf(output, "MODIFIERS %31s %d", state, &waited_ms);
  require(pclose(output) == 0, "helper exited with an error");
  require(fields == 2, "helper did not report a modifier state");
  if (strcmp(state, expected_state) != 0 || waited_ms < min_waited_ms ||
      waited_ms > max_waited_ms) {
    fprintf(stderr, "expected %s after %d-%dms, got %s after %dms\n", expected_state,
            min_waited_ms, max_waited_ms, state, waited_ms);
    exit(1);
  }
}

int main(int argc, char **argv)
{
  require(argc == 2, "usage: linuxModifierGateEvdev <linux-fast-paste>");
  helper = argv[1];

  keyboard_t keyboard = create_keyboard("Fixture Keyboard");
  set_ctrl(&keyboard, 1);
  finish_wait(start_wait(100), "held", 100, 1000);
  set_ctrl(&keyboard, 0);
  finish_wait(start_wait(1000), "released", 0, 0);

  /* ydotoold's virtual keyboard can keep a modifier down after an interrupted
   * chord. That is not the user's hand, so it must not hold every paste back. */
  keyboard_t ydotoold = create_keyboard("ydotoold virtual device");
  set_ctrl(&ydotoold, 1);
  finish_wait(start_wait(100), "released", 0, 0);

  destroy_keyboard(&ydotoold);
  destroy_keyboard(&keyboard);
  printf("evdev modifier gate native checks passed\n");
  return 0;
}
